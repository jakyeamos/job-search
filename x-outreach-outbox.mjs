#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { prepareOutreachDraft, validateOutreachDraftReceipt } from './outreach-draft-quality.mjs';

export const X_OUTREACH_OUTBOX_SCHEMA_VERSION = 2;
export const X_OUTREACH_OUTBOX_PATH = fileURLToPath(
  new URL('./data/x-outreach-outbox.json', import.meta.url),
);

const LOCAL_STATUSES = new Set(['ready_for_review', 'blocked', 'archived']);
const DELIVERY_STATUSES = new Set(['not_sent', 'sent_by_user']);
const NATIVE_DRAFT_STATUSES = new Set(['not_saved', 'unverified', 'verified_saved']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedWords(value) {
  return new Set(
    String(value)
      .toLowerCase()
      .replace(/^\s*(?:hi|hello|dear)\s+[^,!?-]+[,!?-]?\s*/, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2),
  );
}

function contentSimilarity(left, right) {
  const a = normalizedWords(left);
  const b = normalizedWords(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

export function hashXOutreachBody(body) {
  return createHash('sha256').update(String(body)).digest('hex');
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function handleFromProfileUrl(profileUrl) {
  try {
    const url = new URL(profileUrl);
    const value = url.pathname.split('/').filter(Boolean)[0] || '';
    return value ? `@${value}` : '';
  } catch {
    return '';
  }
}

export function loadXOutreachOutbox(filePath = X_OUTREACH_OUTBOX_PATH) {
  if (!existsSync(filePath)) {
    throw new Error(`X outreach outbox not found: ${filePath}`);
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isObject(parsed) || !Array.isArray(parsed.drafts)) return parsed;
    return {
      ...parsed,
      schemaVersion: X_OUTREACH_OUTBOX_SCHEMA_VERSION,
      drafts: parsed.drafts.map((draft) => {
        if (!isObject(draft) || typeof draft.body !== 'string') return draft;
        const contactName = isObject(draft.contact) ? String(draft.contact.name || '') : '';
        const current = validateOutreachDraftReceipt({
          channel: 'x',
          body: draft.body,
          receipt: draft.draftQuality,
        });
        const prepared = current.ok
          ? { body: draft.body, receipt: draft.draftQuality }
          : prepareOutreachDraft({ channel: 'x', body: draft.body, contactName, company: String(draft.company || '') });
        const pending = isObject(draft.pendingRevision) && typeof draft.pendingRevision.body === 'string'
          ? prepareOutreachDraft({
            channel: 'x',
            body: draft.pendingRevision.body,
            contactName,
            company: String(draft.company || ''),
          })
          : null;
        return {
          ...draft,
          body: prepared.body,
          bodyHash: hashXOutreachBody(prepared.body),
          draftQuality: prepared.receipt,
          ...(pending
            ? { pendingRevision: {
              ...draft.pendingRevision,
              body: pending.body,
              bodyHash: hashXOutreachBody(pending.body),
              draftQuality: pending.receipt,
            } }
            : draft.pendingRevision === null ? { pendingRevision: null } : {}),
        };
      }),
    };
  } catch (error) {
    throw new Error(`Could not read X outreach outbox ${filePath}: ${error.message}`);
  }
}

export function validateXOutreachOutbox(state) {
  const errors = [];
  const warnings = [];

  if (!isObject(state)) {
    return { ok: false, errors: ['Outbox must be a JSON object.'], warnings };
  }
  if (state.schemaVersion !== X_OUTREACH_OUTBOX_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${X_OUTREACH_OUTBOX_SCHEMA_VERSION}.`);
  }
  if (state.channel !== 'x') errors.push('channel must be "x".');
  if (!Array.isArray(state.drafts)) {
    errors.push('drafts must be an array.');
    return { ok: false, errors, warnings };
  }

  const ids = new Set();
  const recipientKeys = new Set();

  state.drafts.forEach((draft, index) => {
    const label = `drafts[${index}]`;
    if (!isObject(draft)) {
      errors.push(`${label} must be an object.`);
      return;
    }

    for (const field of ['id', 'company', 'role', 'body', 'source']) {
      if (typeof draft[field] !== 'string' || !draft[field].trim()) {
        errors.push(`${label}.${field} must be a non-empty string.`);
      }
    }

    if (typeof draft.id === 'string') {
      if (ids.has(draft.id)) errors.push(`${label}.id duplicates ${draft.id}.`);
      ids.add(draft.id);
    }

    if (!isObject(draft.contact)) {
      errors.push(`${label}.contact must be an object.`);
    } else {
      const { name, handle, profileUrl } = draft.contact;
      if (typeof name !== 'string' || !name.trim()) {
        errors.push(`${label}.contact.name must be a non-empty string.`);
      }
      if (typeof handle !== 'string' || !/^@[A-Za-z0-9_]{1,15}$/.test(handle)) {
        errors.push(`${label}.contact.handle must be a valid X handle.`);
      }
      try {
        const url = new URL(profileUrl);
        const profileHandle = url.pathname.split('/').filter(Boolean)[0] || '';
        if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'x.com') {
          errors.push(`${label}.contact.profileUrl must be an https://x.com profile URL.`);
        } else if (
          typeof handle === 'string' &&
          profileHandle.toLowerCase() !== handle.slice(1).toLowerCase()
        ) {
          errors.push(`${label}.contact.profileUrl does not match the X handle.`);
        }
      } catch {
        errors.push(`${label}.contact.profileUrl must be a valid URL.`);
      }

      if (typeof handle === 'string') {
        const key = `${String(draft.company).toLowerCase()}|${String(draft.role).toLowerCase()}|${handle.toLowerCase()}`;
        if (recipientKeys.has(key)) errors.push(`${label} duplicates recipient ${handle}.`);
        recipientKeys.add(key);
      }
    }

    if (!LOCAL_STATUSES.has(draft.status)) {
      errors.push(`${label}.status must be ready_for_review, blocked, or archived.`);
    }
    if (!DELIVERY_STATUSES.has(draft.deliveryStatus)) {
      errors.push(`${label}.deliveryStatus must be not_sent or sent_by_user.`);
    }
    if (!NATIVE_DRAFT_STATUSES.has(draft.nativeDraftStatus)) {
      errors.push(`${label}.nativeDraftStatus is invalid.`);
    }
    if (draft.savedLocally !== true) errors.push(`${label}.savedLocally must be true.`);
    if (draft.humanSendRequired !== true) errors.push(`${label}.humanSendRequired must be true.`);

    if (draft.nativeDraftStatus === 'verified_saved') {
      const evidence = draft.nativeDraftEvidence;
      const durableEvidence =
        isObject(evidence) &&
        (evidence.survivedReload === true ||
          (typeof evidence.providerDraftId === 'string' && evidence.providerDraftId.trim()));
      if (!durableEvidence) {
        errors.push(
          `${label} cannot claim verified_saved without reload survival or a provider draft ID.`,
        );
      }
    }

    if (draft.deliveryStatus === 'sent_by_user') {
      if (typeof draft.humanConfirmedSentAt !== 'string' || !draft.humanConfirmedSentAt.trim()) {
        errors.push(`${label}.humanConfirmedSentAt is required for sent_by_user.`);
      }
    } else if (draft.humanConfirmedSentAt) {
      errors.push(`${label}.humanConfirmedSentAt is only valid for sent_by_user.`);
    }

    if (typeof draft.body === 'string') {
      if (draft.body.length > 1000) warnings.push(`${label}.body exceeds 1,000 characters.`);
      if (isObject(draft.contact)) {
        const firstName = String(draft.contact.name || '').trim().split(/\s+/)[0];
        if (firstName && !draft.body.includes(firstName)) {
          errors.push(`${label}.body must name the recipient.`);
        }
      }
      if (typeof draft.company === 'string' && !draft.body.includes(draft.company)) {
        errors.push(`${label}.body must name the company.`);
      }
      if (draft.bodyHash !== hashXOutreachBody(draft.body)) {
        errors.push(`${label}.bodyHash does not match the message body.`);
      }
      const quality = validateOutreachDraftReceipt({ channel: 'x', body: draft.body, receipt: draft.draftQuality });
      if (!quality.ok) errors.push(`${label}.draftQuality is invalid: ${quality.reasons.join('; ')}.`);
    }

    if (draft.pendingRevision !== undefined && draft.pendingRevision !== null) {
      if (!isObject(draft.pendingRevision)) {
        errors.push(`${label}.pendingRevision must be an object or null.`);
      } else {
        const pendingBody = draft.pendingRevision.body;
        if (typeof pendingBody !== 'string' || !pendingBody.trim()) {
          errors.push(`${label}.pendingRevision.body must be a non-empty string.`);
        } else if (draft.pendingRevision.bodyHash !== hashXOutreachBody(pendingBody)) {
          errors.push(`${label}.pendingRevision.bodyHash does not match its body.`);
        }
        const pendingQuality = validateOutreachDraftReceipt({
          channel: 'x',
          body: String(pendingBody || ''),
          receipt: draft.pendingRevision.draftQuality,
        });
        if (!pendingQuality.ok) errors.push(`${label}.pendingRevision.draftQuality is invalid: ${pendingQuality.reasons.join('; ')}.`);
        if (
          typeof draft.pendingRevision.generatedAt !== 'string' ||
          !draft.pendingRevision.generatedAt.trim()
        ) {
          errors.push(`${label}.pendingRevision.generatedAt is required.`);
        }
      }
    }
  });

  for (let left = 0; left < state.drafts.length; left += 1) {
    for (let right = left + 1; right < state.drafts.length; right += 1) {
      const a = state.drafts[left];
      const b = state.drafts[right];
      if (!isObject(a) || !isObject(b)) continue;
      if (String(a.company).toLowerCase() !== String(b.company).toLowerCase()) continue;
      const similarity = contentSimilarity(a.body, b.body);
      if (similarity >= 0.9) {
        warnings.push(
          `${a.id} and ${b.id} are ${Math.round(similarity * 100)}% similar; iterate both messages before review.`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function saveXOutreachOutbox(state, filePath = X_OUTREACH_OUTBOX_PATH) {
  const validation = validateXOutreachOutbox(state);
  if (!validation.ok) {
    throw new Error(`Refusing to save invalid X outreach outbox:\n${validation.errors.join('\n')}`);
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath);
  }
  return validation;
}

/**
 * Record that a human sent an X message and archive its local copy from the
 * review surface. The record remains in the outbox as an audit trail; this
 * does not claim native X delivery or provider confirmation.
 *
 * @param {string} id
 * @param {{ now?: string }} [options]
 * @param {string} [filePath]
 */
export function markXOutreachDraftSentAndArchived(
  id,
  { now = new Date().toISOString() } = {},
  filePath = X_OUTREACH_OUTBOX_PATH,
) {
  const state = loadXOutreachOutbox(filePath);
  const validation = validateXOutreachOutbox(state);
  if (!validation.ok) {
    throw new Error(`Refusing to update invalid X outreach outbox:\n${validation.errors.join('\n')}`);
  }

  const draftId = String(id || '').trim();
  const draft = state.drafts.find((candidate) => candidate.id === draftId);
  if (!draft) throw new Error(`Unknown draft ID: ${draftId || '(missing)'}`);

  const sentAt = draft.humanConfirmedSentAt || String(now);
  const changed = draft.deliveryStatus !== 'sent_by_user'
    || draft.status !== 'archived'
    || !draft.archivedAt;
  if (!changed) return { state, draft, changed: false, validation };

  draft.deliveryStatus = 'sent_by_user';
  draft.humanConfirmedSentAt = sentAt;
  draft.status = 'archived';
  draft.archivedAt = draft.archivedAt || String(now);
  draft.updatedAt = String(now);
  state.updatedAt = String(now);
  const savedValidation = saveXOutreachOutbox(state, filePath);
  return { state, draft, changed: true, validation: savedValidation };
}

/**
 * Persist copy-ready X messages as soon as outreach preparation produces them.
 * Existing human-reviewed copy is never overwritten: changed generated copy is
 * retained as a pending revision for another review pass.
 */
export function syncPreparedXOutreachDrafts(
  { company, role, contacts, source = 'data/outreach-state.json', now = new Date().toISOString() },
  filePath = X_OUTREACH_OUTBOX_PATH,
) {
  const state = existsSync(filePath)
    ? loadXOutreachOutbox(filePath)
    : { schemaVersion: X_OUTREACH_OUTBOX_SCHEMA_VERSION, channel: 'x', updatedAt: now, drafts: [] };
  const existingById = new Map(state.drafts.map((draft) => [draft.id, draft]));
  let changed = false;

  for (const contact of Array.isArray(contacts) ? contacts : []) {
    const profileUrl = String(contact?.xProfileUrl || '');
    const rawBody = String(contact?.xDraft || '');
    const name = String(contact?.name || '');
    const handle = String(contact?.xHandle || handleFromProfileUrl(profileUrl));
    if (!profileUrl || !rawBody || !name || !handle) continue;
    const suppliedQuality = contact?.xDraftQuality;
    const suppliedValidation = suppliedQuality
      ? validateOutreachDraftReceipt({ channel: 'x', body: rawBody, receipt: suppliedQuality })
      : { ok: false, reasons: ['quality receipt is missing'] };
    if (suppliedQuality && !suppliedValidation.ok) {
      throw new Error(`Refusing to persist changed or unreviewed X draft for ${name}: ${suppliedValidation.reasons.join('; ')}`);
    }
    const prepared = suppliedValidation.ok
      ? { body: rawBody, receipt: suppliedQuality }
      : prepareOutreachDraft({ channel: 'x', body: rawBody, contactName: name, company: String(company) });
    if (!prepared.receipt?.passed) {
      throw new Error(`Refusing to persist X draft for ${name}: ${prepared.receipt?.quality?.errors?.join('; ') || 'Humanizer/quality gate failed'}`);
    }
    const body = prepared.body;
    const draftQuality = prepared.receipt;

    const id = `x-${slug(company)}-${slug(role)}-${slug(handle.slice(1))}`;
    const bodyHash = hashXOutreachBody(body);
    const existing = existingById.get(id);
    if (existing) {
      existing.lastPreparedAt = now;
      if (existing.bodyHash !== bodyHash) {
        existing.pendingRevision = { body, bodyHash, draftQuality, generatedAt: now };
      } else {
        existing.pendingRevision = null;
      }
      existing.updatedAt = now;
      changed = true;
      continue;
    }

    const evidenceUrls = [...new Set([
      profileUrl,
      contact.sourceUrl,
      ...(Array.isArray(contact.sourceUrls) ? contact.sourceUrls : []),
    ].filter((value) => typeof value === 'string' && value.trim()))];
    const draft = {
      id,
      company: String(company),
      role: String(role),
      contact: { name, handle, profileUrl },
      body,
      bodyHash,
      draftQuality,
      status: 'ready_for_review',
      deliveryStatus: 'not_sent',
      savedLocally: true,
      nativeDraftStatus: 'not_saved',
      nativeDraftEvidence: null,
      humanSendRequired: true,
      applicationStatus: 'applied_confirmed',
      source,
      evidenceUrls,
      pendingRevision: null,
      createdAt: now,
      updatedAt: now,
      lastPreparedAt: now,
    };
    state.drafts.push(draft);
    existingById.set(id, draft);
    changed = true;
  }

  if (changed) {
    state.updatedAt = now;
    saveXOutreachOutbox(state, filePath);
  }
  return { state, changed, validation: validateXOutreachOutbox(state) };
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || 'list';
  let filePath = X_OUTREACH_OUTBOX_PATH;
  let json = false;
  let at = null;
  const positional = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--json') json = true;
    else if (arg === '--file') filePath = path.resolve(args.shift() || '');
    else if (arg === '--at') at = args.shift() || null;
    else positional.push(arg);
  }
  return { command, filePath, json, at, positional };
}

function printUsage() {
  console.log('Usage: node x-outreach-outbox.mjs <list|show|verify|mark-sent> [id] [--json] [--at ISO timestamp] [--file path]');
}

export function runCli(argv = process.argv.slice(2)) {
  const { command, filePath, json, at, positional } = parseArgs(argv);
  const state = loadXOutreachOutbox(filePath);
  const validation = validateXOutreachOutbox(state);

  if (command === 'verify') {
    if (json) console.log(JSON.stringify(validation, null, 2));
    else {
      console.log(validation.ok ? 'X outreach outbox: valid' : 'X outreach outbox: invalid');
      for (const warning of validation.warnings) console.log(`WARNING: ${warning}`);
      for (const error of validation.errors) console.error(`ERROR: ${error}`);
    }
    return validation.ok ? 0 : 1;
  }

  if (!validation.ok) {
    for (const error of validation.errors) console.error(`ERROR: ${error}`);
    return 1;
  }

  if (command === 'mark-sent') {
    const result = markXOutreachDraftSentAndArchived(positional[0], { now: at || new Date().toISOString() }, filePath);
    if (json) console.log(JSON.stringify(result.draft, null, 2));
    else console.log(`${result.draft.id}: sent_by_user and archived${result.changed ? '' : ' (already recorded)'}`);
    return 0;
  }

  if (command === 'list') {
    if (json) console.log(JSON.stringify(state, null, 2));
    else {
      for (const draft of state.drafts) {
        console.log(`${draft.id}\t${draft.contact.handle}\t${draft.company}\t${draft.status}\t${draft.deliveryStatus}`);
      }
      console.log('\nLocal copies are durable. No X message is sent or claimed as natively saved.');
    }
    return 0;
  }

  if (command === 'show') {
    const id = positional[0];
    const draft = state.drafts.find((candidate) => candidate.id === id);
    if (!draft) {
      console.error(`Unknown draft ID: ${id || '(missing)'}`);
      return 1;
    }
    if (json) console.log(JSON.stringify(draft, null, 2));
    else {
      console.log(`${draft.contact.name} (${draft.contact.handle}) — ${draft.company}, ${draft.role}`);
      console.log(`Local status: ${draft.status}; delivery: ${draft.deliveryStatus}; X native draft: ${draft.nativeDraftStatus}`);
      console.log(`\n${draft.body}`);
    }
    return 0;
  }

  printUsage();
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
