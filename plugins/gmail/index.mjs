// @ts-check
// Gmail ingest remains read-only. Label creation/message organization lives in
// gmail.mjs and requires the explicit Gmail modify and settings-basic scopes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import { createGmailClient, TARGET_GMAIL_ACCOUNT } from '../../gmail-client.mjs';
import { assertTargetAccount, classifyAlert } from '../../gmail.mjs';
import {
  companyFromUrl,
  extractJobUrls,
  getMessageBody,
  isAuthenticEmail,
  parseRoleAtCompany,
} from './_helpers.mjs';

const STATE_PATH = 'data/gmail-state.json';

/** @returns {Set<string>} */
function loadProcessedIds() {
  if (!existsSync(STATE_PATH)) return new Set();
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return new Set(Array.isArray(state.processed_message_ids)
      ? state.processed_message_ids.filter((id) => typeof id === 'string')
      : []);
  } catch { return new Set(); }
}

/** @param {Set<string>} ids @param {boolean} dryRun */
function saveProcessedIds(ids, dryRun) {
  if (dryRun) return;
  mkdirSync('data', { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({
    account_email: TARGET_GMAIL_ACCOUNT,
    processed_message_ids: [...ids].slice(-5000),
    updated_at: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');
}

/** @param {Array<{name?: string, value?: string}>} headers @param {string} name */
function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  return headers.find((header) => (header.name || '').toLowerCase() === wanted)?.value || '';
}

/** @type {{ ingest: (ctx: Record<string, unknown>) => Promise<Array<Record<string, unknown>>> }} */
const plugin = {
  async ingest(ctx) {
    const env = /** @type {Record<string, string | undefined>} */ (ctx.env || {});
    const settings = /** @type {Record<string, unknown>} */ (ctx.settings || {});
    const label = typeof settings.label === 'string' ? settings.label : 'Job Leads';
    const daysBack = Number(settings.days_back || 7);
    const expectedAccount = typeof settings.account_email === 'string'
      ? settings.account_email
      : TARGET_GMAIL_ACCOUNT;
    assertTargetAccount(expectedAccount);
    const dryRun = ctx.dryRun === true;
    const log = typeof ctx.log === 'function' ? ctx.log : console.log;
    const fetchFn = /** @type {(input: string, init?: RequestInit) => Promise<Response>} */ (ctx.fetch);

    const client = await createGmailClient({
      env,
      fetchFn,
      expectedAccount,
    });
    const accountEmail = await client.verifyAccount();
    const query = `label:"${label}" newer_than:${Number.isInteger(daysBack) && daysBack > 0 ? daysBack : 7}d`;
    log(`gmail: account ${accountEmail}; querying ${query}`);
    const messages = await client.listMessages(query, { limit: Number(settings.max_messages || 200) });
    const processedIds = loadProcessedIds();
    const seenUrls = new Set();
    const jobs = [];

    for (const message of messages) {
      const id = message.id;
      if (!id || processedIds.has(id)) continue;
      let full;
      try {
        full = await client.getMessage(id, 'full');
      } catch (error) {
        log(`gmail: failed to fetch message ${id} — ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const payload = full.payload && typeof full.payload === 'object' ? full.payload : {};
      const headers = Array.isArray(payload.headers) ? payload.headers : [];
      const subject = headerValue(headers, 'subject');
      if (!isAuthenticEmail(headers)) {
        log(`gmail: skipping unauthenticated email "${subject}"`);
        processedIds.add(id);
        continue;
      }
      const body = getMessageBody(payload);
      const urls = extractJobUrls(body);
      const classification = classifyAlert({ headers, subject, body, urls });
      if (classification.confidence !== 'high') {
        log(`gmail: skipping unclassified labeled email "${subject}"`);
        processedIds.add(id);
        continue;
      }
      const seed = parseRoleAtCompany(subject);
      for (const url of urls) {
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        jobs.push({
          title: seed?.role || 'Job lead (email)',
          url,
          canonicalUrl: url,
          sourceUrl: url,
          company: companyFromUrl(url) || seed?.company || '',
          location: '',
          source: `gmail:${classification.source}`,
          sourceLabel: classification.label,
          sourceMessageId: id,
          liveness: 'source-alert',
          fitConfidence: classification.confidence,
        });
      }
      processedIds.add(id);
    }

    saveProcessedIds(processedIds, dryRun);
    log(`gmail: ${jobs.length} lead(s) returned${dryRun ? ' (dry run)' : ''}`);
    return jobs;
  },
};

export default plugin;
