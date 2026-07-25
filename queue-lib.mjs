// @ts-check

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { buildResumeRequest } from './resume-contract.mjs';
import { freshnessPenalty } from './queue-aging.mjs';
import { normalizeJackJobUrl } from './jackandjill-lib.mjs';
import { selectApplicationRecommendations } from './apply/application-recommendations.mjs';

export const QUEUE_SCHEMA_VERSION = 1;
export const DEFAULT_QUEUE_LIMIT = 10;
export const DEFAULT_CONTACT_DISCOVERY_LIMIT = 20;
export const APPLY_THRESHOLD = 4.0;

const SOURCE_WEIGHTS = {
  'teamwork-online': 1.15,
  teamwork: 1.15,
  yc: 1.1,
  'yc-seed': 1.1,
  gmail: 1.05,
  linkedin: 1.0,
  greenhouse: 1.0,
  lever: 1.0,
  ashby: 1.0,
};

const LANE_RULES = [
  {
    id: 'solutions_forward_deployed',
    terms: ['forward deployed', 'forward-deployed', 'solutions engineer', 'implementation engineer', 'technical consultant', 'customer engineer'],
  },
  {
    id: 'data_analytics',
    terms: ['data engineer', 'analytics engineer', 'data platform', 'analytics', 'etl', 'elt', 'sql', 'snowflake', 'data pipeline'],
  },
  {
    id: 'developer_tools_infrastructure',
    terms: ['developer tools', 'devtools', 'developer experience', 'infrastructure', 'platform engineer', 'ci/cd', 'quality', 'testing', 'observability'],
  },
  {
    id: 'applied_ai_client_delivery',
    terms: ['applied ai', 'ai engineer', 'genai', 'generative ai', 'llm', 'machine learning', 'agent', 'rag', 'copilot'],
  },
  {
    id: 'product_full_stack',
    terms: ['full-stack', 'full stack', 'frontend', 'front-end', 'product engineer', 'web engineer', 'product software'],
  },
  {
    id: 'backend_ai_platform',
    terms: ['backend', 'back-end', 'api', 'serverless', 'distributed systems', 'services', 'python', 'node.js'],
  },
];

const HARD_TITLE_RE = /\b(senior|sr\.?|staff|principal|lead|director|manager|architect|head of|founding)\b/i;
const EXPERIENCE_DQ_RE = /(?:\b[3-9]\+?\s*years?|\b(?:three|four|five|six|seven|eight|nine)\s+years?|minimum\s+(?:of\s+)?[3-9]\s+years?)/i;
const DEFENSE_DQ_RE = /\b(defense|defence|military|clearance|cleared|government|national security|classified|dod|department of defense|armed forces|army|navy|air force|space force|intelligence community)\b/i;
const DEFENSE_CONTRACTOR_RE = /\b(palantir|anduril|lockheed martin|northrop grumman|raytheon|rtx|general dynamics|bae systems|l3harris|leidos|caci|saic|peraton|booz allen|mitre|gdit|amentum|kratos|aerovironment|shield ai|epirus|saronic)\b/i;
const GAMBLING_SECTOR_RE = /\b(gambling|gamble|sports betting|online betting|sportsbook|casino|poker|wagering|lotter(?:y|ies)|daily fantasy(?: sports)?|fantasy sports|real[- ]money gaming|prediction market)\b/i;
const GAMBLING_COMPANY_RE = /\b(prize[ -]?picks|draftkings|fanduel|fanatics sportsbook|betmgm|caesars sportsbook|bet365|betway|pointsbet|unibet|william hill|kindred|flutter|entain|paddy power|roobet|stake\.com|kalshi|polymarket|underdog fantasy)\b/i;
const NON_US_LOCATION_RE = /\b(london|uk|united kingdom|berlin|germany|paris|france|madrid|spain|tokyo|japan|amsterdam|netherlands|singapore|dublin|ireland|toronto|vancouver|montreal|canada|australia|sydney|melbourne|canberra|middle east|dubai|united arab emirates|uae|abu dhabi|saudi arabia|riyadh|india|chennai|hyderabad|bangalore|bengaluru|tamil nadu|telangana|\bind\b|\bare\b|\bsau\b|norway|oslo|south korea|seoul|mexico|brazil|argentina|chile|switzerland|israel|italy|poland|romania|portugal|sweden|stockholm|finland|denmark|belgium|austria|czech|prague|hong kong|taiwan|china|beijing|shenzhen|south africa|nigeria|kenya|egypt|philippines|thailand|vietnam|indonesia|new zealand)\b/i;
const EUROPE_LOCATION_RE = /\b(europe|european union|emea|eu|uk|united kingdom|england|scotland|wales|ireland|france|germany|spain|netherlands|belgium|luxembourg|switzerland|italy|austria|czech(?:ia)?|poland|romania|hungary|slovakia|slovenia|croatia|serbia|bosnia|montenegro|albania|greece|bulgaria|moldova|ukraine|belarus|lithuania|latvia|estonia|sweden|norway|denmark|finland|iceland|portugal|malta|cyprus|turkey|london|berlin|paris|madrid|amsterdam|dublin|stockholm|oslo|prague|vienna|lisbon|barcelona|munich|zurich|milan|copenhagen|helsinki|warsaw|budapest|bucharest)\b/i;
const CANADA_LOCATION_RE = /\b(canada|ontario|toronto|vancouver|montreal|calgary|ottawa|edmonton|quebec|winnipeg|halifax|waterloo|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|labrador)\b/i;
const POSITIVE_ROLE_RE = /\b(software|backend|back-end|full[- ]?stack|data|analytics|ai|ml|machine learning|platform|developer tools|product engineer|solutions|forward[- ]deployed|implementation)\b/i;

/** @param {string} value */
export function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** @param {unknown} value @returns {string|null} */
function isoTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** @param {string} value */
export function normalizeKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** @param {string} value */
export function normalizeUrl(value) {
  const jackUrl = normalizeJackJobUrl(value);
  if (jackUrl) return jackUrl;
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '');
  } catch { return ''; }
}

/** @param {{ url?: string, canonicalUrl?: string, company?: string, title?: string }} candidate */
export function stableQueueId(candidate) {
  const identity = [
    normalizeUrl(candidate.canonicalUrl || candidate.url || ''),
    normalizeKey(candidate.company || ''),
    normalizeKey(candidate.title || ''),
  ].join('|');
  return createHash('sha256').update(identity).digest('hex').slice(0, 20);
}

/** @param {string} url */
export function inferSourceFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('teamworkonline')) return 'teamwork-online';
    if (host.includes('linkedin')) return 'linkedin';
    if (host.includes('wellfound') || host.includes('angel.co')) return 'wellfound';
    if (host.includes('builtin.com')) return 'built-in';
    if (host.includes('handshake')) return 'handshake';
    if (host.includes('greenhouse')) return 'greenhouse';
    if (host.includes('lever.co')) return 'lever';
    if (host.includes('ashbyhq')) return 'ashby';
    if (host.includes('myworkdayjobs')) return 'workday';
    if (host.includes('ycombinator')) return 'yc';
  } catch { /* unknown URL */ }
  return 'manual';
}

/** @param {string} text */
export function parsePipeline(text) {
  const jobs = [];
  for (const rawLine of String(text || '').split('\n')) {
    const match = rawLine.match(/^- \[[ x]\]\s+(https?:\/\/\S+)(?:\s+\|\s*(.*))?$/i);
    if (!match) continue;
    const url = normalizeUrl(match[1]);
    if (!url) continue;
    const cells = (match[2] || '').split(/\s+\|\s+/).map(normalizeText);
    const noteIndex = cells.findIndex((cell) => /^note:/i.test(cell));
    const note = noteIndex >= 0 ? cells[noteIndex].replace(/^note:\s*/i, '') : '';
    const history = note.match(/source:\s*([^;]+)/i)?.[1] || '';
    const rawLocation = cells[2] || '';
    const location = /^\d+(?:\.\d+)?\/5$/.test(rawLocation) ? '' : rawLocation;
    jobs.push({
      url,
      canonicalUrl: url,
      company: cells[0] || '',
      title: cells[1] || 'Job lead',
      location,
      compensation: cells[3] || '',
      note,
      source: history || inferSourceFromUrl(url),
      liveness: 'uncertain',
    });
  }
  return jobs;
}

/** @param {string} text */
export function parseScanHistory(text) {
  const byUrl = new Map();
  const lines = String(text || '').split('\n');
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const url = normalizeUrl(cells[0]);
    if (!url) continue;
    const firstSeenAt = /^\d{4}-\d{2}-\d{2}$/.test(cells[1] || '') ? cells[1] : null;
    byUrl.set(url, {
      source: normalizeText(cells[2]) || inferSourceFromUrl(url),
      postedAt: firstSeenAt,
      firstSeenAt,
      status: normalizeText(cells[5]),
    });
  }
  return byUrl;
}

/** @param {string} root */
export function loadProfile(root) {
  const file = path.join(root, 'config', 'profile.yml');
  if (!existsSync(file)) return {};
  try {
    const parsed = yaml.load(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/** @param {string} root */
export function loadApplications(root) {
  const file = path.join(root, 'data', 'applications.md');
  if (!existsSync(file)) return new Set();
  const keys = new Set();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(normalizeText);
    if (cells.length < 7 || !/^\d+$/.test(cells[1] || '')) continue;
    const company = cells[3] || '';
    const role = cells[4] || '';
    if (company && role) keys.add(`${normalizeKey(company)}::${normalizeKey(role)}`);
  }
  return keys;
}

/** @param {string} value */
function hasAnyLaneTerm(value, terms) {
  const lower = String(value || '').toLowerCase();
  return terms.some((term) => lower.includes(term));
}

/** @param {string} title @param {string} description */
export function selectLane(title, description = '') {
  const text = `${title} ${description}`;
  for (const lane of LANE_RULES) {
    if (hasAnyLaneTerm(text, lane.terms)) return lane.id;
  }
  return 'backend_ai_platform';
}

/** @param {string} source */
function sourceWeight(source) {
  const lower = String(source || '').toLowerCase();
  const match = Object.entries(SOURCE_WEIGHTS).find(([key]) => lower.includes(key));
  return match ? match[1] : 1;
}

/** @param {Record<string, unknown>} candidate */
export function isGamblingCandidate(candidate) {
  const searchable = [
    candidate.title,
    candidate.company,
    candidate.description,
    candidate.url,
    candidate.canonicalUrl,
    candidate.sourceUrl,
  ].map((value) => normalizeText(String(value || ''))).join(' ');
  const companyAndUrls = [candidate.company, candidate.url, candidate.canonicalUrl, candidate.sourceUrl]
    .map((value) => normalizeText(String(value || '')))
    .join(' ');
  return GAMBLING_SECTOR_RE.test(searchable) || GAMBLING_COMPANY_RE.test(companyAndUrls);
}

/**
 * @param {{ title?: string, company?: string, location?: string, description?: string, source?: string, liveness?: string, url?: string }} candidate
 * @param {Record<string, unknown>} profile
 * @returns {{ score: number, eligible: boolean, status: 'ready'|'in_review'|'excluded', confidence: 'high'|'medium'|'low', reasons: string[], blockers: string[], lane: string }}
 */
export function scoreCandidate(candidate, profile = {}) {
  const title = normalizeText(candidate.title);
  const description = normalizeText(candidate.description);
  const location = normalizeText(candidate.location);
  const company = normalizeText(candidate.company);
  const text = `${title} ${description} ${location} ${company}`;
  const blockers = [];
  if (HARD_TITLE_RE.test(title)) blockers.push('seniority title suggests a role above the target level');
  if (EXPERIENCE_DQ_RE.test(`${title} ${description}`)) blockers.push('posting states a 3+ year experience floor');
  if (DEFENSE_DQ_RE.test(text)) blockers.push('defense, intelligence, clearance, or government-mission role');
  if (DEFENSE_CONTRACTOR_RE.test(company)) blockers.push('defense-contractor employer is outside the target search');
  if (isGamblingCandidate(candidate)) blockers.push('gambling, betting, casino, or fantasy-sports employer or role is outside the target search');
  if (NON_US_LOCATION_RE.test(location)
    && !/remote\s*(us|united states)/i.test(location)
    && !EUROPE_LOCATION_RE.test(location)
    && !CANADA_LOCATION_RE.test(location)) {
    blockers.push('location appears outside the US/Europe/Canada target search');
  }
  if (blockers.length > 0) {
    return { score: 0, eligible: false, status: 'excluded', confidence: 'low', reasons: [], blockers, lane: selectLane(title, description) };
  }

  const targetRoles = Array.isArray(profile.target_roles?.primary)
    ? profile.target_roles.primary.filter((role) => typeof role === 'string')
    : [];
  const targetMatch = targetRoles.some((role) => title.toLowerCase().includes(role.toLowerCase())) || POSITIVE_ROLE_RE.test(title);
  const reasons = [];
  let score = 2.8;
  if (targetMatch) { score += 0.9; reasons.push('title matches a target technical role'); }
  if (/\b(backend|back-end|api|platform|service|serverless|distributed)\b/i.test(title)) {
    score += 0.35; reasons.push('backend/platform signal');
  }
  if (/\b(ai|ml|machine learning|llm|genai|data|analytics|sql|pipeline)\b/i.test(text)) {
    score += 0.35; reasons.push('AI/data signal');
  }
  if (/\b(remote|united states|us|new york|nyc|chicago|seattle|buffalo|san francisco|austin|boston)\b/i.test(location)
    || EUROPE_LOCATION_RE.test(location)
    || CANADA_LOCATION_RE.test(location)) {
    score += 0.2; reasons.push('location appears compatible');
  }
  if (candidate.liveness === 'active') { score += 0.25; reasons.push('public URL passed liveness'); }
  if (description) { score += 0.2; reasons.push('job description is available for review'); }
  score = Math.min(5, Math.round(score * 10) / 10);

  const confidence = candidate.liveness === 'source-alert'
    ? 'low'
    : candidate.liveness === 'active' && description
      ? 'high'
      : candidate.liveness === 'active'
        ? 'medium'
        : 'low';
  const alertOnly = candidate.liveness === 'source-alert';
  const status = score >= APPLY_THRESHOLD && candidate.liveness === 'active' && !alertOnly
    ? 'ready'
    : score >= 3.0
      ? 'in_review'
      : 'excluded';
  return {
    score,
    eligible: status !== 'excluded',
    status,
    confidence,
    reasons: reasons.length ? reasons : ['technical role signal is present but evidence is limited'],
    blockers: [],
    lane: selectLane(title, description),
  };
}

/** @param {Record<string, unknown>} candidate @param {Record<string, unknown>} profile @param {string} root */
export function buildQueueItem(candidate, profile, root) {
  const evaluation = scoreCandidate(candidate, profile);
  const canonicalUrl = normalizeUrl(String(candidate.canonicalUrl || candidate.url || ''));
  const source = normalizeText(String(candidate.source || inferSourceFromUrl(canonicalUrl))).toLowerCase() || 'manual';
  const now = new Date().toISOString();
  const configuredCompanyWebsite = normalizeText(String(candidate.companyWebsite || candidate.companyUrl || candidate.employerUrl || ''));
  const careersUrlDomain = normalizeText(String(candidate.careersUrlDomain || ''));
  const observedAt = isoTimestamp(candidate.observedAt) || isoTimestamp(candidate.lastSeenAt);
  const firstSeenAt = isoTimestamp(candidate.firstSeenAt)
    || isoTimestamp(candidate.postedAt)
    || isoTimestamp(candidate.discoveredAt)
    || now;
  const item = {
    id: stableQueueId({ ...candidate, canonicalUrl }),
    source,
    sourceLabel: candidate.sourceLabel || source,
    sourceMessageId: candidate.sourceMessageId || null,
    sourceUrl: candidate.sourceUrl || canonicalUrl,
    canonicalUrl,
    applyUrl: candidate.applyUrl || canonicalUrl,
    title: normalizeText(String(candidate.title || 'Job lead')),
    company: normalizeText(String(candidate.company || '')),
    companyWebsite: configuredCompanyWebsite || (careersUrlDomain ? `https://${careersUrlDomain}` : null),
    location: normalizeText(String(candidate.location || '')),
    description: normalizeText(String(candidate.description || '')),
    postedAt: candidate.postedAt || null,
    discoveredAt: candidate.discoveredAt || now,
    firstSeenAt,
    lastSeenAt: observedAt,
    lastConfirmedActiveAt: candidate.liveness === 'active'
      ? (isoTimestamp(candidate.lastConfirmedActiveAt) || observedAt)
      : isoTimestamp(candidate.lastConfirmedActiveAt),
    liveness: candidate.liveness || 'uncertain',
    fitScore: evaluation.score,
    fitConfidence: evaluation.confidence,
    fitReasons: evaluation.reasons,
    blockers: evaluation.blockers,
    lane: evaluation.lane,
    outreach: {
      suggested: evaluation.status === 'ready',
      searchQuery: `${normalizeText(String(candidate.company || ''))} ${normalizeText(String(candidate.title || ''))} recruiter hiring manager`,
    },
    status: evaluation.status,
    queueRank: null,
    selectedForToday: false,
    updatedAt: new Date().toISOString(),
  };
  const resume = buildResumeRequest(item, root);
  return {
    ...item,
    resumeContractVersion: resume.contractVersion,
    resumeJobKey: resume.jobKey,
    resumeManifest: resume.manifestPath,
    resumeArtifact: resume.artifactPath,
    resumeFormat: resume.paperFormat,
    resumeProjects: resume.selectedProjects,
    resumeStatus: existsSync(resume.artifactPath)
      ? 'contract-managed; canonical artifact available'
      : 'contract-managed; tailored artifact required',
  };
}

/** @param {Record<string, unknown>} item */
function eligibleForSelection(item) {
  if (!item
    || item.status === 'excluded'
    || item.status === 'stale'
    || item.status === 'archived'
    || item.status === 'applied'
    || item.status === 'skipped'
    || ['stale', 'archivable'].includes(String(item.freshness || ''))) return false;
  if (item.status === 'snoozed') {
    return typeof item.snoozeUntil !== 'string' || item.snoozeUntil <= new Date().toISOString();
  }
  return item.status === 'ready' || item.status === 'in_review';
}

/** @param {Record<string, unknown>} item */
function sortScore(item) {
  const readiness = item.status === 'ready' ? 10 : 0;
  const weight = sourceWeight(String(item.source || ''));
  const postedFreshness = item.postedAt ? new Date(String(item.postedAt)).getTime() / 1e12 : 0;
  return readiness + Number(item.fitScore || 0) * weight + postedFreshness - freshnessPenalty(String(item.freshness || 'unknown'));
}

/**
 * Pick the roles worth showing today: eligible, at or above the fit floor, highest
 * sortScore first, capped for company and role-family diversity.
 * @param {Array<Record<string, unknown>>} items
 * @param {{ limit?: number, minFitScore?: number, maxPerCompany?: number, maxPerJobFamily?: number, pinned?: Array<Record<string, unknown>> }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
export function selectDailyQueue(items, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || DEFAULT_QUEUE_LIMIT)));
  const minFitScore = Number.isFinite(Number(options.minFitScore))
    ? Number(options.minFitScore)
    : APPLY_THRESHOLD;
  const pinned = Array.isArray(options.pinned) ? options.pinned : [];
  const pinnedIds = new Set(pinned.map((item) => item?.id).filter(Boolean));
  const candidates = [...items]
    .filter((item) => !(item?.id && pinnedIds.has(item.id)))
    .filter(eligibleForSelection)
    .filter((item) => Number(item.fitScore || 0) >= minFitScore)
    .sort((a, b) => sortScore(b) - sortScore(a));
  return selectApplicationRecommendations(candidates, {
    limit,
    maxPerCompany: options.maxPerCompany,
    maxPerJobFamily: options.maxPerJobFamily,
    pinned,
    compare: (left, right) => sortScore(right) - sortScore(left),
  });
}

/**
 * Refill today's selection back to `limit` from the already-scored pool, keeping the
 * roles the user is already looking at and renumbering ranks contiguously.
 * @param {Record<string, unknown>} state
 * @param {{ limit?: number, minFitScore?: number, maxPerCompany?: number, maxPerJobFamily?: number }} [options]
 * @returns {{ state: Record<string, unknown>, added: number, shortBy: number }}
 */
export function topUpSelection(state, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || DEFAULT_QUEUE_LIMIT)));
  const items = Array.isArray(state?.items) ? state.items : [];
  const pinned = items
    .filter((item) => item.selectedForToday)
    .sort((left, right) => Number(left.queueRank || 999) - Number(right.queueRank || 999));
  const selected = pinned.length >= limit ? pinned : selectDailyQueue(items, {
    limit,
    minFitScore: options.minFitScore,
    maxPerCompany: options.maxPerCompany,
    maxPerJobFamily: options.maxPerJobFamily,
    pinned,
  });
  const ranks = new Map(selected.map((item, index) => [item.id, index + 1]));
  const nextItems = items.map((item) => ({
    ...item,
    selectedForToday: ranks.has(item.id),
    queueRank: ranks.get(item.id) || null,
  }));
  return {
    state: { ...state, items: nextItems },
    added: Math.max(0, selected.length - pinned.length),
    shortBy: Math.max(0, limit - selected.length),
  };
}

/**
 * @param {Array<Record<string, unknown>>} candidates
 * @param {Record<string, unknown>} previous
 * @param {{ limit?: number, now?: string, retainUnseen?: boolean, minFitScore?: number, maxPerCompany?: number, maxPerJobFamily?: number }} [options]
 */
export function buildQueue(candidates, previous = {}, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || DEFAULT_QUEUE_LIMIT)));
  const now = options.now || new Date().toISOString();
  const previousItems = new Map(Array.isArray(previous.items) ? previous.items.map((item) => [item.id, item]) : []);
  const merged = new Map();
  for (const candidate of candidates) {
    if (!candidate?.id) continue;
    const old = previousItems.get(candidate.id);
    const observedAt = isoTimestamp(candidate.observedAt) || isoTimestamp(candidate.lastSeenAt);
    const observedNow = observedAt !== null || (candidate.liveness === 'active' && isoTimestamp(candidate.livenessCheckedAt) !== null);
    const snoozeExpired = old?.status === 'snoozed'
      && (!old.snoozeUntil || old.snoozeUntil <= now);
    let preservedStatus = candidate.status;
    if (old && ['applied', 'skipped'].includes(String(old.status || ''))) preservedStatus = old.status;
    if (old?.status === 'snoozed' && !snoozeExpired) preservedStatus = old.status;
    if (old && ['stale', 'archived'].includes(String(old.status || '')) && !observedNow) preservedStatus = old.status;
    const mergedItem = {
      ...candidate,
      ...(old || {}),
      ...candidate,
      status: preservedStatus,
      snoozeUntil: old?.snoozeUntil || candidate.snoozeUntil || null,
      companyWebsite: candidate.companyWebsite || old?.companyWebsite || null,
      updatedAt: now,
    };
    const oldOutreach = old?.outreach && typeof old.outreach === 'object' ? old.outreach : null;
    const candidateOutreach = candidate.outreach && typeof candidate.outreach === 'object' ? candidate.outreach : null;
    if (oldOutreach?.discovery && !candidateOutreach?.discovery) {
      mergedItem.outreach = { ...candidateOutreach, discovery: oldOutreach.discovery };
    }
    if (old?.firstSeenAt) mergedItem.firstSeenAt = old.firstSeenAt;
    if (!observedNow && old?.lastSeenAt) mergedItem.lastSeenAt = old.lastSeenAt;
    if (!observedNow && old?.lastConfirmedActiveAt) mergedItem.lastConfirmedActiveAt = old.lastConfirmedActiveAt;
    if (!observedNow && old?.freshness) {
      mergedItem.freshness = old.freshness;
      mergedItem.freshnessAgeDays = old.freshnessAgeDays ?? null;
      mergedItem.freshnessReferenceAt = old.freshnessReferenceAt || null;
      mergedItem.freshnessUpdatedAt = old.freshnessUpdatedAt || null;
    }
    if (observedNow && old && ['stale', 'archived'].includes(String(old.status || ''))) {
      delete mergedItem.staleAt;
      delete mergedItem.staleReason;
      delete mergedItem.archivedAt;
      delete mergedItem.archivedReason;
      delete mergedItem.freshness;
      delete mergedItem.freshnessAgeDays;
      delete mergedItem.freshnessReferenceAt;
      delete mergedItem.freshnessUpdatedAt;
      mergedItem.reactivatedAt = now;
    }
    if (observedNow && observedAt) mergedItem.lastSeenAt = observedAt;
    if (observedNow && candidate.liveness === 'active') mergedItem.lastConfirmedActiveAt = observedAt || isoTimestamp(candidate.livenessCheckedAt) || old?.lastConfirmedActiveAt || null;
    merged.set(candidate.id, mergedItem);
  }
  for (const old of previousItems.values()) {
    if (!merged.has(old.id) && options.retainUnseen !== false) merged.set(old.id, old);
  }

  const selected = selectDailyQueue([...merged.values()], {
    limit,
    minFitScore: options.minFitScore,
    maxPerCompany: options.maxPerCompany,
    maxPerJobFamily: options.maxPerJobFamily,
  });
  const selectedIds = new Set(selected.map((item) => item.id));
  const items = [...merged.values()].map((item) => ({
    ...item,
    selectedForToday: selectedIds.has(item.id),
    queueRank: selectedIds.has(item.id) ? selected.findIndex((entry) => entry.id === item.id) + 1 : null,
  }));
  return {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    account: { gmail: 'jakyejobs@gmail.com' },
    generatedAt: now,
    lastRun: previous.lastRun || null,
    items,
  };
}

/** @param {string} file */
export function readQueueState(file) {
  if (!existsSync(file)) return { schemaVersion: QUEUE_SCHEMA_VERSION, account: { gmail: 'jakyejobs@gmail.com' }, items: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object'
      ? { account: { gmail: 'jakyejobs@gmail.com' }, ...parsed }
      : { schemaVersion: QUEUE_SCHEMA_VERSION, account: { gmail: 'jakyejobs@gmail.com' }, items: [] };
  } catch { return { schemaVersion: QUEUE_SCHEMA_VERSION, account: { gmail: 'jakyejobs@gmail.com' }, items: [] }; }
}

/** @param {string} file @param {Record<string, unknown>} state */
export function writeQueueState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/** @param {string} value */
function markdown(value) {
  return normalizeText(value).replace(/[|\r\n]/g, ' ');
}

/** @param {Record<string, unknown>} item */
function contactDiscoveryMarkdown(item) {
  const discovery = item.outreach?.discovery;
  if (!discovery || typeof discovery !== 'object') return '- Email discovery: queued on the next refresh';
  const contacts = Array.isArray(discovery.contacts) ? discovery.contacts : [];
  const hypotheses = Array.isArray(discovery.emailHypotheses) ? discovery.emailHypotheses : [];
  const observed = contacts
    .filter((contact) => contact && typeof contact === 'object' && contact.email)
    .map((contact) => markdown(`${contact.name || 'Contact'} <${contact.email}>`));
  const inferred = hypotheses
    .filter((hypothesis) => hypothesis && typeof hypothesis === 'object' && hypothesis.email)
    .map((hypothesis) => markdown(`${hypothesis.name || 'Named candidate'} <${hypothesis.email}> (unverified convention hypothesis)`));
  const entries = [...observed, ...inferred].slice(0, 10);
  if (!entries.length) return `- Email discovery: ${markdown(discovery.status || 'no contacts')} — ${markdown(discovery.reason || 'no email candidate recorded')}`;
  return `- Email candidates: ${entries.join('; ')}`;
}

/** @param {Record<string, unknown>} state */
export function renderQueueMarkdown(state) {
  const selected = Array.isArray(state.items)
    ? state.items.filter((item) => item.selectedForToday).sort((a, b) => Number(a.queueRank || 999) - Number(b.queueRank || 999))
    : [];
  const run = state.lastRun || {};
  const lines = [
    '# Daily Application Queue',
    '',
    `Generated: ${state.generatedAt || 'unknown'}`,
    `Target Gmail: ${state.account?.gmail || 'jakyejobs@gmail.com'}`,
    `Last refresh: ${run.at || 'unknown'}${run.scheduled ? ' (scheduled)' : ''}`,
    '',
  ];
  if (Array.isArray(run.errors) && run.errors.length) {
    lines.push('## Source warnings', '', ...run.errors.map((error) => `- ${markdown(error)}`), '');
  }
  lines.push('## Today', '');
  if (!selected.length) lines.push('No qualified roles are queued right now.', '');
  for (const item of selected) {
    lines.push(
      `### ${item.queueRank}. ${markdown(item.title)} — ${markdown(item.company) || 'Company not parsed'}`,
      `- Status: ${item.status} | score ${Number(item.fitScore || 0).toFixed(1)}/5 | ${item.fitConfidence} confidence`,
      `- Source: ${markdown(item.sourceLabel || item.source)} | liveness: ${item.liveness}`,
      `- Lane: ${item.lane} | resume: ${item.resumeStatus}`,
      `- Apply: ${item.applyUrl || item.canonicalUrl}`,
      `- Why: ${(item.fitReasons || []).map(markdown).join('; ') || 'Fit review needed'}`,
      item.outreach?.suggested ? `- Optional outreach search: ${markdown(item.outreach.searchQuery)}` : '- Outreach: optional',
      contactDiscoveryMarkdown(item),
      '',
    );
  }
  lines.push('## Controls', '', '- Run `node queue.mjs clear` to review, open, apply, skip, or snooze roles.', '- Automatic submission is separate, revocable, policy-gated, and uses `node application-queue.mjs run`.', '');
  return lines.join('\n');
}

/** @param {Record<string, unknown>} item */
export function applicationKey(item) {
  return `${normalizeKey(item.company || '')}::${normalizeKey(item.title || '')}`;
}
