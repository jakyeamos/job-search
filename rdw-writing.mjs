// @ts-check

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RDW_ARTIFACT_REQUEST_SCHEMA = 'rdw-artifact-request/v1';
export const RDW_ARTIFACT_RECEIPT_SCHEMA = 'rdw-artifact-receipt/v1';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** @param {unknown} value */
function text(value) { return typeof value === 'string' ? value.trim() : ''; }

/** @param {string} value */
function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'career-artifact';
}

/** @param {unknown} value */
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

/** @param {unknown} value */
function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

/** @param {Record<string, unknown>} contact */
function recipientRole(contact) {
  const value = `${text(contact.type)} ${text(contact.title)}`.toLowerCase();
  if (/recruit|talent|sourc/.test(value)) return 'recruiter';
  if (/manager|director|head|lead|founder|vp|chief/.test(value)) return 'hiring_manager';
  if (/interview/.test(value)) return 'interviewer';
  return 'peer';
}

/**
 * Build the provider-neutral request consumed by `rdw validate-artifact`.
 * @param {{
 *   profile: Record<string, unknown>,
 *   item: Record<string, unknown>,
 *   contact: Record<string, unknown>,
 *   subject: string,
 *   body: string,
 *   relevance: string,
 *   proof: string,
 *   kind?: 'initial'|'followup'
 * }} input
 */
export function buildOutreachArtifactRequest(input) {
  const kind = input.kind || 'initial';
  const company = text(input.item.company) || 'unknown-company';
  const title = text(input.item.title) || 'unknown-role';
  const contactName = text(input.contact.name) || 'unknown-recipient';
  const artifactType = kind === 'followup' ? 'outreach_followup_email' : 'outreach_email';
  const evidence = [{
    id: 'recipient-relevance',
    kind: 'recipient_relevance',
    text: input.relevance,
    source: text(input.contact.sourceUrl)
      || text(input.item.canonicalUrl)
      || text(input.item.applyUrl)
      || 'career-ops verified role/contact evidence',
  }];
  const claimBindings = [];
  if (kind === 'initial') {
    evidence.push({
      id: 'candidate-proof',
      kind: 'candidate_proof',
      text: input.proof,
      source: 'career-ops candidate profile and accomplishment ledger',
    });
    claimBindings.push({ claim: input.proof, evidence_ids: ['candidate-proof'] });
  }
  return {
    schema_version: RDW_ARTIFACT_REQUEST_SCHEMA,
    artifact_id: slug(`${company}-${title}-${contactName}-${kind}`),
    artifact_type: artifactType,
    channel: 'email',
    intent: kind === 'followup' ? 'continue_conversation' : 'start_conversation',
    audience: {
      recipient_role: recipientRole(input.contact),
      relationship: input.contact.connection === true ? 'warm' : 'cold',
    },
    content: { subject: input.subject, body: input.body },
    evidence,
    claim_bindings: claimBindings,
    constraints: {
      human_approval_required: true,
      max_words: kind === 'followup' ? 80 : 120,
    },
  };
}

/**
 * Resolve RDW without hard-coding it as an npm dependency. An explicit root wins,
 * then the normal sibling checkout, then an installed `rdw` executable.
 * @param {{ env?: NodeJS.ProcessEnv, rdwRoot?: string }} [options]
 */
export function resolveRdwInvocation(options = {}) {
  const env = options.env || process.env;
  const roots = [options.rdwRoot, env.RDW_ROOT, path.resolve(MODULE_DIR, '..', 'research-domain-writing')]
    .map(text)
    .filter(Boolean);
  const root = roots.find((candidate) => existsSync(path.join(candidate, 'pyproject.toml')));
  if (root) {
    const checkoutExecutable = path.join(root, '.venv', 'bin', 'rdw');
    if (existsSync(checkoutExecutable)) {
      return {
        command: checkoutExecutable,
        args: ['validate-artifact', '-', '--root', root, '--json'],
        root,
        mode: 'source-venv',
      };
    }
    return {
      command: 'uv',
      args: ['--directory', root, 'run', 'rdw', 'validate-artifact', '-', '--root', root, '--json'],
      root,
      mode: 'source-checkout',
    };
  }
  return {
    command: text(env.RDW_EXECUTABLE) || 'rdw',
    args: ['validate-artifact', '-', '--root', MODULE_DIR, '--json'],
    root: null,
    mode: 'installed',
  };
}

/**
 * @param {Record<string, unknown>} request
 * @param {{ env?: NodeJS.ProcessEnv, rdwRoot?: string, spawnSyncFn?: typeof spawnSync }} [options]
 */
export function runRdwArtifactCheck(request, options = {}) {
  const invocation = resolveRdwInvocation(options);
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const result = spawnSyncFn(invocation.command, invocation.args, {
    cwd: invocation.root || MODULE_DIR,
    env: { ...(options.env || process.env), UV_NO_CACHE: '1' },
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`RDW artifact validation unavailable: ${result.error.message}`);
  let receipt;
  try {
    receipt = JSON.parse(String(result.stdout || ''));
  } catch {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`RDW artifact validation returned no receipt${detail ? `: ${detail}` : ''}`);
  }
  const verification = validateRdwArtifactReceipt(request, receipt);
  if (!verification.ok) throw new Error(`RDW artifact receipt invalid: ${verification.reasons.join('; ')}`);
  return receipt;
}

/** @param {Record<string, unknown>} request @param {unknown} receiptValue */
export function validateRdwArtifactReceipt(request, receiptValue) {
  const receipt = receiptValue && typeof receiptValue === 'object' && !Array.isArray(receiptValue)
    ? receiptValue
    : {};
  const content = request.content && typeof request.content === 'object' && !Array.isArray(request.content)
    ? request.content
    : {};
  const contract = Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'content'));
  const reasons = [];
  if (receipt.schema_version !== RDW_ARTIFACT_RECEIPT_SCHEMA) reasons.push('receipt schema mismatch');
  if (receipt.artifact_id !== request.artifact_id) reasons.push('artifact ID mismatch');
  if (receipt.request_hash !== stableHash(request)) reasons.push('request hash mismatch');
  if (receipt.contract_hash !== stableHash(contract)) reasons.push('contract hash mismatch');
  if (receipt.artifact_hash !== stableHash({ subject: text(content.subject), body: text(content.body) })) reasons.push('content hash mismatch');
  if (receipt.status === 'approved_for_human_review' && receipt.human_approval_required !== true) reasons.push('human approval boundary missing');
  if (receipt.ok !== true || receipt.status !== 'approved_for_human_review') {
    const blocked = Array.isArray(receipt.reasons) ? receipt.reasons.map(String).filter(Boolean) : [];
    reasons.push(...(blocked.length ? blocked : ['RDW blocked the artifact']));
  }
  return { ok: reasons.length === 0, reasons };
}
