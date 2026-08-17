// @ts-check

import {
  classifyPublicSearchFailure,
  extractPublicContacts,
  searchPublicWeb,
} from './contact-discovery.mjs';
import {
  isProviderGeneratedContactDomain,
  isProviderGeneratedContactEmail,
} from './outreach-lib.mjs';
import { normalizeText, normalizeUrl } from './queue-lib.mjs';

const MAX_GMAIL_QUERIES = 6;
const MAX_GMAIL_MESSAGES = 60;
const MAX_WEB_QUERIES = 4;
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'live.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com',
]);
const IGNORED_MAILBOXES = new Set([
  'mailer-daemon', 'postmaster', 'no-reply', 'noreply', 'do-not-reply',
  'donotreply', 'notifications', 'notification', 'jobalerts', 'job-alerts',
]);

const DEFAULT_RELATIONSHIP_SOURCES = Object.freeze([
  {
    name: 'Amazon',
    terms: ['Amazon', 'AWS'],
    domains: ['amazon.com', 'amazon.jobs', 'aws.amazon.com'],
  },
  {
    name: 'Case Western Reserve University',
    terms: ['Case Western', 'CWRU'],
    domains: ['case.edu'],
  },
]);

/** @typedef {{ name: string, terms: string[], domains: string[] }} RelationshipSource */

/** @typedef {{
 *  listMessages: (query: string, options?: { limit?: number }) => Promise<Array<{ id: string, threadId?: string }>>,
 *  getMessage: (id: string, format?: string) => Promise<Record<string, unknown>>,
 * }} RelationshipGmailClient */

/** @param {unknown} value */
function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value */
function stringValue(value) { return typeof value === 'string' ? normalizeText(value) : ''; }

/** @param {string} value */
function lower(value) { return stringValue(value).toLowerCase(); }

/** @param {string} host */
function rootHost(host) {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  return labels.length >= 2 ? labels.slice(-2).join('.') : host.toLowerCase();
}

/** @param {string} email */
function emailDomain(email) { return lower(email.split('@')[1] || ''); }

/** @param {string} email */
function isProfessionalEmail(email) {
  const domain = emailDomain(email);
  return Boolean(domain) && !FREE_EMAIL_DOMAINS.has(domain);
}

/** @param {string} value */
function slug(value) {
  return lower(value).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'relationship';
}

/** @param {Record<string, unknown>} profile */
export function configuredRelationshipSources(profile = {}) {
  const policy = recordValue(profile.outreach_policy);
  const configured = policy.relationshipSources || policy.relationship_sources;
  if (!Array.isArray(configured)) return DEFAULT_RELATIONSHIP_SOURCES.map((source) => ({ ...source, terms: [...source.terms], domains: [...source.domains] }));
  const sources = configured
    .filter((source) => source && typeof source === 'object')
    .map((source) => {
      const entry = recordValue(source);
      return {
        name: stringValue(entry.name),
        terms: Array.isArray(entry.terms) ? entry.terms.map(stringValue).filter(Boolean) : [],
        domains: Array.isArray(entry.domains) ? entry.domains.map((domain) => rootHost(stringValue(domain))).filter(Boolean) : [],
      };
    })
    .filter((source) => source.name && (source.terms.length || source.domains.length));
  return sources.length ? sources : DEFAULT_RELATIONSHIP_SOURCES.map((source) => ({ ...source, terms: [...source.terms], domains: [...source.domains] }));
}

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} profile */
function companyDomains(item, profile) {
  const domains = new Set();
  const urls = [item.companyWebsite, item.companyUrl, item.employerUrl, item.applyUrl, item.canonicalUrl]
    .map(stringValue)
    .filter(Boolean);
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      const domain = rootHost(parsed.hostname);
      if (domain && !isProviderGeneratedContactDomain(domain)) domains.add(domain);
    } catch { /* non-URL company metadata is ignored */ }
  }
  const company = lower(item.company);
  for (const source of configuredRelationshipSources(profile)) {
    if (source.terms.some((term) => company.includes(lower(term)))) {
      for (const domain of source.domains) domains.add(domain);
    }
  }
  return domains;
}

/** @param {Record<string, unknown>} item */
function companyPhrase(item) {
  return stringValue(item.company).replace(/["']/g, '').trim();
}

/** @param {string} title */
function roleSearchPhrase(title) {
  const text = lower(title);
  if (/data|analytics|warehouse|pipeline|sql/.test(text)) return 'data engineering';
  if (/ai|machine learning|ml|llm|genai|agent/.test(text)) return 'AI engineering';
  if (/backend|back-end|api|platform|infrastructure/.test(text)) return 'backend engineering';
  if (/full[- ]stack|frontend|front-end|product/.test(text)) return 'software engineering';
  return stringValue(title).split(/\s+/).slice(0, 4).join(' ');
}

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} profile */
export function buildRelationshipDiscoveryPlan(item, profile = {}) {
  const company = companyPhrase(item);
  const title = stringValue(item.title).replace(/["']/g, '').trim();
  const gmailQueries = [];
  const webPlans = [];
  const domains = companyDomains(item, profile);
  const sources = configuredRelationshipSources(profile);

  if (company) gmailQueries.push(`in:anywhere "${company}" newer_than:1825d`);
  for (const domain of domains) {
    gmailQueries.push(`in:anywhere {from:(${domain}) to:(${domain}) cc:(${domain})} newer_than:1825d`);
  }

  for (const source of sources) {
    const term = source.terms[0] || source.name;
    const sourceIsTargetEmployer = source.terms.some((candidate) => lower(company).includes(lower(candidate)));
    const target = sourceIsTargetEmployer ? term : company;
    if (company && title) {
      webPlans.push({ query: `site:linkedin.com/in "${target}" "${roleSearchPhrase(title)}" "${term}" recruiter`, sourceName: source.name });
      webPlans.push({ query: `site:linkedin.com/in "${target}" "${roleSearchPhrase(title)}" "${term}" "engineering manager" team`, sourceName: source.name });
    }
  }

  return {
    gmailQueries: [...new Set(gmailQueries)].slice(0, MAX_GMAIL_QUERIES),
    webPlans: webPlans.slice(0, MAX_WEB_QUERIES),
    webQueries: [...new Set(webPlans.map((plan) => plan.query))].slice(0, MAX_WEB_QUERIES),
  };
}

/** @param {string} value */
function titleCaseLocalPart(value) {
  return value
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

/** @param {string} email */
function contactNameFromEmail(email) {
  const local = email.split('@')[0] || '';
  return titleCaseLocalPart(local) || 'Professional contact';
}

/** @param {string} value */
function isIgnoredMailbox(value) {
  const local = lower(value.split('@')[0] || '');
  return IGNORED_MAILBOXES.has(local);
}

/** @param {string} value */
function parseAddressHeader(value) {
  const addresses = [];
  const pattern = /(?:^|,)\s*(?:"?([^"<>,]+?)"?\s*)?<([^>]+)>|(?:^|,)\s*([^\s,<>]+@[^\s,<>]+)/g;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    const email = stringValue(match[2] || match[3]).toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    addresses.push({
      name: stringValue(match[1]) || contactNameFromEmail(email),
      email,
    });
  }
  return addresses;
}

/** @param {Record<string, unknown>} message @param {string} name */
function messageHeader(message, name) {
  const payload = recordValue(message.payload);
  const headers = Array.isArray(payload.headers) ? payload.headers : [];
  return stringValue(headers.find((header) => lower(stringValue(recordValue(header).name)) === name.toLowerCase())?.value);
}

/** @param {string} email @param {Set<string>} domains */
function matchesDomain(email, domains) {
  const domain = emailDomain(email);
  return [...domains].some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`) || candidate.endsWith(`.${domain}`));
}

/** @param {string} text @param {RelationshipSource} source */
function matchesSourceText(text, source) {
  const haystack = lower(text);
  return source.terms.some((term) => haystack.includes(lower(term)));
}

/** @param {string} email @param {Record<string, unknown>} item @param {Record<string, unknown>} profile */
function relationshipForEmail(email, item, profile) {
  const companyMatch = matchesDomain(email, companyDomains(item, profile));
  if (companyMatch) {
    return {
      type: 'existing_target_company_relationship',
      label: 'Existing professional relationship',
      relevance: 'high',
    };
  }
  // A relationship-source address proves that the candidate knows the person;
  // it does not prove that the person works for the application employer. Warm
  // network searches may still locate alumni or former colleagues through
  // public current-employer evidence, but Gmail correspondence alone must not
  // turn a professor or former coworker into a contact for every company.
  return null;
}

/** @param {Array<Record<string, unknown>>} messages @param {Record<string, unknown>} item @param {Record<string, unknown>} profile */
export function extractGmailRelationshipContacts(messages, item, profile = {}) {
  const candidateByEmail = new Map();
  const candidateEmail = lower(stringValue(recordValue(profile.candidate).email));
  for (const message of messages) {
    const messageId = stringValue(message.id);
    if (!messageId) continue;
    const from = messageHeader(message, 'from');
    const to = messageHeader(message, 'to');
    const cc = messageHeader(message, 'cc');
    const subject = messageHeader(message, 'subject');
    const addresses = [...parseAddressHeader(from), ...parseAddressHeader(to), ...parseAddressHeader(cc)];
    for (const address of addresses) {
      if (address.email === candidateEmail
        || !isProfessionalEmail(address.email)
        || isIgnoredMailbox(address.email)
        || isProviderGeneratedContactEmail(address.email)) continue;
      const relationship = relationshipForEmail(address.email, item, profile);
      if (!relationship) continue;
      const generic = /^(?:careers?|jobs?|recruit(?:ing|ment)|talent|hiring|people|hr|humanresources|employment)$/i.test(address.email.split('@')[0] || '');
      const contact = {
        name: generic ? 'Recruiting Team' : address.name,
        title: generic ? 'Recruiting' : relationship.label,
        company: stringValue(item.company),
        email: address.email,
        emailVerified: true,
        emailVerificationType: 'first-party-relationship',
        publicProfessional: true,
        guessed: false,
        private: false,
        relationshipVerified: true,
        relationshipType: relationship.type,
        relationshipLabel: relationship.label,
        connection: true,
        sourceType: 'first-party-relationship',
        sourceUrl: null,
        profileUrl: null,
        sourceMessageId: messageId,
        sourceMailbox: 'jakyejobs@gmail.com',
        sourceSubjectPresent: Boolean(subject),
        roleRelevance: relationship.relevance,
      };
      const current = candidateByEmail.get(address.email);
      if (!current || (contact.roleRelevance === 'high' && current.roleRelevance !== 'high')) candidateByEmail.set(address.email, contact);
    }
  }
  return [...candidateByEmail.values()];
}

/** @param {Array<Record<string, unknown>>} results @param {Record<string, unknown>} item @param {RelationshipSource} source */
export function extractWarmWebContacts(results, item, source) {
  const contacts = [];
  for (const result of results) {
    const evidence = [result.title, result.description, result.markdown].map(stringValue).join('\n');
    if (!matchesSourceText(evidence, source)) continue;
    for (const contact of extractPublicContacts([result], item)) {
      contacts.push({
        ...contact,
        relationshipType: `public_${slug(source.name)}_network`,
        relationshipLabel: `Public ${source.name} network signal`,
        relationshipSource: source.name,
        relationshipEvidenceUrl: normalizeUrl(stringValue(result.url)) || null,
        roleRelevance: contact.roleRelevance || 'medium',
      });
    }
  }
  return contacts;
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown>} profile
 * @param {{
 *   dryRun?: boolean,
 *   gmailClient?: RelationshipGmailClient | null,
 *   searchFn?: typeof searchPublicWeb,
 *   env?: Record<string, string | undefined>,
 *   fetchFn?: (input: string, init?: RequestInit) => Promise<Response>,
 *   sourceState?: { publicSearchUnavailableReason?: string },
 * }} [options]
 */
export async function discoverWarmContactsForApplication(item, profile = {}, options = {}) {
  const plan = buildRelationshipDiscoveryPlan(item, profile);
  if (options.dryRun) {
    return {
      status: 'dry_run',
      reason: 'dry-run does not inspect Gmail or public relationship sources',
      contacts: [],
      gmailQueries: plan.gmailQueries,
      webQueries: plan.webQueries,
      sources: [],
      errors: [],
    };
  }

  const contacts = [];
  const sources = [];
  const errors = [];
  const warnings = [];
  if (options.gmailClient) {
    const messageById = new Map();
    for (const query of plan.gmailQueries) {
      try {
        const summaries = await options.gmailClient.listMessages(query, { limit: MAX_GMAIL_MESSAGES });
        for (const summary of summaries) {
          if (!summary.id || messageById.has(summary.id)) continue;
          try {
            const message = await options.gmailClient.getMessage(summary.id, 'full');
            messageById.set(summary.id, message);
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    contacts.push(...extractGmailRelationshipContacts([...messageById.values()], item, profile));
  } else {
    warnings.push('Gmail relationship search is unavailable; only public relationship sources can be checked.');
  }

  const searchFn = options.searchFn || searchPublicWeb;
  const sourcesByName = new Map(configuredRelationshipSources(profile).map((source) => [source.name, source]));
  let publicSearchUnavailableReason = stringValue(options.sourceState?.publicSearchUnavailableReason);
  for (const webPlan of plan.webPlans) {
    if (publicSearchUnavailableReason) break;
    const query = webPlan.query;
    const source = sourcesByName.get(webPlan.sourceName);
    if (!source) continue;
    try {
      const results = await searchFn(query, { limit: 5, env: options.env, fetchFn: options.fetchFn });
      for (const result of results) {
        const url = normalizeUrl(stringValue(result.url));
        if (url) sources.push(url);
      }
      contacts.push(...extractWarmWebContacts(results, item, source));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      const failure = classifyPublicSearchFailure(error);
      if (failure) {
        publicSearchUnavailableReason = failure.reason;
        if (options.sourceState) options.sourceState.publicSearchUnavailableReason = failure.reason;
        break;
      }
    }
  }

  const deduped = new Map();
  for (const contact of contacts) {
    const key = lower(contact.email || contact.profileUrl || contact.name);
    if (key && !deduped.has(key)) deduped.set(key, contact);
  }
  const uniqueContacts = [...deduped.values()];
  const unavailable = !uniqueContacts.length && publicSearchUnavailableReason && !options.gmailClient;
  return {
    status: uniqueContacts.length ? 'found' : unavailable ? 'unavailable' : 'no_contacts',
    reason: uniqueContacts.length
      ? `found ${uniqueContacts.length} warm-network contact candidate(s)`
      : unavailable
        ? `warm-network discovery is unavailable: ${publicSearchUnavailableReason}`
        : publicSearchUnavailableReason
          ? `no Gmail relationship found; public network search is unavailable: ${publicSearchUnavailableReason}`
          : 'no warm-network contact path found after Gmail and public network search',
    contacts: uniqueContacts,
    gmailQueries: plan.gmailQueries,
    webQueries: plan.webQueries,
    sources: [...new Set(sources)].slice(0, 20),
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  };
}
