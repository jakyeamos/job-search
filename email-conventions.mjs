// @ts-check

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'live.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com',
]);
const GENERIC_MAILBOX_RE = /^(?:careers?|jobs?|recruit(?:ing|ment)|talent|hiring|people|hr|humanresources|employment)(?:[+._-].*)?$/i;
const PUBLIC_SOURCE_TYPES = new Set(['company-site', 'job-posting', 'public-profile', 'application-contact']);
const MAX_EVIDENCE_URLS = 8;
const MAX_HYPOTHESES = 6;

/** @param {unknown} value */
function stringValue(value) { return typeof value === 'string' ? value.trim() : ''; }

/** @param {string} value */
function lower(value) { return value.trim().toLowerCase(); }

/** @param {string} value */
function ascii(value) {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** @param {string} name */
function nameTokens(name) {
  return name
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/** @param {string} name */
function isUsableName(name) {
  const normalized = lower(name);
  return Boolean(normalized)
    && !/^(?:recruiting team|hiring team|talent team|hr|human resources|people team)$/i.test(normalized)
    && nameTokens(name).length >= 2;
}

/** @param {string} email */
function emailParts(email) {
  const [local, domain] = lower(email).split('@');
  if (!local || !domain || FREE_EMAIL_DOMAINS.has(domain)) return null;
  if (GENERIC_MAILBOX_RE.test(local)) return null;
  if (!/^[a-z0-9][a-z0-9._%+-]*$/.test(local)) return null;
  return { local, domain };
}

/** @param {Record<string, unknown>} contact */
function evidenceUrl(contact) {
  return stringValue(contact.sourceUrl || contact.emailSourceUrl || contact.profileUrl);
}

/** @param {Record<string, unknown>} contact */
function conventionSample(contact) {
  const name = stringValue(contact.name);
  const email = stringValue(contact.email);
  const sourceType = lower(contact.sourceType || contact.source || '');
  const sourceUrl = evidenceUrl(contact);
  const parts = emailParts(email);
  if (!isUsableName(name) || !parts || contact.emailVerified !== true || contact.guessed === true || contact.private === true) return null;
  if (!PUBLIC_SOURCE_TYPES.has(sourceType) || !sourceUrl) return null;
  return {
    name,
    tokens: nameTokens(name),
    local: parts.local,
    domain: parts.domain,
    sourceUrl,
    sourceType,
  };
}

const PATTERNS = [
  { id: 'first.last', render: (tokens) => `${tokens[0]}.${tokens.at(-1)}` },
  { id: 'first_last', render: (tokens) => `${tokens[0]}_${tokens.at(-1)}` },
  { id: 'first-last', render: (tokens) => `${tokens[0]}-${tokens.at(-1)}` },
  { id: 'firstlast', render: (tokens) => `${tokens[0]}${tokens.at(-1)}` },
  { id: 'flast', render: (tokens) => `${tokens[0][0]}${tokens.at(-1)}` },
  { id: 'firstl', render: (tokens) => `${tokens[0]}${tokens.at(-1)[0]}` },
  { id: 'f.last', render: (tokens) => `${tokens[0][0]}.${tokens.at(-1)}` },
  { id: 'first.l', render: (tokens) => `${tokens[0]}.${tokens.at(-1)[0]}` },
  { id: 'last.first', render: (tokens) => `${tokens.at(-1)}.${tokens[0]}` },
  { id: 'lastfirst', render: (tokens) => `${tokens.at(-1)}${tokens[0]}` },
  { id: 'lastf', render: (tokens) => `${tokens.at(-1)}${tokens[0][0]}` },
  { id: 'first', render: (tokens) => tokens[0] },
  { id: 'last', render: (tokens) => tokens.at(-1) },
];

/** @param {string} pattern */
function patternDefinition(pattern) {
  return PATTERNS.find((candidate) => candidate.id === pattern) || null;
}

/** @param {Array<Record<string, unknown>>} contacts @param {{minSamples?: number}} [options] */
export function inferEmailConventions(contacts, options = {}) {
  const configuredMinimum = Number(options.minSamples);
  const minSamples = Number.isInteger(configuredMinimum) && configuredMinimum >= 2 ? configuredMinimum : 2;
  const groups = new Map();
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    if (!contact || typeof contact !== 'object' || Array.isArray(contact)) continue;
    const sample = conventionSample(/** @type {Record<string, unknown>} */ (contact));
    if (!sample) continue;
    const key = `${sample.domain}|${ascii(sample.name)}`;
    const domainSamples = groups.get(sample.domain) || new Map();
    if (!domainSamples.has(key)) domainSamples.set(key, sample);
    groups.set(sample.domain, domainSamples);
  }

  const conventions = [];
  for (const [domain, domainSamples] of groups) {
    const samples = [...domainSamples.values()];
    if (samples.length < minSamples) continue;
    const ranked = PATTERNS.map((pattern) => {
      const matchingSamples = samples.filter((sample) => pattern.render(sample.tokens) === sample.local);
      return {
        pattern,
        matchingSamples,
        sourceUrls: [...new Set(matchingSamples.map((sample) => sample.sourceUrl))],
      };
    })
      .filter((entry) => entry.matchingSamples.length >= minSamples && entry.sourceUrls.length >= 2)
      .sort((left, right) => right.matchingSamples.length - left.matchingSamples.length
        || right.sourceUrls.length - left.sourceUrls.length
        || left.pattern.id.localeCompare(right.pattern.id));
    if (!ranked.length) continue;
    const best = ranked[0];
    const tied = ranked.filter((entry) => entry.matchingSamples.length === best.matchingSamples.length
      && entry.sourceUrls.length === best.sourceUrls.length);
    if (tied.length !== 1) continue;
    const coverage = best.matchingSamples.length / samples.length;
    const confidence = coverage === 1 && best.matchingSamples.length >= 3 ? 'high' : 'provisional';
    conventions.push({
      domain,
      pattern: best.pattern.id,
      confidence,
      sampleCount: best.matchingSamples.length,
      observedSampleCount: samples.length,
      coverage: Number(coverage.toFixed(2)),
      sourceCount: best.sourceUrls.length,
      evidenceUrls: best.sourceUrls.slice(0, MAX_EVIDENCE_URLS),
      sampleNames: best.matchingSamples.map((sample) => sample.name).slice(0, MAX_EVIDENCE_URLS),
      verificationState: 'public-pattern-observed',
      sendable: false,
    });
  }
  return conventions.sort((left, right) => right.coverage - left.coverage
    || right.sampleCount - left.sampleCount
    || left.domain.localeCompare(right.domain));
}

/** @param {Array<Record<string, unknown>>} conventions @param {Array<Record<string, unknown>>} candidates @param {{maxHypotheses?: number}} [options] */
export function buildEmailHypotheses(conventions, candidates, options = {}) {
  const configuredMaximum = Number(options.maxHypotheses);
  const maxHypotheses = Number.isInteger(configuredMaximum) && configuredMaximum > 0 ? configuredMaximum : MAX_HYPOTHESES;
  const hypotheses = [];
  const seen = new Set();
  for (const convention of Array.isArray(conventions) ? conventions : []) {
    if (!convention || typeof convention !== 'object' || Array.isArray(convention)) continue;
    const domain = lower(convention.domain);
    const pattern = stringValue(convention.pattern);
    const definition = patternDefinition(pattern);
    if (!domain || !definition || convention.sendable === true) continue;
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const sourceType = lower(candidate.sourceType || candidate.source || '');
      const name = stringValue(candidate.name);
      const title = stringValue(candidate.title);
      const sourceUrl = evidenceUrl(/** @type {Record<string, unknown>} */ (candidate));
      const tokens = nameTokens(name);
      if (!isUsableName(name) || !title || !sourceUrl || !PUBLIC_SOURCE_TYPES.has(sourceType) || stringValue(candidate.email)) continue;
      const local = definition.render(tokens);
      if (!local) continue;
      const email = `${local}@${domain}`;
      const key = `${ascii(name)}|${email}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hypotheses.push({
        name,
        title,
        company: stringValue(candidate.company),
        email,
        emailVerified: false,
        emailVerificationState: 'unverified-hypothesis',
        emailHypothesis: true,
        guessed: true,
        private: false,
        publicProfessional: true,
        sourceType: 'derived-email-hypothesis',
        sourceUrl,
        profileUrl: stringValue(candidate.profileUrl) || (sourceType === 'public-profile' ? sourceUrl : null),
        roleRelevance: stringValue(candidate.roleRelevance) || 'high',
        convention: pattern,
        conventionDomain: domain,
        conventionConfidence: stringValue(convention.confidence) || 'provisional',
        conventionSampleCount: Number(convention.sampleCount) || 0,
        conventionCoverage: Number(convention.coverage) || 0,
        conventionEvidenceUrls: Array.isArray(convention.evidenceUrls) ? convention.evidenceUrls.slice(0, MAX_EVIDENCE_URLS) : [],
        verificationRequired: 'exact public email evidence or first-party Gmail header with source message ID',
        sendable: false,
      });
      if (hypotheses.length >= maxHypotheses) return hypotheses;
    }
  }
  return hypotheses;
}
