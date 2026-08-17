// @ts-check

import { existsSync } from 'node:fs';

import {
  getMarketplaceSource,
  normalizeText,
  readMarketplaceCache,
  readMarketplaceSyncStatus,
  resolveMarketplacePaths,
} from '../authenticated-marketplace-lib.mjs';

/**
 * Build the cache-only ingest hook used by authenticated marketplace plugins.
 * Browser authority belongs to marketplace.mjs; this hook never opens a tab or
 * performs an account-side action.
 *
 * @param {string} source
 */
export function createMarketplaceIngestPlugin(source) {
  const sourceConfig = getMarketplaceSource(source);
  return {
    async ingest(ctx) {
      const settings = /** @type {Record<string, unknown>} */ (ctx.settings || {});
      const paths = resolveMarketplacePaths(settings, source);
      const log = typeof ctx.log === 'function' ? ctx.log : console.log;
      const status = readMarketplaceSyncStatus(paths.statusFile);
      if (status && status.ok === false) {
        log(`${source}: last browser sync unavailable (${normalizeText(status.error) || 'unknown bridge error'}); cached records are preserved`);
      }
      if (!existsSync(paths.cacheFile)) {
        log(`${source}: no local recommendation cache at ${paths.cacheFile}; run node marketplace.mjs sync --source ${source} --write`);
        return [];
      }
      const jobs = readMarketplaceCache(paths.cacheFile, {
        source,
        ...(typeof status?.authenticated === 'boolean' ? { authenticated: status.authenticated } : {}),
      });
      log(`${sourceConfig.sourceLabel}: ${jobs.length} cached opportunity(s) returned${ctx.dryRun === true ? ' (dry run)' : ''}`);
      return jobs;
    },
  };
}
