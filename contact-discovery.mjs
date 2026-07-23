// @ts-check

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeText, normalizeUrl } from './queue-lib.mjs';
import { resolveAndValidate } from './plugins/_net.mjs';
import { buildEmailHypotheses, inferEmailConventions } from './email-conventions.mjs';

const DEFAULT_API_URL = 'https://api.firecrawl.dev';
const MAX_QUERIES = 5;
const MAX_SCRAPES_PER_QUERY = 2;
const MAX_EXACT_VERIFICATION_QUERIES = 6;
const MAX_CANDIDATE_EMAIL_QUERIES = 8;
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'live.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com',
]);
const BLOCKED_SOURCE_HOSTS = new Set([
  'linkedin.com', 'www.linkedin.com', 'teamworkonline.com', 'www.teamworkonline.com',
  'glassdoor.com', 'www.glassdoor.com', 'glassdoor.co.uk', 'www.glassdoor.co.uk',
  'indeed.com', 'www.indeed.com', 'ziprecruiter.com', 'www.ziprecruiter.com',
  'rocketreach.co', 'www.rocketreach.co', 'idcrawl.com', 'www.idcrawl.com',
  'contactout.com', 'www.contactout.com', 'lusha.com', 'www.lusha.com',
  'apollo.io', 'www.apollo.io', 'zoominfo.com', 'www.zoominfo.com',
  'signalhire.com', 'www.signalhire.com', 'hunter.io', 'www.hunter.io',
  'clearbit.com', 'www.clearbit.com', 'wiza.co', 'www.wiza.co',
  'whitepages.com', 'www.whitepages.com', 'facebook.com', 'www.facebook.com',
  'instagram.com', 'www.instagram.com',
]);
const ATS_HOSTS = [
  'ashbyhq.com', 'greenhouse.io', 'lever.co', 'workable.com', 'myworkdayjobs.com',
  'smartrecruiters.com', 'teamtailor.com', 'jobvite.com', 'paylocity.com',
];
const GENERIC_MAILBOX_RE = /^(?:careers?|jobs?|recruit(?:ing|ment)|talent|hiring|people|hr|humanresources|employment)(?:[+._-].*)?$/i;
const ROLE_RE = /(?:recruit|talent|hiring|people|engineering|software|technical|product|developer|cto|founder|manager|director|head|vice president|vp)/i;
const NON_PERSON_NAME_TOKENS = new Set([
  'api', 'aws', 'config', 'configuration', 'developer', 'experience', 'github', 'group',
  'iam', 'json', 'permission', 'policy', 'role', 'service', 'team', 'terraform', 'user', 'yaml',
]);
const AGGREGATE_COMPANY_RE = /\band\s+\d+\s+more\b|\b\d+\s+more\s+jobs?\b|\bfor\s+you\b|\bapply\s+now\b/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const COMPANY_EMAIL_ALIASES = new Map([
  ['amazon', ['amazon.com', 'amazon.jobs', 'aws.amazon.com']],
  ['case western', ['case.edu']],
  ['cwru', ['case.edu']],
]);

/** @param {string} value */
function lower(value) { return normalizeText(value).toLowerCase(); }

/** @param {unknown} value */
function stringValue(value) { return typeof value === 'string' ? normalizeText(value) : ''; }

/** @param {unknown} value */
function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {string} host */
function rootHost(host) {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  return labels.length >= 2 ? labels.slice(-2).join('.') : host.toLowerCase();
}

/** @param {string} host */
function isAtsHost(host) {
  const normalized = host.toLowerCase();
  return ATS_HOSTS.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

/** @param {string} url */
function parsedUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!parsed.hostname || BLOCKED_SOURCE_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    return parsed;
  } catch { return null; }
}

/** @param {string} url */
function provenanceUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    const host = parsed.hostname.toLowerCase();
    if (!BLOCKED_SOURCE_HOSTS.has(host)) return normalized;
    return isLinkedInUrl(normalized) && /^\/(?:in|pub)\//i.test(parsed.pathname) ? normalized : '';
  } catch { return ''; }
}

/** @param {string} url */
function isLinkedInUrl(url) {
  try { return new URL(url).hostname.toLowerCase().endsWith('linkedin.com'); } catch { return false; }
}

/** @param {string} url */
function isSearchScrapeCandidate(url) {
  const parsed = parsedUrl(url);
  if (!parsed || isLinkedInUrl(url)) return false;
  const host = parsed.hostname.toLowerCase();
  if (host.endsWith('google.com') || host.endsWith('bing.com') || host.endsWith('duckduckgo.com')) return false;
  return true;
}

/** @param {string} url */
function sourceTypeForUrl(url) {
  const parsed = parsedUrl(url);
  if (!parsed) return 'public-profile';
  const host = parsed.hostname.toLowerCase();
  if (isAtsHost(host)) return 'job-posting';
  if (/\/(?:jobs?|careers?|positions?|openings?)\b/i.test(parsed.pathname)) return 'job-posting';
  return 'company-site';
}

/** @param {string} url */
function emailDomain(url) { return lower(url.split('@')[1] || ''); }

/** @param {string} email @param {Record<string, unknown>} item */
function employerEmailDomainMatches(email, item) {
  const domain = emailDomain(email);
  const urls = [item.companyWebsite, item.companyUrl, item.employerUrl, item.applyUrl, item.canonicalUrl]
    .map(stringValue)
    .filter(Boolean);
  for (const url of urls) {
    try {
      const host = rootHost(new URL(url).hostname);
      if (domain === host || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`)) return true;
    } catch { /* non-URL company metadata is ignored */ }
  }
  const company = lower(item.company);
  for (const [token, aliases] of COMPANY_EMAIL_ALIASES) {
    if (company.includes(token) && aliases.includes(domain)) return true;
  }
  return false;
}

/** @param {string} text */
function cleanLine(text) {
  return normalizeText(text)
    .replace(/^\s*[-*#>]+\s*/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim();
}

/** @param {string} text */
function linesOf(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&(?:amp|nbsp|lt|gt);/gi, ' ')
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);
}

/** @param {string} text */
function extractEmails(text) {
  return [...new Set((text.match(EMAIL_RE) || []).map((value) => value.toLowerCase()))];
}

/** @param {string} value */
function nameTokens(value) {
  return normalizeText(value)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** @param {string} name */
function isLikelyPersonName(name) {
  const tokens = nameTokens(name);
  return tokens.length >= 2
    && tokens.length <= 4
    && !tokens.some((token) => NON_PERSON_NAME_TOKENS.has(token));
}

/** @param {string} left @param {string} right */
function samePersonName(left, right) {
  const leftTokens = nameTokens(left);
  const rightTokens = nameTokens(right);
  return leftTokens.length >= 2
    && leftTokens.length === rightTokens.length
    && leftTokens.every((token, index) => token === rightTokens[index]);
}

/** @param {string} value @param {string} itemCompany */
function hasEmployerEvidence(value, itemCompany) {
  const company = lower(itemCompany);
  const haystack = lower(value);
  if (!company || !haystack) return false;
  if (haystack.includes(company)) return true;
  const tokens = company.split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !['company', 'jobs', 'more', 'your', 'apply'].includes(token));
  return tokens.length > 0 && tokens.some((token) => haystack.includes(token));
}

/** @param {string} title @param {string} description @param {string} itemCompany */
function hasCurrentLinkedInEmployerEvidence(title, description, itemCompany) {
  const titleText = stringValue(title);
  const descriptionText = stringValue(description);
  const evidence = `${titleText}\n${descriptionText}`;
  if (!hasEmployerEvidence(evidence, itemCompany)) return false;
  if (hasEmployerEvidence(titleText, itemCompany)) return true;
  const titleEmployer = titleText.match(/\bat\s+([^|—–-]+?)(?:\s*\|\s*|\s*-\s*|\s*$)/i)?.[1]?.trim() || '';
  if (titleEmployer && !/^\.{2,}$/.test(titleEmployer) && !hasEmployerEvidence(titleEmployer, itemCompany)) return false;
  return !/\b(?:left|former(?:ly)?|previously|ex[-\s]?employee|past)\b/i.test(descriptionText);
}

/** @param {string} email */
function isGenericMailbox(email) {
  return GENERIC_MAILBOX_RE.test(email.split('@')[0] || '');
}

/** @param {string} title @param {string} body */
function identityFromText(title, body) {
  const titleParts = stringValue(title).split(/\s+(?:\||—|–|-|·)\s+/).map(cleanLine).filter(Boolean);
  const roleFromTitle = titleParts.find((part) => ROLE_RE.test(part) && part.length < 100) || '';
  const nameFromTitle = titleParts.find((part) => {
    if (!part || ROLE_RE.test(part) || /linkedin|profile|company/i.test(part)) return false;
    return /^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}$/.test(part);
  }) || '';
  const bodyLines = linesOf(body);
  const roleFromBody = bodyLines.find((line) => ROLE_RE.test(line) && line.length < 100) || roleFromTitle;
  const nameFromBody = bodyLines.find((line) => {
    if (!line || ROLE_RE.test(line) || /@|https?:\/\/|linkedin|company|contact|team/i.test(line)) return false;
    return /^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}$/.test(line);
  }) || nameFromTitle;
  return {
    name: nameFromBody,
    title: roleFromBody,
  };
}

/** @param {Record<string, unknown>} result @param {Record<string, unknown>} item */
function contactsFromResult(result, item) {
  const url = normalizeUrl(stringValue(result.url));
  if (!url) return [];
  if (!isLinkedInUrl(url) && !parsedUrl(url)) return [];
  const title = stringValue(result.title);
  const description = stringValue(result.description);
  const markdown = stringValue(result.markdown);
  const evidence = `${title}\n${description}\n${markdown}`;
  if (!hasEmployerEvidence(evidence, stringValue(item.company))) return [];

  const contacts = [];
  if (isLinkedInUrl(url)) {
    if (!hasCurrentLinkedInEmployerEvidence(title, description, stringValue(item.company))) return contacts;
    const identity = identityFromText(title, description);
    if (identity.name && identity.title && isLikelyPersonName(identity.name)) {
      const publicEmail = extractEmails(evidence).find((email) => {
        if (FREE_EMAIL_DOMAINS.has(emailDomain(email))) return false;
        return employerEmailDomainMatches(email, item) || /(?:email|contact|reach|mail)\s*[:\-]/i.test(evidence);
      }) || null;
      contacts.push({
        name: identity.name,
        title: identity.title,
        company: stringValue(item.company),
        email: publicEmail,
        emailVerified: Boolean(publicEmail),
        guessed: false,
        private: false,
        publicProfessional: true,
        sourceType: 'public-profile',
        sourceUrl: url,
        profileUrl: url,
        roleRelevance: 'high',
      });
    }
    return contacts;
  }

  const sourceType = sourceTypeForUrl(url);
  const parsed = parsedUrl(url);
  const pageHost = parsed?.hostname.toLowerCase() || '';
  const pageRoot = rootHost(pageHost);
  const identity = identityFromText(title, markdown || description);
  for (const email of extractEmails(evidence)) {
    const domain = emailDomain(email);
    if (!domain || FREE_EMAIL_DOMAINS.has(domain)) continue;
    const generic = isGenericMailbox(email);
    if (!generic && (!identity.name || !identity.title || !isLikelyPersonName(identity.name))) continue;
    if (sourceType === 'company-site' && pageRoot !== rootHost(domain)) continue;
    contacts.push({
      name: generic ? 'Recruiting Team' : identity.name,
      title: generic ? 'Recruiting' : identity.title || 'Engineering contact',
      company: stringValue(item.company),
      email,
      emailVerified: true,
      publicProfessional: true,
      guessed: false,
      private: false,
      sourceType,
      sourceUrl: url,
      profileUrl: null,
      roleRelevance: generic ? 'medium' : 'high',
    });
  }
  return contacts;
}

/** @param {Record<string, unknown>} result @param {Record<string, unknown>} item */
function candidateFromResult(result, item) {
  const url = normalizeUrl(stringValue(result.url));
  if (!url || (!isLinkedInUrl(url) && !parsedUrl(url))) return null;
  const title = stringValue(result.title);
  const description = stringValue(result.description);
  const markdown = stringValue(result.markdown);
  const evidence = `${title}\n${description}\n${markdown}`;
  if (!hasEmployerEvidence(evidence, stringValue(item.company))) return null;
  if (isLinkedInUrl(url) && !hasCurrentLinkedInEmployerEvidence(title, description, stringValue(item.company))) return null;
  const identity = isLinkedInUrl(url)
    ? identityFromText(title, description)
    : identityFromText(title, markdown || description);
  if (!identity.name || !identity.title || !isLikelyPersonName(identity.name)) return null;
  const sourceType = sourceTypeForUrl(url);
  return {
    name: identity.name,
    title: identity.title,
    company: stringValue(item.company),
    email: null,
    emailVerified: false,
    guessed: false,
    private: false,
    publicProfessional: true,
    sourceType,
    sourceUrl: url,
    profileUrl: isLinkedInUrl(url) ? url : null,
    roleRelevance: 'high',
  };
}

/** @param {Record<string, unknown>} item */
export function isDiscoverableApplication(item) {
  const company = stringValue(item.company);
  const title = stringValue(item.title);
  const url = normalizeUrl(stringValue(item.applyUrl || item.canonicalUrl));
  return Boolean(company && title && url && !AGGREGATE_COMPANY_RE.test(company));
}

/** @param {Record<string, unknown>} item */
export function buildDiscoveryQueries(item) {
  if (!isDiscoverableApplication(item)) return [];
  const company = stringValue(item.company).replaceAll('"', '');
  const title = stringValue(item.title).replaceAll('"', '');
  const queries = [
    `"${company}" "${title}" recruiter hiring manager`,
    `"${company}" recruiting talent engineering manager email`,
    `site:linkedin.com/in "${company}" recruiter talent acquisition`,
    `site:linkedin.com/in "${company}" "engineering manager"`,
  ];
  const emailDomain = candidateEmailDomain(item);
  if (emailDomain) queries.push(`site:${emailDomain} "@${emailDomain}" (recruiter OR talent OR engineering OR manager)`);
  const companyWebsite = stringValue(item.companyWebsite || item.companyUrl || item.employerUrl);
  const parsed = parsedUrl(companyWebsite);
  if (parsed && !BLOCKED_SOURCE_HOSTS.has(parsed.hostname.toLowerCase()) && !isAtsHost(parsed.hostname)) {
    queries[1] = `site:${parsed.hostname} (team OR people OR leadership OR recruiting OR careers) "${title}"`;
  }
  return queries.slice(0, MAX_QUERIES);
}

/** @param {Record<string, string | undefined>} env */
function credentialsFromEnv(env = process.env) {
  if (env.FIRECRAWL_API_KEY) {
    return { apiKey: env.FIRECRAWL_API_KEY, apiUrl: env.FIRECRAWL_API_URL || DEFAULT_API_URL };
  }
  const configuredPath = env.FIRECRAWL_CREDENTIALS_PATH;
  const defaultPath = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'firecrawl-cli', 'credentials.json')
    : path.join(os.homedir(), '.config', 'firecrawl', 'credentials.json');
  const file = configuredPath || defaultPath;
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const apiKey = stringValue(parsed?.apiKey);
    return apiKey ? { apiKey, apiUrl: env.FIRECRAWL_API_URL || DEFAULT_API_URL } : null;
  } catch { return null; }
}

/** @param {string} apiUrl */
async function validateApiUrl(apiUrl) {
  const parsed = new URL(apiUrl);
  if (parsed.protocol !== 'https:') throw new Error('Firecrawl API URL must use HTTPS');
  await resolveAndValidate(parsed.hostname);
  return apiUrl.replace(/\/$/, '');
}

/** @param {string} endpoint @param {Record<string, unknown>} body @param {{apiKey: string, apiUrl: string}} credentials @param {(input: string, init?: RequestInit) => Promise<Response>} fetchFn */
async function firecrawlRequest(endpoint, body, credentials, fetchFn) {
  const apiUrl = await validateApiUrl(credentials.apiUrl);
  const response = await fetchFn(`${apiUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  let payload = /** @type {Record<string, unknown>} */ ({});
  try { payload = JSON.parse(text); } catch { /* handled below */ }
  if (!response.ok || payload.success === false) {
    throw new Error(`Firecrawl ${endpoint} failed: ${response.status}`);
  }
  return payload;
}

/** @param {string} query @param {{limit?: number, credentials?: {apiKey: string, apiUrl: string}, env?: Record<string, string | undefined>, fetchFn?: (input: string, init?: RequestInit) => Promise<Response>}} [options] */
export async function searchPublicWeb(query, options = {}) {
  const credentials = options.credentials || credentialsFromEnv(options.env);
  if (!credentials) throw new Error('Firecrawl credentials are unavailable');
  const payload = await firecrawlRequest('/v2/search', {
    query,
    limit: Math.min(10, Math.max(1, options.limit || 5)),
    sources: ['web'],
  }, credentials, options.fetchFn || globalThis.fetch);
  const data = recordValue(payload.data);
  return Array.isArray(data.web) ? data.web.filter((entry) => entry && typeof entry === 'object') : [];
}

/** @param {string} url @param {{credentials?: {apiKey: string, apiUrl: string}, env?: Record<string, string | undefined>, fetchFn?: (input: string, init?: RequestInit) => Promise<Response>}} [options] */
async function scrapePublicPage(url, options = {}) {
  const credentials = options.credentials || credentialsFromEnv(options.env);
  if (!credentials) throw new Error('Firecrawl credentials are unavailable');
  const payload = await firecrawlRequest('/v2/scrape', {
    url,
    formats: ['markdown'],
    onlyMainContent: true,
  }, credentials, options.fetchFn || globalThis.fetch);
  const data = recordValue(payload.data);
  return { url, ...data };
}

/** @param {Array<Record<string, unknown>>} results @param {Record<string, unknown>} item */
export function extractPublicContacts(results, item) {
  const contacts = [];
  for (const result of results) contacts.push(...contactsFromResult(result, item));
  return dedupeContacts(contacts);
}

/** @param {Array<Record<string, unknown>>} results @param {Record<string, unknown>} item */
export function extractPublicContactCandidates(results, item) {
  const candidates = [];
  for (const result of results) {
    const namedContacts = contactsFromResult(result, item).filter((contact) => contact.name !== 'Recruiting Team');
    if (namedContacts.length) {
      candidates.push(...namedContacts);
      continue;
    }
    const candidate = candidateFromResult(result, item);
    if (candidate) candidates.push(candidate);
  }
  return dedupeContacts(candidates);
}

/** @param {Record<string, unknown>} hypothesis @param {Record<string, unknown>} item */
export function buildExactEmailVerificationQuery(hypothesis, item) {
  const email = stringValue(hypothesis.email).replaceAll('"', '');
  const name = stringValue(hypothesis.name).replaceAll('"', '');
  const company = stringValue(hypothesis.company || item.company).replaceAll('"', '');
  return `"${email}" "${name}" "${company}"`;
}

/** @param {Record<string, unknown>} item */
function candidateEmailDomain(item) {
  const company = lower(stringValue(item.company));
  for (const [token, aliases] of COMPANY_EMAIL_ALIASES) {
    if (company.includes(token)) return aliases[0];
  }
  const urls = [item.companyWebsite, item.companyUrl, item.employerUrl, item.applyUrl, item.canonicalUrl]
    .map(stringValue)
    .filter(Boolean);
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (isAtsHost(parsed.hostname)) continue;
      const host = rootHost(parsed.hostname);
      if (host) return host;
    } catch { /* non-URL metadata is ignored */ }
  }
  return '';
}

/** @param {Record<string, unknown>} candidate @param {Record<string, unknown>} item */
export function buildCandidateEmailVerificationQuery(candidate, item) {
  const name = stringValue(candidate.name).replaceAll('"', '');
  const company = stringValue(candidate.company || item.company).replaceAll('"', '');
  return `"${name}" "${company}" email contact`;
}

/** @typedef {{
 *  searchFn?: typeof searchPublicWeb,
 *  scrapeFn?: (url: string, options?: { env?: Record<string, string | undefined>, fetchFn?: (input: string, init?: RequestInit) => Promise<Response> }) => Promise<Record<string, unknown>>,
 *  env?: Record<string, string | undefined>,
 *  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>,
 * }} ExactVerificationOptions */

/** @param {Array<Record<string, unknown>>} hypotheses @param {Record<string, unknown>} item @param {ExactVerificationOptions} [options] */
export async function verifyPublicEmailHypotheses(hypotheses, item, options = {}) {
  const searchFn = options.searchFn || searchPublicWeb;
  const queries = [];
  const sources = [];
  const errors = [];
  const verifications = [];
  const verifiedContacts = [];
  const seenEmails = new Set();
  const credentials = credentialsFromEnv(options.env);

  for (const hypothesis of Array.isArray(hypotheses) ? hypotheses : []) {
    if (!hypothesis || typeof hypothesis !== 'object' || Array.isArray(hypothesis)) continue;
    const email = lower(stringValue(hypothesis.email));
    const name = stringValue(hypothesis.name);
    const title = stringValue(hypothesis.title);
    if (!email || !name || !title || seenEmails.has(email)) continue;
    if (queries.length >= MAX_EXACT_VERIFICATION_QUERIES) break;
    seenEmails.add(email);
    const query = buildExactEmailVerificationQuery(hypothesis, item);
    queries.push(query);
    try {
      const results = await searchFn(query, { limit: 5, env: options.env, fetchFn: options.fetchFn });
      const batch = [];
      let scrapeCount = 0;
      for (const result of Array.isArray(results) ? results : []) {
        if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
        const entry = /** @type {Record<string, unknown>} */ (result);
        const url = normalizeUrl(stringValue(entry.url));
        const source = provenanceUrl(url);
        if (source) sources.push(source);
        batch.push(entry);
        const evidence = `${stringValue(entry.title)}\n${stringValue(entry.description)}\n${stringValue(entry.markdown)}`;
        if (credentials && url && isSearchScrapeCandidate(url) && scrapeCount < 1 && !lower(evidence).includes(email)) {
          scrapeCount += 1;
          try {
            const scraped = options.scrapeFn
              ? await options.scrapeFn(url, { env: options.env, fetchFn: options.fetchFn })
              : await scrapePublicPage(url, { credentials, fetchFn: options.fetchFn });
            batch.push({ ...entry, ...scraped });
          } catch { /* search metadata remains the only evidence when hydration fails */ }
        }
      }
      const matches = extractPublicContacts(batch, item).filter((contact) =>
        lower(stringValue(contact.email)) === email
        && samePersonName(stringValue(contact.name), name)
        && stringValue(contact.title),
      );
      if (matches.length) {
        const contact = {
          ...matches[0],
          emailVerificationType: 'exact-public-source',
          exactEmailEvidence: true,
          verificationQuery: query,
          verificationSourceUrl: matches[0].sourceUrl,
        };
        verifiedContacts.push(contact);
        verifications.push({
          name,
          title,
          email,
          status: 'verified-exact-public-source',
          query,
          sourceUrl: contact.sourceUrl,
        });
      } else {
        verifications.push({ name, title, email, status: 'not_observed', query });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(reason);
      verifications.push({ name, title, email, status: 'error', query, reason });
    }
  }

  return {
    contacts: dedupeContacts(verifiedContacts),
    queries,
    sources: [...new Set(sources)].slice(0, 20),
    verifications,
    errors: [...new Set(errors)],
  };
}

/** @param {Array<Record<string, unknown>>} candidates @param {Record<string, unknown>} item @param {ExactVerificationOptions} [options] */
export async function verifyPublicCandidateEmails(candidates, item, options = {}) {
  const searchFn = options.searchFn || searchPublicWeb;
  const queries = [];
  const sources = [];
  const errors = [];
  const verifications = [];
  const verifiedContacts = [];
  const seenNames = new Set();
  const credentials = credentialsFromEnv(options.env);

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const name = stringValue(candidate.name);
    const title = stringValue(candidate.title);
    if (!name || !title || seenNames.has(lower(name))) continue;
    if (queries.length >= MAX_CANDIDATE_EMAIL_QUERIES) break;
    seenNames.add(lower(name));
    const domain = candidateEmailDomain(item);
    const candidateQueries = [
      buildCandidateEmailVerificationQuery(candidate, item),
      ...(domain ? [`site:${domain} "${name}" email`] : []),
    ];
    const attemptedQueries = [];
    let match = null;
    let failure = '';
    for (const query of candidateQueries) {
      if (queries.length >= MAX_CANDIDATE_EMAIL_QUERIES) break;
      queries.push(query);
      attemptedQueries.push(query);
      try {
        const results = await searchFn(query, { limit: 5, env: options.env, fetchFn: options.fetchFn });
        const batch = [];
        let scrapeCount = 0;
        for (const result of Array.isArray(results) ? results : []) {
          if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
          const entry = /** @type {Record<string, unknown>} */ (result);
          const url = normalizeUrl(stringValue(entry.url));
          const source = provenanceUrl(url);
          if (source) sources.push(source);
          batch.push(entry);
          const evidence = `${stringValue(entry.title)}\n${stringValue(entry.description)}\n${stringValue(entry.markdown)}`;
          if (credentials && url && isSearchScrapeCandidate(url) && scrapeCount < 1 && !extractEmails(evidence).length) {
            scrapeCount += 1;
            try {
              const scraped = options.scrapeFn
                ? await options.scrapeFn(url, { env: options.env, fetchFn: options.fetchFn })
                : await scrapePublicPage(url, { credentials, fetchFn: options.fetchFn });
              batch.push({ ...entry, ...scraped });
            } catch { /* search metadata remains the only evidence when hydration fails */ }
          }
        }
        const matches = extractPublicContacts(batch, item).filter((contact) =>
          samePersonName(stringValue(contact.name), name)
          && Boolean(stringValue(contact.email))
          && stringValue(contact.title),
        );
        if (matches.length) {
          match = { ...matches[0], verificationQuery: query };
          break;
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        errors.push(failure);
        break;
      }
    }
    if (match) {
      const contact = {
        ...match,
        emailVerificationType: 'exact-public-source',
        exactEmailEvidence: true,
        verificationSourceUrl: match.sourceUrl,
      };
      verifiedContacts.push(contact);
      verifications.push({
        name,
        title,
        email: contact.email,
        status: 'verified-exact-public-source',
        query: attemptedQueries.at(-1),
        queries: attemptedQueries,
        sourceUrl: contact.sourceUrl,
      });
    } else {
      verifications.push({
        name,
        title,
        email: null,
        status: failure ? 'error' : 'not_observed',
        query: attemptedQueries.at(-1),
        queries: attemptedQueries,
        ...(failure ? { reason: failure } : {}),
      });
    }
  }

  return {
    contacts: dedupeContacts(verifiedContacts),
    queries,
    sources: [...new Set(sources)].slice(0, 20),
    verifications,
    errors: [...new Set(errors)],
  };
}

/** @param {Array<Record<string, unknown>>} contacts */
function dedupeContacts(contacts) {
  const deduped = new Map();
  for (const contact of contacts) {
    const key = lower(contact.email || contact.profileUrl || contact.name);
    if (!key || deduped.has(key)) continue;
    deduped.set(key, contact);
  }
  return [...deduped.values()];
}

/** @param {Record<string, unknown>} item @param {{dryRun?: boolean, env?: Record<string, string | undefined>, fetchFn?: (input: string, init?: RequestInit) => Promise<Response>}} [options] */
export async function discoverContactsForApplication(item, options = {}) {
  const queries = buildDiscoveryQueries(item);
  if (!queries.length) {
    return { status: 'blocked', reason: 'application identity is not specific enough for contact discovery', queries: [], sources: [], contacts: [], emailConventions: [], emailHypotheses: [], emailVerification: [], candidateEmailVerification: [], errors: [] };
  }
  if (options.dryRun) {
    return { status: 'dry_run', reason: 'dry-run does not perform public web discovery', queries, sources: [], contacts: [], emailConventions: [], emailHypotheses: [], emailVerification: [], candidateEmailVerification: [], errors: [] };
  }
  const contacts = [];
  const candidates = [];
  const sources = [];
  const errors = [];
  const fetchFn = options.fetchFn || globalThis.fetch;
  const credentials = credentialsFromEnv(options.env);
  if (!credentials) {
    return { status: 'unavailable', reason: 'Firecrawl credentials are unavailable', queries, sources: [], contacts: [], emailConventions: [], emailHypotheses: [], emailVerification: [], candidateEmailVerification: [], errors: [] };
  }
  for (const query of queries) {
    try {
      const results = await searchPublicWeb(query, { limit: 5, credentials, fetchFn });
      const hydrated = [];
      for (const result of results) {
        const url = normalizeUrl(stringValue(result.url));
        if (!url) continue;
        const source = provenanceUrl(url);
        if (source) sources.push(source);
        if (isSearchScrapeCandidate(url) && hydrated.length < MAX_SCRAPES_PER_QUERY) {
          try {
            const scraped = await scrapePublicPage(url, { credentials, fetchFn });
            hydrated.push({ ...result, ...scraped });
          } catch { /* search metadata remains useful when a page cannot be scraped */ }
        }
      }
      const batch = [...results, ...hydrated];
      contacts.push(...extractPublicContacts(batch, item));
      candidates.push(...extractPublicContactCandidates(batch, item));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const uniqueSources = [...new Set(sources)].slice(0, 20);
  const uniqueContacts = dedupeContacts(contacts);
  const uniqueCandidates = dedupeContacts(candidates);
  const emailConventions = inferEmailConventions(uniqueContacts);
  const emailHypotheses = buildEmailHypotheses(emailConventions, uniqueCandidates);
  const emailVerification = emailHypotheses.length
    ? await verifyPublicEmailHypotheses(emailHypotheses, item, { env: options.env, fetchFn: options.fetchFn })
    : { contacts: [], queries: [], sources: [], verifications: [], errors: [] };
  const verifiedPublicNames = new Set(uniqueContacts
    .filter((contact) => stringValue(contact.email))
    .map((contact) => lower(stringValue(contact.name))));
  const candidateEmailVerification = await verifyPublicCandidateEmails(
    uniqueCandidates
      .filter((candidate) => !stringValue(candidate.email) && !verifiedPublicNames.has(lower(stringValue(candidate.name))))
      .slice(0, 4),
    item,
    { env: options.env, fetchFn: options.fetchFn },
  );
  const verifiedHypothesisEmails = new Map(emailVerification.verifications
    .filter((entry) => entry.status === 'verified-exact-public-source')
    .map((entry) => [entry.email, entry]));
  const annotatedHypotheses = emailHypotheses.map((hypothesis) => {
    const verification = verifiedHypothesisEmails.get(lower(stringValue(hypothesis.email)));
    return verification
      ? { ...hypothesis, emailVerificationState: 'verified-exact-public-source', verificationSourceUrl: verification.sourceUrl || null, verificationQuery: verification.query }
      : hypothesis;
  });
  const finalContacts = dedupeContacts([...uniqueContacts, ...emailVerification.contacts, ...candidateEmailVerification.contacts]);
  const finalQueries = [...queries, ...emailVerification.queries, ...candidateEmailVerification.queries];
  const finalSources = [...new Set([...uniqueSources, ...emailVerification.sources, ...candidateEmailVerification.sources])].slice(0, 20);
  const finalErrors = [...new Set([...errors, ...emailVerification.errors, ...candidateEmailVerification.errors])];
  const reason = finalContacts.length
    ? `found ${finalContacts.length} public contact candidate(s)`
    : 'no eligible public contact found';
  return {
    status: finalContacts.length ? 'found' : 'no_contacts',
    reason: `${reason}${emailConventions.length ? `; inferred ${emailConventions.length} email convention(s)` : ''}${emailHypotheses.length ? `; generated ${emailHypotheses.length} unverified email hypothesis/hypotheses; exact verification observed ${emailVerification.contacts.length}` : ''}${candidateEmailVerification.contacts.length ? `; exact candidate email verification observed ${candidateEmailVerification.contacts.length}` : ''}`,
    queries: finalQueries,
    sources: finalSources,
    contacts: finalContacts,
    emailConventions,
    emailHypotheses: annotatedHypotheses,
    emailVerification: emailVerification.verifications,
    candidateEmailVerification: candidateEmailVerification.verifications,
    errors: finalErrors,
  };
}
