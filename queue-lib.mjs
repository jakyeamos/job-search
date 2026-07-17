// @ts-check

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

export const QUEUE_SCHEMA_VERSION = 1;
export const DEFAULT_QUEUE_LIMIT = 10;
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
const NON_US_LOCATION_RE = /\b(london|uk|united kingdom|berlin|germany|paris|france|madrid|spain|tokyo|japan|amsterdam|netherlands|singapore|dublin|ireland|toronto|vancouver|montreal|canada|australia|sydney|melbourne|canberra|middle east|dubai|united arab emirates|uae|abu dhabi|saudi arabia|riyadh|india|chennai|hyderabad|bangalore|bengaluru|tamil nadu|telangana|\bind\b|\bare\b|\bsau\b|norway|oslo|south korea|seoul|mexico|brazil|argentina|chile|switzerland|israel|italy|poland|romania|portugal|sweden|stockholm|finland|denmark|belgium|austria|czech|prague|hong kong|taiwan|china|beijing|shenzhen|south africa|nigeria|kenya|egypt|philippines|thailand|vietnam|indonesia|new zealand)\b/i;
const EUROPE_LOCATION_RE = /\b(europe|european union|emea|eu|uk|united kingdom|england|scotland|wales|ireland|france|germany|spain|netherlands|belgium|luxembourg|switzerland|italy|austria|czech(?:ia)?|poland|romania|hungary|slovakia|slovenia|croatia|serbia|bosnia|montenegro|albania|greece|bulgaria|moldova|ukraine|belarus|lithuania|latvia|estonia|sweden|norway|denmark|finland|iceland|portugal|malta|cyprus|turkey|london|berlin|paris|madrid|amsterdam|dublin|stockholm|oslo|prague|vienna|lisbon|barcelona|munich|zurich|milan|copenhagen|helsinki|warsaw|budapest|bucharest)\b/i;
const CANADA_LOCATION_RE = /\b(canada|ontario|toronto|vancouver|montreal|calgary|ottawa|edmonton|quebec|winnipeg|halifax|waterloo|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|labrador)\b/i;
const POSITIVE_ROLE_RE = /\b(software|backend|back-end|full[- ]?stack|data|analytics|ai|ml|machine learning|platform|developer tools|product engineer|solutions|forward[- ]deployed|implementation)\b/i;

/** @param {string} value */
export function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** @param {string} value */
export function normalizeKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** @param {string} value */
export function normalizeUrl(value) {
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
    byUrl.set(url, {
      source: normalizeText(cells[2]) || inferSourceFromUrl(url),
      postedAt: /^\d{4}-\d{2}-\d{2}$/.test(cells[1] || '') ? cells[1] : null,
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
  const basePdf = path.join(root, 'output', 'Jakye_Amos_Canonical_Base_Resume.pdf');
  const resumeArtifact = existsSync(basePdf) ? basePdf : path.join(root, 'cv.md');
  const source = normalizeText(String(candidate.source || inferSourceFromUrl(canonicalUrl))).toLowerCase() || 'manual';
  return {
    id: stableQueueId({ ...candidate, canonicalUrl }),
    source,
    sourceLabel: candidate.sourceLabel || source,
    sourceMessageId: candidate.sourceMessageId || null,
    sourceUrl: candidate.sourceUrl || canonicalUrl,
    canonicalUrl,
    applyUrl: candidate.applyUrl || canonicalUrl,
    title: normalizeText(String(candidate.title || 'Job lead')),
    company: normalizeText(String(candidate.company || '')),
    location: normalizeText(String(candidate.location || '')),
    description: normalizeText(String(candidate.description || '')),
    postedAt: candidate.postedAt || null,
    discoveredAt: candidate.discoveredAt || new Date().toISOString(),
    liveness: candidate.liveness || 'uncertain',
    fitScore: evaluation.score,
    fitConfidence: evaluation.confidence,
    fitReasons: evaluation.reasons,
    blockers: evaluation.blockers,
    lane: evaluation.lane,
    resumeArtifact,
    resumeStatus: 'canonical-base; lane PDFs pending Amazon update approval',
    outreach: {
      suggested: evaluation.status === 'ready',
      searchQuery: `${normalizeText(String(candidate.company || ''))} ${normalizeText(String(candidate.title || ''))} recruiter hiring manager`,
    },
    status: evaluation.status,
    queueRank: null,
    selectedForToday: false,
    updatedAt: new Date().toISOString(),
  };
}

/** @param {Record<string, unknown>} item */
function eligibleForSelection(item) {
  if (!item || item.status === 'excluded' || item.status === 'stale' || item.status === 'applied' || item.status === 'skipped') return false;
  if (item.status === 'snoozed') {
    return typeof item.snoozeUntil !== 'string' || item.snoozeUntil <= new Date().toISOString();
  }
  return item.status === 'ready' || item.status === 'in_review';
}

/** @param {Record<string, unknown>} item */
function sortScore(item) {
  const readiness = item.status === 'ready' ? 10 : 0;
  const weight = sourceWeight(String(item.source || ''));
  const freshness = item.postedAt ? new Date(String(item.postedAt)).getTime() / 1e12 : 0;
  return readiness + Number(item.fitScore || 0) * weight + freshness;
}

/** @param {Record<string, unknown>} item */
function selectionIdentity(item) {
  const company = normalizeKey(String(item.company || ''));
  const title = normalizeKey(String(item.title || ''));
  const location = normalizeKey(String(item.location || ''));
  if (!company || !title) return `item:${String(item.id || '')}`;
  return `role:${company}|${title}|${location}`;
}

/**
 * @param {Array<Record<string, unknown>>} candidates
 * @param {Record<string, unknown>} previous
 * @param {{ limit?: number, now?: string }} [options]
 */
export function buildQueue(candidates, previous = {}, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || DEFAULT_QUEUE_LIMIT)));
  const now = options.now || new Date().toISOString();
  const previousItems = new Map(Array.isArray(previous.items) ? previous.items.map((item) => [item.id, item]) : []);
  const merged = new Map();
  for (const candidate of candidates) {
    if (!candidate?.id) continue;
    const old = previousItems.get(candidate.id);
    const snoozeExpired = old?.status === 'snoozed'
      && (!old.snoozeUntil || old.snoozeUntil <= now);
    const preservedStatus = old && ['applied', 'skipped', 'snoozed'].includes(old.status) && !snoozeExpired
      ? old.status
      : candidate.status;
    merged.set(candidate.id, {
      ...candidate,
      ...(old || {}),
      ...candidate,
      status: preservedStatus,
      snoozeUntil: old?.snoozeUntil || candidate.snoozeUntil || null,
      updatedAt: now,
    });
  }
  for (const old of previousItems.values()) {
    if (!merged.has(old.id) && ['applied', 'skipped', 'snoozed'].includes(old.status)) merged.set(old.id, old);
  }

  const selectedIdentities = new Set();
  const selected = [...merged.values()]
    .filter(eligibleForSelection)
    .sort((a, b) => sortScore(b) - sortScore(a))
    .filter((item) => {
      const identity = selectionIdentity(item);
      if (selectedIdentities.has(identity)) return false;
      selectedIdentities.add(identity);
      return true;
    })
    .slice(0, limit);
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
      '',
    );
  }
  lines.push('## Controls', '', '- Run `node queue.mjs clear` to review, open, apply, skip, or snooze roles.', '- Applications are never submitted automatically.', '');
  return lines.join('\n');
}

/** @param {Record<string, unknown>} item */
export function applicationKey(item) {
  return `${normalizeKey(item.company || '')}::${normalizeKey(item.title || '')}`;
}
