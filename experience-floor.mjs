// @ts-check
/**
 * Context-aware years-of-experience floor extraction.
 *
 * Replaces a blunt `/[3-9]\+? years?/` match that fired on benefits prose
 * ("25 days after five years of service"), business copy ("payback in one to
 * three years"), and low-floor ranges ("1 to 3 years of professional
 * experience") that are genuinely new-grad friendly.
 *
 * This module only reports the floor. The graduated response to it lives in
 * `scoreCandidate()` (`queue-lib.mjs`), governed by `modes/_profile.md` ->
 * "Your Scoring Rules".
 */

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const NUM = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)';

/** Matches `3+ years`, `3-5 years`, `1 to 3 yrs`, `three years`, `5+ years'`. */
const QUANTITY_RE = new RegExp(
  `\\b${NUM}\\s*(?:(\\+)|(?:-|to|through)\\s*${NUM})?\\s*\\+?\\s*(?:years?|yrs?)\\b`,
  'gi',
);

/**
 * Contexts where a year count is not a hiring bar: tenure-based benefits,
 * company history, product ROI copy, degree program length.
 */
const NEGATIVE_CONTEXT_RE = new RegExp([
  'vest(?:ing|ed)?',
  'years? of service',
  'years? of employment',
  'years? with (?:the|our) (?:company|firm|team)',
  'anniversar',
  'accrual|accrue',
  'vacation|pto\\b|paid time off|sabbatical|parental leave',
  'tuition|401\\s*\\(?k\\)?|retirement|pension',
  'payback|roi\\b|warranty|amortiz|lease|contract term',
  'founded|since \\d{4}|over the (?:past|last)|for the (?:past|last)|in the (?:past|last)',
  'years? old|age of',
  '(?:\\d{1,2}|two|three|four|five)[-\\s]?years?\\s+(?:degree|program|university|college|school|institution|course|apprenticeship)',
  // describing the people you'd work with, not the bar you must clear
  'work(?:ing)? (?:with|alongside|among|next to)|engineers who|colleagues who|teammates who|peers who|mentors?\\b|average of|median of',
].join('|'), 'i');

/** A year count only counts as a hiring bar next to one of these. */
const EXPERIENCE_ANCHOR_RE = /\b(experience|experienced|background|expertise|track record|professional|industry|worked|working|career)\b/i;

/** `Preferred qualifications:` / `Nice to have -` style headings. */
const PREFERRED_HEADING_RE = /\b(?:preferred|nice[-\s]?to[-\s]?have|bonus|desirable|desired|good[-\s]to[-\s]have)\b\s*(?:qualifications?|skills?|experience|requirements?)?\s*[:•\-]/i;
/** `... is a plus`, `... preferred` trailing the requirement itself. */
const PREFERRED_TRAILING_RE = /\b(?:is a plus|are a plus|a plus\b|preferred\b|a bonus\b|nice to have|not required)/i;

const BACK_WINDOW = 130;
const FORWARD_WINDOW = 90;
const PREFERRED_BACK_WINDOW = 150;
const PREFERRED_FORWARD_WINDOW = 100;

/** @param {string} value @returns {string} */
function normalize(value) {
  return String(value || '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&amp;?/gi, '&')
    .replace(/&(?:#39|apos|rsquo|lsquo);?/gi, "'")
    .replace(/&(?:quot|ldquo|rdquo);?/gi, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Keep a preference cue from leaking across a sentence boundary -- otherwise
 * "Requirements: 2+ years... Preferred: 8+ years" reads the second heading as
 * softening the first requirement.
 *
 * @param {string} window
 * @param {'back'|'forward'} side
 * @returns {string}
 */
function clipToSentence(window, side) {
  if (side === 'back') {
    const cut = window.lastIndexOf('.');
    return cut === -1 ? window : window.slice(cut + 1);
  }
  const cut = window.search(/[.;•]/);
  return cut === -1 ? window : window.slice(0, cut);
}

/** @param {string} token @returns {number|null} */
function toNumber(token) {
  if (!token) return null;
  const lower = token.toLowerCase();
  if (lower in WORD_NUMBERS) return WORD_NUMBERS[/** @type {keyof WORD_NUMBERS} */ (lower)];
  const parsed = Number.parseInt(lower, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @typedef {{ floor: number, required: boolean, evidence: string }} FloorMatch
 * @typedef {{ floor: number|null, required: boolean, evidence: string|null, matches: FloorMatch[] }} FloorResult
 */

/**
 * Extract the binding years-of-experience floor from posting text.
 *
 * Two different aggregations, because they answer different questions:
 * - Within one stated range, take the LOW end -- `1-4 years` admits a 1-year
 *   candidate, so the bar is 1.
 * - Across separate statements, take the HIGH one -- requirement bullets are
 *   conjunctive. A posting asking for `5+ years Java` and `1+ years B2B` wants
 *   both, so the bar is 5.
 *
 * Required floors, when any exist, shadow preferred ones entirely.
 *
 * @param {string} raw title and/or description text
 * @returns {FloorResult}
 */
export function detectExperienceFloor(raw) {
  const text = normalize(raw);
  /** @type {FloorMatch[]} */
  const matches = [];
  if (!text) return { floor: null, required: true, evidence: null, matches };

  QUANTITY_RE.lastIndex = 0;
  let match;
  while ((match = QUANTITY_RE.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const back = clipToSentence(text.slice(Math.max(0, start - BACK_WINDOW), start), 'back');
    const forward = clipToSentence(text.slice(end, end + FORWARD_WINDOW), 'forward');
    const window = `${back}${match[0]}${forward}`;

    if (NEGATIVE_CONTEXT_RE.test(window)) continue;
    if (!EXPERIENCE_ANCHOR_RE.test(window)) continue;

    const low = toNumber(match[1]);
    if (low === null) continue;

    const preferredBack = clipToSentence(text.slice(Math.max(0, start - PREFERRED_BACK_WINDOW), start), 'back');
    const preferredForward = clipToSentence(text.slice(end, end + PREFERRED_FORWARD_WINDOW), 'forward');
    const required = !PREFERRED_HEADING_RE.test(preferredBack)
      && !PREFERRED_TRAILING_RE.test(preferredForward);

    matches.push({ floor: low, required, evidence: window.trim() });
  }

  const requiredFloors = matches.filter((m) => m.required);
  const pool = requiredFloors.length > 0 ? requiredFloors : matches;
  if (pool.length === 0) return { floor: null, required: true, evidence: null, matches };

  const winner = pool.reduce((highest, m) => (m.floor > highest.floor ? m : highest));
  return {
    floor: winner.floor,
    required: requiredFloors.length > 0,
    evidence: winner.evidence,
    matches,
  };
}
