// @ts-check

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeText, normalizeUrl } from './queue-lib.mjs';
import { resolveAndValidate } from './plugins/_net.mjs';
import { buildEmailHypotheses, inferEmailConventions } from './email-conventions.mjs';

const DEFAULT_API_URL = 'https://api.firecrawl.dev';
const MAX_QUERIES = 2;
const MAX_SCRAPES_PER_QUERY = 2;
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'live.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com',
]);
const BLOCKED_SOURCE_HOSTS = new Set([
  'linkedin.com', 'www.linkedin.com', 'teamworkonline.com', 'www.teamworkonline.com',
  'glassdoor.com', 'www.glassdoor.com', 'glassdoor.co.uk', 'www.glassdoor.co.uk',
  'indeed.com', 'www.indeed.com', 'ziprecruiter.com', 'www.ziprecruiter.com',
]);
const ATS_HOSTS = [
  'ashbyhq.com', 'greenhouse.io', 'lever.co', 'workable.com', 'myworkdayjobs.com',
  'smartrecruiters.com', 'teamtailor.com', 'jobvite.com', 'paylocity.com',
];
const GENERIC_MAILBOX_RE = /^(?:careers?|jobs?|recruit(?:ing|ment)|talent|hiring|people|hr|humanresources|employment)(?:[+._-].*)?$/i;
const ROLE_RE = /(?:recruit|talent|hiring|people|engineering|software|technical|product|developer|cto|founder|manager|director|head|vice president|vp)/i;
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
  if (ATS_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return 'job-posting';
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

/** @param {string} value @param {string} itemCompany */
function hasEmployerEvidence(value, itemCompany) {
  const company = lower(itemCompany);
  const haystack = lower(value);
  if (!company || !haystack) return false;
  if (haystack.includes(company)) return true;
  const tokens = company.split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !['company', 'jobs', 'more', 'your', 'apply'].includes(token));
  return tokens.length > 0 && tokens.some((token) => haystack.includes(token));
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
    const identity = identityFromText(title, description);
    if (identity.name && identity.title) {
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
    if (!isGenericMailbox(email) && !identity.name) continue;
    if (sourceType === 'company-site' && pageRoot !== rootHost(domain)) continue;
    const generic = isGenericMailbox(email);
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
  const identity = isLinkedInUrl(url)
    ? identityFromText(title, description)
    : identityFromText(title, markdown || description);
  if (!identity.name || !identity.title) return null;
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
  ];
  const companyWebsite = stringValue(item.companyWebsite || item.companyUrl || item.employerUrl);
  const parsed = parsedUrl(companyWebsite);
  if (parsed && !BLOCKED_SOURCE_HOSTS.has(parsed.hostname.toLowerCase())) {
    queries[1] = `site:${parsed.hostname} (team OR people OR recruiting OR careers) "${title}"`;
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
    return { status: 'blocked', reason: 'application identity is not specific enough for contact discovery', queries: [], sources: [], contacts: [], errors: [] };
  }
  if (options.dryRun) {
    return { status: 'dry_run', reason: 'dry-run does not perform public web discovery', queries, sources: [], contacts: [], errors: [] };
  }
  const contacts = [];
  const candidates = [];
  const sources = [];
  const errors = [];
  const fetchFn = options.fetchFn || globalThis.fetch;
  const credentials = credentialsFromEnv(options.env);
  if (!credentials) {
    return { status: 'unavailable', reason: 'Firecrawl credentials are unavailable', queries, sources: [], contacts: [], errors: [] };
  }
  for (const query of queries) {
    try {
      const results = await searchPublicWeb(query, { limit: 5, credentials, fetchFn });
      const hydrated = [];
      for (const result of results) {
        const url = normalizeUrl(stringValue(result.url));
        if (!url) continue;
        sources.push(url);
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
  const reason = uniqueContacts.length
    ? `found ${uniqueContacts.length} public contact candidate(s)`
    : 'no eligible public contact found';
  return {
    status: uniqueContacts.length ? 'found' : 'no_contacts',
    reason: `${reason}${emailConventions.length ? `; inferred ${emailConventions.length} review-only email convention(s)` : ''}${emailHypotheses.length ? `; generated ${emailHypotheses.length} unverified email hypothesis/hypotheses` : ''}`,
    queries,
    sources: uniqueSources,
    contacts: uniqueContacts,
    emailConventions,
    emailHypotheses,
    errors,
  };
}
