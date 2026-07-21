// @ts-check

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Posting freshness is a queue-lifecycle signal, not proof that an employer
 * closed a role. A stale or archived posting remains in queue history and can
 * reactivate when a trusted source observes it again.
 */
export const POSTING_AGE_POLICY = Object.freeze({
  downrankAfterDays: 14,
  recheckAfterDays: 30,
  staleAfterDays: 45,
  archiveAfterDays: 60,
});

const AGEABLE_STATUSES = new Set(['ready', 'in_review', 'snoozed', 'stale']);

/** @typedef {'fresh'|'aging'|'recheck_due'|'stale'|'archivable'|'unknown'|'archived'} FreshnessState */

/** @param {unknown} value @returns {number|null} */
function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {Record<string, unknown>} item @returns {string|null} */
export function postingAgeReference(item) {
  const candidates = [
    item.lastSeenAt,
    item.lastConfirmedActiveAt,
    item.liveness === 'active' ? item.livenessCheckedAt : null,
    item.firstSeenAt,
    item.postedAt,
    item.discoveredAt,
  ];
  const parsed = candidates.map(timestamp).filter((value) => value !== null);
  return parsed.length ? new Date(Math.max(...parsed)).toISOString() : null;
}

/**
 * @param {Record<string, unknown>} item
 * @param {string} [now]
 * @param {typeof POSTING_AGE_POLICY} [policy]
 * @returns {{ state: FreshnessState, ageDays: number|null, referenceAt: string|null, sourceAlert: boolean }}
 */
export function postingFreshness(item, now = new Date().toISOString(), policy = POSTING_AGE_POLICY) {
  if (String(item.status || '') === 'archived') {
    return { state: 'archived', ageDays: null, referenceAt: postingAgeReference(item), sourceAlert: item.liveness === 'source-alert' };
  }
  const referenceAt = postingAgeReference(item);
  const nowTimestamp = timestamp(now);
  const referenceTimestamp = timestamp(referenceAt);
  if (nowTimestamp === null || referenceTimestamp === null) {
    return { state: 'unknown', ageDays: null, referenceAt, sourceAlert: item.liveness === 'source-alert' };
  }
  const ageDays = Math.max(0, Math.floor((nowTimestamp - referenceTimestamp) / DAY_MS));
  const state = ageDays >= policy.archiveAfterDays
    ? 'archivable'
    : ageDays >= policy.staleAfterDays
      ? 'stale'
      : ageDays >= policy.recheckAfterDays
        ? 'recheck_due'
        : ageDays >= policy.downrankAfterDays
          ? 'aging'
          : 'fresh';
  return { state, ageDays, referenceAt, sourceAlert: item.liveness === 'source-alert' && !item.lastConfirmedActiveAt };
}

/** @param {FreshnessState} state */
export function freshnessPenalty(state) {
  if (state === 'aging') return 0.15;
  if (state === 'recheck_due') return 0.35;
  if (state === 'stale') return 0.75;
  if (state === 'archivable') return 1;
  return 0;
}

/**
 * Apply the time-based lifecycle without deleting queue history. Source
 * failures suspend transitions; callers may still persist the computed
 * freshness metadata for reporting.
 *
 * @param {{ items?: Array<Record<string, unknown>> }} state
 * @param {{ now?: string, sourceScanHealthy?: boolean, policy?: typeof POSTING_AGE_POLICY }} [options]
 * @returns {{ checked: number, fresh: number, aging: number, recheckDue: number, unknown: number, stale: number, archived: number, suspended: number }}
 */
export function applyPostingAging(state, options = {}) {
  const now = options.now || new Date().toISOString();
  const policy = options.policy || POSTING_AGE_POLICY;
  const sourceScanHealthy = options.sourceScanHealthy !== false;
  const summary = { checked: 0, fresh: 0, aging: 0, recheckDue: 0, unknown: 0, stale: 0, archived: 0, suspended: 0 };
  state.items = (Array.isArray(state.items) ? state.items : []).map((item) => {
    if (!AGEABLE_STATUSES.has(String(item.status || ''))) return item;
    summary.checked++;
    const freshness = postingFreshness(item, now, policy);
    if (freshness.state === 'fresh') summary.fresh++;
    else if (freshness.state === 'aging') summary.aging++;
    else if (freshness.state === 'recheck_due') summary.recheckDue++;
    else if (freshness.state === 'unknown') summary.unknown++;

    if (!sourceScanHealthy) {
      summary.suspended++;
      return item;
    }

    const next = {
      ...item,
      freshness: freshness.state,
      freshnessAgeDays: freshness.ageDays,
      freshnessReferenceAt: freshness.referenceAt,
      freshnessUpdatedAt: now,
    };

    if (freshness.state === 'archivable') {
      if (next.status !== 'archived') {
        next.status = 'archived';
        next.archivedAt = now;
        next.archivedReason = 'posting was not observed or positively verified within the age-out window';
        next.selectedForToday = false;
        next.queueRank = null;
        summary.archived++;
      }
      return next;
    }

    // Alert-only URLs are not treated as confirmed closures from age alone.
    // They stop entering the daily selection at the stale threshold and are
    // archived at 60 days unless a new alert reactivates them.
    if (freshness.state === 'stale' && freshness.sourceAlert) {
      next.selectedForToday = false;
      next.queueRank = null;
      summary.stale++;
    } else if (freshness.state === 'stale' && next.status !== 'stale') {
      next.status = 'stale';
      next.staleAt = now;
      next.staleReason = 'posting was not observed or positively verified within the stale window';
      next.selectedForToday = false;
      next.queueRank = null;
      summary.stale++;
    }
    return next;
  });
  return summary;
}
