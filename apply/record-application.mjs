import { appendFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';

import { applicationKey, loadApplications } from '../queue-lib.mjs';

/** @param {string} root @param {Record<string, unknown>} item */
export function recordApplication(root, item) {
  const file = path.join(root, 'data', 'applications.md');
  if (!existsSync(file)) return { recorded: false, reason: 'data/applications.md is missing' };
  const existing = loadApplications(root);
  if (existing.has(applicationKey(item))) return { recorded: false, reason: 'company/role already exists in applications.md' };
  const text = readFileSync(file, 'utf8');
  const numbers = [...text.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((match) => Number(match[1]));
  const next = numbers.length ? Math.max(...numbers) + 1 : 1;
  const score = Number(item.fitScore || 0).toFixed(1);
  const line = `| ${next} | ${new Date().toISOString().slice(0, 10)} | ${escapeTable(item.company)} | ${escapeTable(item.title)} | ${score}/5 | Applied | ❌ | — | Queue applied: ${escapeTable(item.source)}; ${escapeTable(item.applyUrl || item.canonicalUrl)} |\n`;
  appendFileSync(file, text.endsWith('\n') ? line : `\n${line}`, 'utf8');
  return { recorded: true, reason: `added tracker row #${next}` };
}

/** @param {unknown} value */
function escapeTable(value) { return String(value || '').replace(/[|\r\n]/g, ' '); }
