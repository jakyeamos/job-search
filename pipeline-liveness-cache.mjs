#!/usr/bin/env node
// @ts-check

/**
 * Batch-only cache for browser access failures.
 *
 * This cache deliberately stores only "browser fallback required" observations.
 * It never caches active/expired results, never upgrades verification, and uses
 * a short TTL so a later run can re-attempt the browser surface.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;
export const CACHE_DIR_NAME = path.join('data', 'cache', 'pipeline-liveness');
const ALLOWED_KINDS = new Set(['browser-policy', 'browser-unavailable']);

/** @param {string} rawUrl */
export function normalizeCacheHost(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return host || null;
}

/** @param {string} root @param {string} host */
export function cacheFileForHost(root, host) {
  const digest = createHash('sha256').update(host).digest('hex');
  return path.join(root, CACHE_DIR_NAME, `${digest}.json`);
}

/** @param {string} file */
function readRecord(file) {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Return a still-valid browser fallback observation for a URL.
 * @param {string} rawUrl
 * @param {{ root?: string, now?: number }} [options]
 */
export function getCachedBrowserFallback(rawUrl, options = {}) {
  const host = normalizeCacheHost(rawUrl);
  if (!host) return null;
  const root = options.root || ROOT;
  const record = readRecord(cacheFileForHost(root, host));
  if (!record || record.host !== host || !ALLOWED_KINDS.has(record.kind)) return null;
  const expiresAt = Date.parse(String(record.expiresAt || ''));
  if (!Number.isFinite(expiresAt) || expiresAt <= (options.now || Date.now())) return null;
  return { ...record, cachedFor: host };
}

/**
 * Record that this host required the Codex-native headless fallback.
 * @param {string} rawUrl
 * @param {{ root?: string, kind?: string, reason: string, now?: number, ttlMs?: number }} options
 */
export function recordBrowserFallback(rawUrl, options) {
  const host = normalizeCacheHost(rawUrl);
  if (!host) throw new Error('Cannot cache browser fallback for an invalid HTTP(S) URL');
  const kind = options.kind || 'browser-policy';
  if (!ALLOWED_KINDS.has(kind)) throw new Error(`Unsupported fallback cache kind: ${kind}`);
  const reason = String(options.reason || '').trim();
  if (!reason) throw new Error('A reason is required when recording a browser fallback');
  const root = options.root || ROOT;
  const now = options.now || Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const file = cacheFileForHost(root, host);
  mkdirSync(path.dirname(file), { recursive: true });
  const record = {
    version: 1,
    host,
    kind,
    reason,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    verification: 'unconfirmed',
    scope: 'batch-fallback-only',
  };
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
  return record;
}

/** @param {string} rawUrl @param {{ root?: string }} [options] */
export function clearBrowserFallback(rawUrl, options = {}) {
  const host = normalizeCacheHost(rawUrl);
  if (!host) return false;
  const file = cacheFileForHost(options.root || ROOT, host);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

/** @param {{ root?: string, now?: number }} [options] */
export function listCachedBrowserFallbacks(options = {}) {
  const root = options.root || ROOT;
  const dir = path.join(root, CACHE_DIR_NAME);
  if (!existsSync(dir)) return [];
  const now = options.now || Date.now();
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readRecord(path.join(dir, name)))
    .filter((record) => record && ALLOWED_KINDS.has(record.kind))
    .filter((record) => Date.parse(String(record.expiresAt || '')) > now)
    .sort((a, b) => String(a.host).localeCompare(String(b.host)));
}

function usage() {
  console.error(`Usage:
  node pipeline-liveness-cache.mjs status <url>
  node pipeline-liveness-cache.mjs record <url> --reason <text> [--kind browser-policy|browser-unavailable] [--ttl-hours N]
  node pipeline-liveness-cache.mjs clear <url>
  node pipeline-liveness-cache.mjs list`);
}

async function main() {
  const [command, rawUrl, ...rest] = process.argv.slice(2);
  if (!command) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (command === 'list') {
    console.log(JSON.stringify(listCachedBrowserFallbacks(), null, 2));
    return;
  }
  if (!rawUrl) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(getCachedBrowserFallback(rawUrl) || { cached: false }, null, 2));
    return;
  }
  if (command === 'clear') {
    console.log(JSON.stringify({ cleared: clearBrowserFallback(rawUrl) }));
    return;
  }
  if (command === 'record') {
    let reason = '';
    let kind = 'browser-policy';
    let ttlHours = DEFAULT_TTL_MS / (60 * 60 * 1000);
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--reason') reason = rest[++i] || '';
      else if (rest[i] === '--kind') kind = rest[++i] || '';
      else if (rest[i] === '--ttl-hours') ttlHours = Number(rest[++i]);
      else throw new Error(`Unknown option: ${rest[i]}`);
    }
    console.log(JSON.stringify(recordBrowserFallback(rawUrl, { reason, kind, ttlMs: ttlHours * 60 * 60 * 1000 }), null, 2));
    return;
  }
  usage();
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
