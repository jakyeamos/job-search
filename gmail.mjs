#!/usr/bin/env node
// @ts-check

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';

import {
  GmailClientError,
  TARGET_GMAIL_ACCOUNT,
  createGmailClient,
} from './gmail-client.mjs';
import {
  companyFromUrl,
  extractJobUrls,
  getMessageBody,
  isAuthenticEmail,
  parseRoleAtCompany,
} from './plugins/gmail/_helpers.mjs';
import { loadDotenvOnce } from './plugins/_engine.mjs';

export const JOB_LEADS_LABEL = 'Job Leads';
export const REVIEW_LABEL = 'Job Leads/Review';
export const ORGANIZER_STATE_PATH = 'data/gmail-organizer-state.json';

/**
 * These rules are deliberately sender/domain + job-language based. They are
 * installed as Gmail filters, so new messages are organized before the daily
 * queue refresh runs. Gmail permits one user label per filter action, so each
 * source produces a parent-label filter and a source-label filter.
 */
export const SOURCE_RULES = [
  {
    source: 'linkedin',
    label: 'LinkedIn',
    domains: ['linkedin.com'],
    query: 'from:{jobalerts-noreply@linkedin.com jobs-listings@linkedin.com} {job jobs alert opportunity hiring career engineer developer apply position role opening}',
  },
  {
    source: 'handshake',
    label: 'Handshake',
    domains: ['joinhandshake.com', 'handshake.com'],
    query: 'from:{joinhandshake.com handshake.com} {job jobs alert opportunity career}',
  },
  {
    source: 'wellfound',
    label: 'Wellfound',
    domains: ['wellfound.com', 'angel.co', 'angellist.com'],
    query: 'from:{wellfound.com angel.co angellist.com} {job jobs alert opportunity hiring}',
  },
  {
    source: 'built-in',
    label: 'Built In',
    domains: ['builtin.com'],
    query: 'from:builtin.com {job jobs alert opportunity hiring career}',
  },
  {
    source: 'teamwork-online',
    label: 'TeamWork Online',
    domains: ['teamworkonline.com'],
    query: 'from:{notifiers@teamworkonline.com employment@teamworkonline.com services@teamworkonline.com alerts@teamworkonline.com} {job jobs alert opportunity hiring career engineer developer apply position role opening}',
  },
];

const JOB_LANGUAGE_RE = /\b(job|jobs|role|roles|opportunity|opportunities|career|careers|hiring|position|positions|engineer|developer|apply|alert|opening|openings)\b/i;
const LINKEDIN_JOB_SENDER_RE = /\b(?:jobalerts-noreply|jobs-listings)@(?:em\.)?linkedin\.com\b/i;
const TEAMWORK_JOB_SENDER_RE = /\b(?:notifiers|employment|services|alerts)@(?:em\.)?teamworkonline\.com\b/i;
const NON_LEAD_SUBJECT_RE = /\b(?:application received|thanks for being|unsubscribe|update your profile|update your notification preferences|get hired faster|top candidate)\b/i;
const LEGACY_SOURCE_QUERIES = new Map([
  ['linkedin', ['from:linkedin.com {job jobs alert opportunity hiring career}']],
  ['teamwork-online', ['from:teamworkonline.com {job jobs alert opportunity hiring career}']],
]);
const REVIEW_SIGNALS = [
  /unsubscribe/i,
  /view\s+(?:job|role|opportunity)/i,
  /apply\s+now/i,
  /job\s+alert/i,
  /career/i,
];

/** @param {string} value */
function lower(value) { return String(value || '').trim().toLowerCase(); }

/** @param {string} configured */
export function assertTargetAccount(configured) {
  if (lower(configured || TARGET_GMAIL_ACCOUNT) !== lower(TARGET_GMAIL_ACCOUNT)) {
    throw new GmailClientError(`Gmail configuration must target ${TARGET_GMAIL_ACCOUNT}, not ${configured || '(empty)'}`);
  }
}

/** @param {Array<{name?: string, value?: string}>} headers @param {string} name */
export function headerValue(headers, name) {
  const wanted = lower(name);
  return headers.find((header) => lower(header.name || '') === wanted)?.value || '';
}

/** @param {string} from */
export function senderDomain(from) {
  const match = String(from || '').match(/<\s*[^>]+@([^>\s]+)\s*>|\b[^\s@]+@([^\s>]+)\b/i);
  return lower(match?.[1] || match?.[2] || '');
}

/** @param {string} domain @param {string[]} allowed */
function domainMatches(domain, allowed) {
  return allowed.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));
}

/** @param {string} source @param {string} from @param {string} subject @param {string[]} urls @param {string} combined */
function isKnownJobAlert(source, from, subject, urls, combined) {
  if (NON_LEAD_SUBJECT_RE.test(subject)) return false;
  if (source === 'linkedin' && !LINKEDIN_JOB_SENDER_RE.test(from)) return false;
  if (source === 'teamwork-online' && !TEAMWORK_JOB_SENDER_RE.test(from)) return false;
  const signalText = source === 'linkedin' || source === 'teamwork-online' ? subject : combined;
  return JOB_LANGUAGE_RE.test(signalText) || urls.length > 0;
}

/**
 * Classify only metadata/body signals. The body is never persisted; callers
 * can use this result to decide whether a message is safe to label/archive.
 * @param {{ headers?: Array<{name?: string, value?: string}>, subject?: string, body?: string, urls?: string[] }} input
 * @returns {{ source: string, label: string, confidence: 'high'|'uncertain', reason: string }}
 */
export function classifyAlert(input) {
  const headers = input.headers || [];
  const subject = input.subject || headerValue(headers, 'subject');
  const from = headerValue(headers, 'from');
  const domain = senderDomain(from);
  const body = input.body || '';
  const urls = input.urls || extractJobUrls(body);
  const combined = `${subject}\n${body}`;
  const known = SOURCE_RULES.find((rule) => domainMatches(domain, rule.domains));

  if (known && isKnownJobAlert(known.source, from, subject, urls, combined)) {
    return {
      source: known.source,
      label: `Job Leads/${known.label}`,
      confidence: 'high',
      reason: `known job-alert source ${domain}`,
    };
  }

  if (known && (known.source === 'linkedin' || known.source === 'teamwork-online')) {
    return {
      source: 'unknown',
      label: REVIEW_LABEL,
      confidence: 'uncertain',
      reason: `known ${known.source} sender did not match a job-alert pattern`,
    };
  }

  const score = [
    JOB_LANGUAGE_RE.test(subject) ? 2 : 0,
    JOB_LANGUAGE_RE.test(body) ? 1 : 0,
    urls.length > 0 ? 1 : 0,
    REVIEW_SIGNALS.some((signal) => signal.test(combined)) ? 1 : 0,
    domain && !domain.includes('gmail.com') ? 1 : 0,
  ].reduce((total, value) => total + value, 0);

  if (score >= 4 && JOB_LANGUAGE_RE.test(subject) && urls.length > 0) {
    return {
      source: 'review',
      label: REVIEW_LABEL,
      confidence: 'high',
      reason: `high-confidence job-alert signals from ${domain || 'unknown sender'}`,
    };
  }

  return {
    source: 'unknown',
    label: REVIEW_LABEL,
    confidence: 'uncertain',
    reason: `not enough job-alert signals from ${domain || 'unknown sender'}`,
  };
}

/** @param {string} root */
export function loadGmailSettings(root = process.cwd()) {
  const defaults = {
    enabled: true,
    account_email: TARGET_GMAIL_ACCOUNT,
    label: JOB_LEADS_LABEL,
    days_back: 30,
    max_messages: 1000,
  };
  const file = path.join(root, 'config', 'plugins.yml');
  if (!existsSync(file)) return defaults;
  try {
    const parsed = yaml.load(readFileSync(file, 'utf8')) || {};
    const configured = parsed?.plugins?.gmail;
    return configured && typeof configured === 'object'
      ? { ...defaults, ...configured }
      : defaults;
  } catch {
    return defaults;
  }
}

/** @param {Record<string, string | undefined>} env */
export function hasGmailCredentials(env = process.env) {
  return Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN);
}

/** @param {string} root */
function readState(root) {
  const file = path.join(root, ORGANIZER_STATE_PATH);
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

/** @param {string} root @param {Record<string, unknown>} state */
function writeState(root, state) {
  mkdirSync(path.join(root, 'data'), { recursive: true });
  const file = path.join(root, ORGANIZER_STATE_PATH);
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/** @param {Array<Record<string, unknown>>} labels @param {string} name */
function findLabel(labels, name) {
  return labels.find((label) => label.name === name);
}

/**
 * @param {Awaited<ReturnType<typeof createGmailClient>>} client
 * @param {string[]} names
 * @param {boolean} dryRun
 * @returns {Promise<Record<string, string>>}
 */
async function ensureLabels(client, names, dryRun) {
  const labelIds = {};
  let labels = await client.listLabels();
  for (const name of names) {
    const current = findLabel(labels, name);
    if (typeof current?.id === 'string') {
      labelIds[name] = current.id;
      continue;
    }
    if (dryRun) {
      labelIds[name] = `DRY_RUN:${name}`;
      continue;
    }
    const created = await client.createLabel(name);
    if (typeof created.id === 'string') labelIds[name] = created.id;
    labels = await client.listLabels();
  }
  return labelIds;
}

/** @param {Record<string, string>} labelIds */
export function buildFilterPlan(labelIds) {
  const parentId = labelIds[JOB_LEADS_LABEL] || `DRY_RUN:${JOB_LEADS_LABEL}`;
  return SOURCE_RULES.flatMap((rule) => {
    const sourceId = labelIds[`Job Leads/${rule.label}`] || `DRY_RUN:Job Leads/${rule.label}`;
    const criteria = { query: rule.query };
    const removeLabelIds = ['INBOX', 'UNREAD'];
    return [
      {
        source: rule.source,
        label: rule.label,
        labelRole: 'parent',
        criteria,
        action: { addLabelIds: [parentId], removeLabelIds },
      },
      {
        source: rule.source,
        label: rule.label,
        labelRole: 'source',
        criteria,
        action: { addLabelIds: [sourceId], removeLabelIds },
      },
    ];
  });
}

/** @param {Record<string, unknown>} filter @param {Record<string, unknown>} plan */
function filterMatches(filter, plan) {
  const criteria = filter.criteria || {};
  const action = filter.action || {};
  const add = Array.isArray(action.addLabelIds) ? [...action.addLabelIds].sort() : [];
  const expectedAdd = Array.isArray(plan.action.addLabelIds) ? [...plan.action.addLabelIds].sort() : [];
  const remove = Array.isArray(action.removeLabelIds) ? [...action.removeLabelIds].sort() : [];
  const expectedRemove = Array.isArray(plan.action.removeLabelIds) ? [...plan.action.removeLabelIds].sort() : [];
  return criteria.query === plan.criteria.query
    && JSON.stringify(add) === JSON.stringify(expectedAdd)
    && JSON.stringify(remove) === JSON.stringify(expectedRemove);
}

/** @param {Record<string, unknown>} filter @param {Record<string, unknown>} plan */
function isLegacySourceFilter(filter, plan) {
  const criteria = filter.criteria && typeof filter.criteria === 'object' ? filter.criteria : {};
  const action = filter.action && typeof filter.action === 'object' ? filter.action : {};
  const query = typeof criteria.query === 'string' ? criteria.query : '';
  const legacyQueries = LEGACY_SOURCE_QUERIES.get(plan.source) || [];
  const addLabelIds = Array.isArray(action.addLabelIds) ? action.addLabelIds : [];
  const expectedLabelId = Array.isArray(plan.action?.addLabelIds) ? plan.action.addLabelIds[0] : '';
  return legacyQueries.includes(query) && typeof filter.id === 'string' && addLabelIds.includes(expectedLabelId);
}

/**
 * @param {{ root?: string, dryRun?: boolean, client?: Awaited<ReturnType<typeof createGmailClient>>, logger?: (...args: unknown[]) => void }} [options]
 */
export async function setupFilters(options = {}) {
  const root = options.root || process.cwd();
  const dryRun = options.dryRun === true;
  const logger = options.logger || console.log;
  const settings = loadGmailSettings(root);
  const env = process.env;
  assertTargetAccount(String(settings.account_email));

  if (!hasGmailCredentials(env)) {
    logger('Gmail credentials are not configured; showing the offline filter plan only.');
    for (const rule of SOURCE_RULES) logger(`  ${rule.source}: ${rule.query}`);
    if (!dryRun) throw new GmailClientError('cannot install Gmail filters until OAuth credentials are configured');
    return { accountEmail: settings.account_email, authenticated: false, dryRun: true, created: [], existing: [] };
  }

  const client = options.client || await createGmailClient({ expectedAccount: settings.account_email });
  const accountEmail = await client.verifyAccount();
  const names = [JOB_LEADS_LABEL, REVIEW_LABEL, ...SOURCE_RULES.map((rule) => `Job Leads/${rule.label}`)];
  const labelIds = await ensureLabels(client, names, dryRun);
  const plans = buildFilterPlan(labelIds);
  const existing = await client.listFilters();
  const stale = existing.filter((filter) => plans.some((plan) => isLegacySourceFilter(filter, plan)));
  const active = existing.filter((filter) => !stale.includes(filter));
  const deleted = [];
  for (const filter of stale) {
    if (!dryRun) await client.deleteFilter(String(filter.id));
    deleted.push({ id: filter.id || null });
  }
  const created = [];
  for (const plan of plans) {
    const matching = active.find((filter) => filterMatches(filter, plan));
    if (matching) continue;
    if (!dryRun) {
      const createdFilter = await client.createFilter({ criteria: plan.criteria, action: plan.action });
      created.push({ source: plan.source, labelRole: plan.labelRole, id: createdFilter.id || null });
    } else {
      created.push({ source: plan.source, labelRole: plan.labelRole, id: null });
    }
  }

  if (!dryRun) {
    const state = readState(root);
    writeState(root, {
      ...state,
      account_email: accountEmail,
      filter_sources: [...new Set(plans.map((plan) => plan.source))],
      updated_at: new Date().toISOString(),
    });
  }

  logger(`Gmail account verified: ${accountEmail}`);
  logger(`Labels ready: ${names.length}`);
  logger(`${dryRun ? 'Stale filters to delete' : 'Stale filters deleted'}: ${deleted.length}`);
  logger(`${dryRun ? 'Filters to create' : 'Filters created'}: ${created.length}`);
  return { accountEmail, authenticated: true, dryRun, created, deleted, existing: existing.length, plans };
}

/**
 * @param {{ root?: string, dryRun?: boolean, limit?: number, client?: Awaited<ReturnType<typeof createGmailClient>>, logger?: (...args: unknown[]) => void }} [options]
 */
export async function organizeGmail(options = {}) {
  const root = options.root || process.cwd();
  const dryRun = options.dryRun === true;
  const logger = options.logger || console.log;
  const settings = loadGmailSettings(root);
  const env = process.env;
  assertTargetAccount(String(settings.account_email));
  if (!hasGmailCredentials(env)) {
    const message = 'Gmail credentials are not configured; skipping email organization.';
    if (dryRun) {
      logger(message);
      return { authenticated: false, dryRun: true, scanned: 0, organized: 0, skipped: 0, items: [] };
    }
    throw new GmailClientError(message);
  }

  const client = options.client || await createGmailClient({ expectedAccount: settings.account_email });
  const accountEmail = await client.verifyAccount();
  const labelIds = await ensureLabels(
    client,
    [JOB_LEADS_LABEL, REVIEW_LABEL, ...SOURCE_RULES.map((rule) => `Job Leads/${rule.label}`)],
    dryRun,
  );
  const daysBack = Number(settings.days_back) > 0 ? Number(settings.days_back) : 30;
  const limit = Number(options.limit || settings.max_messages) > 0 ? Number(options.limit || settings.max_messages) : 200;
  const baseQuery = `in:anywhere newer_than:${daysBack}d -label:"${JOB_LEADS_LABEL}"`;
  const knownSourceQuery = `${baseQuery} {${SOURCE_RULES.flatMap((rule) => rule.domains.map((domain) => `from:${domain}`)).join(' ')}}`;
  const [knownSourceMessages, genericMessages] = await Promise.all([
    client.listMessages(knownSourceQuery, { limit: Math.max(1000, limit) }),
    client.listMessages(baseQuery, { limit: Math.min(limit, 250) }),
  ]);
  const messages = [...new Map([...knownSourceMessages, ...genericMessages].map((message) => [message.id, message])).values()];
  const items = [];
  let skipped = 0;
  const processedIds = new Set(Array.isArray(readState(root).processed_message_ids)
    ? readState(root).processed_message_ids.filter((id) => typeof id === 'string')
    : []);

  for (const message of messages) {
    const id = message.id;
    if (!id) continue;
    const full = await client.getMessage(id, 'full');
    const payload = full.payload && typeof full.payload === 'object' ? full.payload : {};
    const headers = Array.isArray(payload.headers) ? payload.headers : [];
    const subject = headerValue(headers, 'subject');
    if (!isAuthenticEmail(headers)) {
      skipped++;
      continue;
    }
    const body = getMessageBody(payload);
    const urls = extractJobUrls(body).slice(0, 20);
    const classification = classifyAlert({ headers, subject, body, urls });
    if (classification.confidence !== 'high') {
      skipped++;
      continue;
    }
    const childLabel = classification.label === REVIEW_LABEL
      ? REVIEW_LABEL
      : classification.label;
    const addLabelIds = [labelIds[JOB_LEADS_LABEL], labelIds[childLabel]].filter(Boolean);
    if (!dryRun) {
      await client.modifyMessage(id, addLabelIds, ['INBOX', 'UNREAD']);
      processedIds.add(id);
    }
    const seed = parseRoleAtCompany(subject);
    items.push({
      messageId: id,
      source: classification.source,
      label: classification.label,
      confidence: classification.confidence,
      reason: classification.reason,
      subject,
      from: headerValue(headers, 'from'),
      urls,
      title: seed?.role || 'Job lead (email)',
      company: seed?.company || companyFromUrl(urls[0] || '') || '',
    });
  }

  if (!dryRun) {
    writeState(root, {
      ...readState(root),
      account_email: accountEmail,
      processed_message_ids: [...processedIds].slice(-5000),
      last_organized_at: new Date().toISOString(),
    });
  }

  logger(`Gmail account verified: ${accountEmail}`);
  logger(`Scanned ${messages.length} message(s); ${items.length} high-confidence alert(s) ${dryRun ? 'would be organized' : 'organized'}.`);
  return { accountEmail, authenticated: true, dryRun, scanned: messages.length, organized: items.length, skipped, items };
}

/** @param {string[]} args */
function hasFlag(args, flag) { return args.includes(flag); }

/** @param {string[]} args @param {string} flag @param {string} fallback */
function flagValue(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index !== -1 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  const dryRun = hasFlag(args, '--dry-run');
  const limit = Number(flagValue(args, '--limit', '200')) || 200;
  if (command === 'setup-filters') {
    await setupFilters({ dryRun });
    return;
  }
  if (command === 'organize') {
    await organizeGmail({ dryRun, limit });
    return;
  }
  if (command === 'status') {
    const settings = loadGmailSettings();
    console.log(`Target Gmail account: ${settings.account_email}`);
    console.log(`Credentials configured: ${hasGmailCredentials() ? 'yes' : 'no'}`);
    if (hasGmailCredentials()) {
      const client = await createGmailClient({ expectedAccount: settings.account_email });
      console.log(`Verified Gmail account: ${await client.verifyAccount()}`);
      console.log(`Labels available: ${(await client.listLabels()).length}`);
    }
    return;
  }
  throw new Error(`Unknown Gmail command "${command}". Use setup-filters, organize, or status.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    await loadDotenvOnce();
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`gmail: ${message}`);
    process.exitCode = error instanceof GmailClientError && error.status === 403 ? 2 : 1;
  }
}
