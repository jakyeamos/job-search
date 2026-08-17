#!/usr/bin/env node
// @ts-check

const ROLE_FAMILY_RULES = [
  { key: 'forward_deployed_creative', pattern: /\bforward[- ]deployed\s+creative\b/i },
  { key: 'enterprise_solutions_engineer', pattern: /\benterprise\s+solutions\s+engineer\b/i },
  { key: 'forward_deployed_engineer', pattern: /\bforward[- ]deployed\s+(?:engineer|software engineer)\b/i },
  { key: 'full_stack_engineer', pattern: /\bfull[- ]stack\s+engineer\b/i },
  { key: 'data_engineer', pattern: /\bdata\s+engineer\b/i },
  { key: 'solutions_engineer', pattern: /\bsolutions\s+engineer\b/i },
  { key: 'software_engineer', pattern: /\bsoftware\s+engineer\b/i },
];

export const DEFAULT_RECOMMENDATIONS_PER_COMPANY = 1;
export const DEFAULT_RECOMMENDATIONS_PER_JOB_FAMILY = 1;

/** @param {unknown} value */
function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** @param {unknown} value */
export function normalizeRecommendationKey(value) {
  return normalizedText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** @param {Record<string, unknown>} item */
export function companyRecommendationKey(item) {
  return normalizeRecommendationKey(item.company) || 'unknown_company';
}

/** @param {unknown} value */
function locationTokens(value) {
  return new Set(normalizedText(value).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1));
}

/** @param {Record<string, unknown>} item */
export function jobFamilyKey(item) {
  const title = normalizedText(item.title);
  for (const rule of ROLE_FAMILY_RULES) {
    if (rule.pattern.test(title)) return rule.key;
  }

  const location = locationTokens(item.location);
  const titleWithoutLocation = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !location.has(token))
    .join(' ');
  return normalizeRecommendationKey(titleWithoutLocation) || normalizeRecommendationKey(item.lane) || 'unknown_role';
}

/** @param {Record<string, unknown>} item */
export function recommendationGroupKey(item) {
  return `${companyRecommendationKey(item)}::${jobFamilyKey(item)}`;
}

/**
 * Select the strongest application candidates while avoiding a scattershot
 * batch against one employer. Callers may provide a comparator when their
 * queue has a richer ranking function.
 * @param {Array<Record<string, unknown>>} items
 * @param {{ limit?: number, maxPerCompany?: number, maxPerJobFamily?: number, compare?: (left: Record<string, unknown>, right: Record<string, unknown>) => number, pinned?: Array<Record<string, unknown>> }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
export function selectApplicationRecommendations(items, options = {}) {
  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(1, Math.floor(Number(options.limit)))
    : Number.MAX_SAFE_INTEGER;
  const maxPerCompany = Number.isFinite(Number(options.maxPerCompany))
    ? Math.max(1, Math.floor(Number(options.maxPerCompany)))
    : DEFAULT_RECOMMENDATIONS_PER_COMPANY;
  const maxPerJobFamily = Number.isFinite(Number(options.maxPerJobFamily))
    ? Math.max(1, Math.floor(Number(options.maxPerJobFamily)))
    : DEFAULT_RECOMMENDATIONS_PER_JOB_FAMILY;
  const compare = options.compare || ((left, right) => Number(right.fitScore || 0) - Number(left.fitScore || 0)
    || String(left.id || '').localeCompare(String(right.id || '')));
  const companyCounts = new Map();
  const familyCounts = new Map();
  const pinned = Array.isArray(options.pinned) ? options.pinned : [];
  const pinnedIds = new Set(pinned.map((item) => item?.id).filter(Boolean));
  const selected = [];

  for (const item of pinned) {
    const company = companyRecommendationKey(item);
    const family = recommendationGroupKey(item);
    selected.push(item);
    companyCounts.set(company, (companyCounts.get(company) || 0) + 1);
    familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
  }

  for (const item of [...items].sort(compare)) {
    if (selected.length >= limit) break;
    if (item?.id && pinnedIds.has(item.id)) continue;
    const company = companyRecommendationKey(item);
    const family = recommendationGroupKey(item);
    if ((companyCounts.get(company) || 0) >= maxPerCompany) continue;
    if ((familyCounts.get(family) || 0) >= maxPerJobFamily) continue;
    selected.push(item);
    companyCounts.set(company, (companyCounts.get(company) || 0) + 1);
    familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
  }

  return selected;
}
