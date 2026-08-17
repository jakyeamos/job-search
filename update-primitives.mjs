import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';

export function safeRelativePath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const relative = normalize(value).replaceAll('\\', '/').replace(/^\.\//, '');
  if (relative === '..' || relative.startsWith('../') || relative.split('/').includes('..')) {
    throw new Error(`${label} escapes the repository: ${value}`);
  }
  return relative;
}

export function matchesPath(path, rule) {
  const normalizedRule = safeRelativePath(rule, 'path rule');
  return normalizedRule.endsWith('/') ? path.startsWith(normalizedRule) : path === normalizedRule;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sameState(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'absent') return true;
  if (a.kind !== 'file') return false;
  return a.hash === b.hash && a.mode === b.mode;
}
