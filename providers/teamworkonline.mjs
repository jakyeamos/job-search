// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// TeamWork Online's public category pages are server-rendered HTML, not an
// ATS feed. Keep this provider read-only, host-pinned, and page-bounded.
// Configure with `provider: teamworkonline` and a public category URL.

const TRUSTED_HOSTS = new Set(['teamworkonline.com', 'www.teamworkonline.com']);
const DEFAULT_URL = 'https://www.teamworkonline.com/sports-technology-jobs/sports-technology-careers/sports-technology-jobs';
const DEFAULT_MAX_PAGES = 8;
const MAX_PAGES_CAP = 12;
const JOB_ID_RE = /-\d{5,}(?:$|[?#])/;
const JOB_DETAILS_RE = /<div\b[^>]*class=["'][^"']*\borganization-portal__job-details\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;

/** @param {unknown} value */
function compact(value) {
  return decodeHtmlEntities(stripTags(String(value || ''))).replace(/\s+/g, ' ').trim();
}

/** @param {string} value */
function stripTags(value) {
  return value.replace(/<[^>]*>/g, ' ');
}

/** @param {string} value */
function decodeHtmlEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => codePoint(Number(decimal)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/** @param {number} value */
function codePoint(value) {
  try {
    return String.fromCodePoint(value);
  } catch {
    return '';
  }
}

/** @param {string} html @param {string} tag @param {string} className */
function classElement(html, tag, className) {
  const escapedClass = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<${tag}\\b[^>]*class=["'][^"']*\\b${escapedClass}\\b[^"']*["'][^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1] || '';
}

/** @param {string} html @param {string} baseUrl */
function cleanJobUrl(html, baseUrl) {
  const match = html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (!match) return '';
  try {
    const parsed = new URL(decodeHtmlEntities(match[1]), baseUrl);
    if (parsed.protocol !== 'https:' || !TRUSTED_HOSTS.has(parsed.hostname.toLowerCase()) || !JOB_ID_RE.test(parsed.pathname)) return '';
    parsed.hostname = 'www.teamworkonline.com';
    parsed.hash = '';
    parsed.search = '';
    return parsed.href;
  } catch {
    return '';
  }
}

/** @param {Record<string, unknown>} entry */
function maxPagesFor(entry) {
  const configured = Number(entry?.max_pages);
  return Number.isInteger(configured) && configured > 0
    ? Math.min(configured, MAX_PAGES_CAP)
    : DEFAULT_MAX_PAGES;
}

/** @param {Record<string, unknown>} entry */
function excludedCareerLevels(entry) {
  return Array.isArray(entry?.exclude_career_levels)
    ? entry.exclude_career_levels.map((value) => compact(value).toLowerCase()).filter(Boolean)
    : [];
}

/** @param {string} url */
function assertListingUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`teamworkonline: invalid listing URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' || !TRUSTED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`teamworkonline: untrusted listing host: ${url}`);
  }
  parsed.hostname = 'www.teamworkonline.com';
  return parsed.href;
}

/** @param {string} baseUrl @param {number} page */
function pageUrl(baseUrl, page) {
  const parsed = new URL(baseUrl);
  if (page === 1) parsed.searchParams.delete('page');
  else parsed.searchParams.set('page', String(page));
  return parsed.href;
}

/**
 * Parse one public TeamWork Online category page.
 * @param {string} html
 * @param {string} baseUrl
 * @param {{ excludedCareerLevels?: string[] }} [options]
 * @returns {Array<{title: string, url: string, company: string, location: string, careerLevel?: string}>}
 */
export function parseTeamworkOnlinePage(html, baseUrl = DEFAULT_URL, options = {}) {
  if (typeof html !== 'string' || !html.includes('organization-portal__job-details')) return [];
  const excluded = new Set((options.excludedCareerLevels || []).map((value) => compact(value).toLowerCase()).filter(Boolean));
  const jobs = [];
  const seen = new Set();
  let match;
  while ((match = JOB_DETAILS_RE.exec(html)) !== null) {
    const block = match[1];
    const titleBlock = classElement(block, 'h3', 'organization-portal__job-title');
    const title = compact(titleBlock.replace(/<a\b[^>]*>/i, '').replace(/<\/a>/i, ''));
    const url = cleanJobUrl(titleBlock, baseUrl);
    const company = compact(classElement(block, 'p', 'organization-portal__job-category'));
    const location = compact(classElement(block, 'p', 'organization-portal__job-location'));
    const careerLevel = compact(classElement(block, 'span', 'organization-portal__job__career-level'));
    if (!title || !url || !company || seen.has(url)) continue;
    if (careerLevel && [...excluded].some((level) => careerLevel.toLowerCase() === level || careerLevel.toLowerCase().includes(level))) continue;
    seen.add(url);
    jobs.push({ title, url, company, location, ...(careerLevel ? { careerLevel } : {}) });
  }
  return jobs;
}

/** @param {string} html */
function hasNextPage(html) {
  return /<a\b[^>]*rel=["']next["'][^>]*>/i.test(html);
}

/** @type {Provider} */
export default {
  id: 'teamworkonline',

  detect(entry) {
    if (entry?.provider !== 'teamworkonline') return null;
    return { url: assertListingUrl(typeof entry.careers_url === 'string' ? entry.careers_url : DEFAULT_URL) };
  },

  async fetch(entry, ctx) {
    const baseUrl = assertListingUrl(typeof entry?.careers_url === 'string' ? entry.careers_url : DEFAULT_URL);
    const excluded = excludedCareerLevels(entry);
    const jobs = [];
    const seen = new Set();
    for (let page = 1; page <= maxPagesFor(entry); page++) {
      const url = pageUrl(baseUrl, page);
      const html = await ctx.fetchText(url, { redirect: 'error' });
      if (!html.includes('organization-portal__job-details')) {
        throw new Error(`teamworkonline: unexpected listing response on page ${page}`);
      }
      for (const job of parseTeamworkOnlinePage(html, url, { excludedCareerLevels: excluded })) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      if (!hasNextPage(html)) break;
    }
    return jobs;
  },
};
