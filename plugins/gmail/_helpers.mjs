// @ts-check
// Pure, side-effect-free Gmail helpers. Ported verbatim from the gmail-helpers
// contributed by @SparshGarg999 in #1203 (with thanks). Files prefixed with _
// are never discovered as plugins.

/**
 * Extract all http/https URLs from a string (plain text or HTML). Normalizes
 * &amp; and strips trailing punctuation. Dedups.
 * @param {string} body
 * @returns {string[]}
 */
export function extractUrls(body) {
  if (!body) return [];
  const urls = [];
  const regex = /https?:\/\/[^\s"'<>\(\)]+/gi;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const url = match[0].replace(/[.,;:!?]+$/, '').replace(/&amp;/g, '&');
    urls.push(url);
  }
  return [...new Set(urls)];
}

const TRACKER_HOST_RE = /^(?:email|click|clicks|tracking|track|redirect)\./i;
const TRACKER_PATH_RE = /(?:^|\/)(?:e\/c|click|redirect|track|unsubscribe)(?:\/|$)/i;

/**
 * Is a URL clean and relevant (not a click tracker, unsubscribe link, or pixel)?
 * @param {string} url
 * @returns {boolean}
 */
export function isCleanUrl(url) {
  try {
    const u = new URL(url);
    const lowerUrl = url.toLowerCase();
    const hostname = u.hostname.toLowerCase();
    const pathname = u.pathname.toLowerCase();
    const badKeywords = [
      'click', 'track', 'openpixel', 'sendgrid', 'unsubscribe', 'optout',
      'newsletter', 'subscribe', 'w3.org', 'doubleclick', 'googlesyndication',
      'googleadservices', 'mailgun', 'mandrill', 'mjml', 'github.com/login',
      'linkedin.com/legal', 'linkedin.com/help', 'linkedin.com/settings',
    ];
    if (badKeywords.some(kw => lowerUrl.includes(kw))) return false;
    if (hostname === 'accounts.google.com' || hostname === 'myaccount.google.com'
      || hostname === 'gstatic.com' || hostname.endsWith('.gstatic.com')
      || hostname.endsWith('.googleusercontent.com') || hostname === 'facebook.com'
      || hostname.endsWith('.facebook.com') || hostname === 'instagram.com'
      || hostname.endsWith('.instagram.com') || hostname.startsWith('scontent.')
      || hostname.endsWith('.fbcdn.net')) return false;
    if (TRACKER_HOST_RE.test(hostname) || TRACKER_PATH_RE.test(pathname)) return false;
    if (/\.(?:apng|avif|css|gif|ico|jpe?g|js|png|svg|webm|webp|woff2?)(?:$|\?)/i.test(pathname)) return false;
    if (/(?:^|\/)(?:accountchooser|banner-image|email_open|logo|notifications|privacy|pixel|session)(?:\/|\.|$)/i.test(pathname)) return false;
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

const JOB_LINK_TEXT_RE = /\b(?:apply|career|careers|job|jobs|opening|opportunity|position|role|view)\b/i;
const KNOWN_JOB_HOST_RE = /(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|teamworkonline\.com|builtin\.com|wellfound\.com|joinhandshake\.com|linkedin\.com|glassdoor\.|sapsf\.com)/i;
const ATS_HOST_RE = /(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|icims\.com)/i;
const JOB_DETAIL_PATH_RE = /(?:^|\/)(?:jobs?|careers?|roles?|positions?|opportunities?|apply|view)(?:\/|$)|(?:^|\/)[^/]+-jobs?(?:\/|$)/i;
const LINKEDIN_HOST_RE = /(?:^|\.)linkedin\.com$/i;
const TEAMWORK_HOST_RE = /(?:^|\.)teamworkonline\.com$/i;
const TEAMWORK_TRACKER_HOST_RE = /^(?:[^.]+\.)?teamworkonline\.com$/i;
const TEAMWORK_JOB_PATH_RE = /(?:^|\/)(?:jobs?|[^/]+-jobs?)(?:\/|$)/i;
const GLASSDOOR_HOST_RE = /(?:^|\.)glassdoor\./i;
const TRACKING_PARAM_RE = /^(?:utm_[a-z0-9_]+|fbclid|gclid|mc_cid|mc_eid|trk|trkid|trks|trackingid|trkemail|refid|lipi|midtoken|midsig|eid|otptoken|twclid|guid|jrtk|tgt|origin|origintolandingjobpostings|src)$/i;

/** @param {string} value */
function stripTags(value) {
  return value.replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39|nbsp);|&#160;/g, (entity) => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&#160;': ' ',
  }[entity] || ' ')).replace(/\s+/g, ' ').trim();
}

/** @param {string} url @returns {string} */
export function sanitizeJobUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (GLASSDOOR_HOST_RE.test(parsed.hostname) && /\/partner\/joblisting\.htm$/i.test(parsed.pathname)) {
      const jobListingId = parsed.searchParams.get('jobListingId');
      return jobListingId
        ? `${parsed.origin}${parsed.pathname}?jobListingId=${encodeURIComponent(jobListingId)}`
        : '';
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAM_RE.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

/** @param {string} url @param {string} anchorText */
function looksLikeJobUrl(url, anchorText = '') {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    if (TRACKER_HOST_RE.test(host) || TRACKER_PATH_RE.test(path)) return false;
    if (LINKEDIN_HOST_RE.test(host)) {
      return /^\/(?:comm\/)?jobs\/view\/\d+(?:\/|$)/i.test(path);
    }
    if (TEAMWORK_HOST_RE.test(host)) {
      return TEAMWORK_JOB_PATH_RE.test(path) && /(?:^|[-\/])\d{5,}(?:\/|$)/.test(path);
    }
    if (GLASSDOOR_HOST_RE.test(host)) {
      return /\/partner\/joblisting\.htm$/i.test(path) && parsed.searchParams.has('jobListingId');
    }
    if (ATS_HOST_RE.test(host)) return path.split('/').filter(Boolean).length >= 2;
    if (JOB_DETAIL_PATH_RE.test(path) && path.split('/').filter(Boolean).length >= 2) return true;
    if (KNOWN_JOB_HOST_RE.test(host)) return false;
    return Boolean(anchorText) && JOB_LINK_TEXT_RE.test(anchorText) && !KNOWN_JOB_HOST_RE.test(host);
  } catch {
    return false;
  }
}

/** @param {string} url @param {string} anchorText */
function isTrustedTeamworkTracker(url, anchorText = '') {
  try {
    const parsed = new URL(url);
    const text = anchorText.trim();
    const nonJobText = /\b(?:unsubscribe|preferences|notification|profile|part\s+time|see\s+more\s+jobs|teamwork\s+online|mvp\s+access|teamworku|teamwork\s+consulting)\b/i;
    const jobText = /\b(?:view\s+job|hiring|engineer|developer|analyst|analytics|associate|manager|director|coordinator|producer|designer|software|data|product|operations?|marketing|sales|finance|accounting|consultant|research|scout|coach|trainer|intern|writer|editor|content|technology|technical|business)\b/i;
    return TEAMWORK_TRACKER_HOST_RE.test(parsed.hostname)
      && /^\/ls\/click\/?$/i.test(parsed.pathname)
      && !nonJobText.test(text)
      && jobText.test(text);
  } catch {
    return false;
  }
}

/** @param {string} url */
function isTrustedLinkedInJobUrl(url) {
  try {
    const parsed = new URL(url);
    return LINKEDIN_HOST_RE.test(parsed.hostname)
      && /^\/(?:comm\/)?jobs\/view\/\d+(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Extract likely job links from an email, preferring anchor targets over
 * decorative HTML assets and account/social links.
 * @param {string} body
 * @returns {string[]}
 */
export function extractJobUrls(body) {
  if (!body) return [];
  const candidates = [];
  const hasAnchors = /<a\b/i.test(body);
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(body)) !== null) {
    const url = match[1].replace(/&amp;/g, '&');
    const text = stripTags(match[2]);
    const trustedLinkedIn = isTrustedLinkedInJobUrl(url);
    const trustedTeamwork = isTrustedTeamworkTracker(url, text);
    const directTextUrl = extractUrls(text).find((candidate) => isCleanUrl(candidate) && looksLikeJobUrl(candidate, text));
    if (directTextUrl) {
      const sanitized = sanitizeJobUrl(directTextUrl);
      if (sanitized) candidates.push(sanitized);
    } else if (trustedLinkedIn || trustedTeamwork || (isCleanUrl(url) && looksLikeJobUrl(url, text))) {
      const sanitized = sanitizeJobUrl(url).replace(/^http:/i, 'https:');
      if (sanitized) candidates.push(sanitized);
    }
  }
  if (!hasAnchors) {
    for (const url of extractUrls(body)) {
      if (isCleanUrl(url) && looksLikeJobUrl(url)) {
        const sanitized = sanitizeJobUrl(url);
        if (sanitized) candidates.push(sanitized);
      }
    }
  }
  return [...new Set(candidates)];
}

/**
 * DMARC alignment check (anti-spoof gate, fail-closed). Only emails whose
 * Authentication-Results header reports dmarc=pass are trusted.
 * @param {Array<{ name: string, value: string }>} headers
 * @returns {boolean}
 */
export function isAuthenticEmail(headers) {
  if (!Array.isArray(headers)) return false;
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === 'authentication-results') {
      if (h.value && /dmarc=pass/i.test(h.value)) return true;
    }
  }
  return false;
}

// Alert digests append a tail to the FIRST job's "{Role} at {Company}":
//   "Data Analyst at F-ADA and 7 more jobs in New York, NY for you. Apply Now."
// The company capture is greedy, so without this the whole tail lands in `company`
// — and it is short enough to slip past a length check.
const DIGEST_TAIL = /\s+(?:and|&)\s+\d+\s+(?:more|other)\b/i;
const CTA_TAIL = /\s*(?:[-–—|]\s*)?(?:apply now|apply today|see (?:all|more)|view job)\b[\s\S]*$/i;

/**
 * Parse "{Role} at {Company}" from a subject line.
 *
 * `digest` marks a subject that describes more than the one job — the caller must
 * not stamp these values onto every URL in the message.
 * @param {string} subject
 * @returns {{ role: string, company: string, digest: boolean } | null}
 */
export function parseRoleAtCompany(subject) {
  if (!subject) return null;
  let clean = subject.replace(/^(re|fwd|new match|job alert|alert|match|notification|alert for|daily alert for):\s*/i, '').trim();
  clean = clean.split(/\s+[-|]\s+/)[0].trim();
  const digest = DIGEST_TAIL.test(clean) || /\b\d+\s+new jobs?\b/i.test(clean);
  clean = clean.split(DIGEST_TAIL)[0].replace(CTA_TAIL, '').trim();
  const match = clean.match(/^(.+?)\s+at\s+(.+)$/i);
  if (match) {
    const role = match[1].trim();
    const company = match[2]
      .replace(/\s+for you\b[\s\S]*$/i, '')
      .replace(/[\s.,;:!]+$/, '')
      .trim();
    // A real company name is short and few-worded ("Bank of New York Mellon" is five).
    // Anything past that is leftover subject-line prose, not a name.
    const words = company.split(/\s+/).filter(Boolean).length;
    if (role && company && role.length < 100 && company.length < 60 && words <= 6) {
      return { role, company, digest };
    }
  }
  return null;
}

/**
 * Recursively decode a Gmail message payload's base64url body parts to text.
 * @param {any} payload
 * @returns {string}
 */
export function getMessageBody(payload) {
  if (!payload) return '';
  let body = '';
  if (payload.body && payload.body.data) {
    const base64 = payload.body.data.replace(/-/g, '+').replace(/_/g, '/');
    body += Buffer.from(base64, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) body += getMessageBody(part);
  }
  return body;
}

/**
 * Best-effort company name from a known ATS URL (greenhouse/lever slug).
 * @param {string} url
 * @returns {string}
 */
export function companyFromUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname === 'boards.greenhouse.io' || hostname.endsWith('.greenhouse.io') ||
        hostname === 'jobs.lever.co' || hostname.endsWith('.lever.co')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length > 0) return parts[0];
    }
  } catch { /* malformed → no company */ }
  return '';
}
