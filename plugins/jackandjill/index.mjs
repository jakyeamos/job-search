// @ts-check

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { normalizeJackJob, normalizeText, unpackJackRecords } from '../../jackandjill-lib.mjs';

const DEFAULT_CACHE_FILE = path.join('data', 'jackandjill-recommendations.json');

/** @param {string} file */
function readCache(file) {
  if (!existsSync(file)) return [];
  try {
    return unpackJackRecords(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new Error(`cache is not valid JSON (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @type {{ ingest: (ctx: Record<string, unknown>) => Promise<Array<Record<string, unknown>>> }} */
const plugin = {
  async ingest(ctx) {
    const settings = /** @type {Record<string, unknown>} */ (ctx.settings || {});
    const configured = normalizeText(settings.cache_file || DEFAULT_CACHE_FILE);
    const cacheFile = path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
    const log = typeof ctx.log === 'function' ? ctx.log : console.log;
    if (!existsSync(cacheFile)) {
      log(`jackandjill: no local recommendation cache at ${cacheFile}; run node jackandjill.mjs sync --write`);
      return [];
    }
    const jobs = [];
    const seen = new Set();
    for (const raw of readCache(cacheFile)) {
      const job = normalizeJackJob(raw);
      if (!job || seen.has(job.canonicalUrl)) continue;
      seen.add(job.canonicalUrl);
      jobs.push(job);
    }
    log(`jackandjill: ${jobs.length} cached recommendation(s) returned${ctx.dryRun === true ? ' (dry run)' : ''}`);
    return jobs;
  },
};

export default plugin;
