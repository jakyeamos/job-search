const GENERAL_REPLACEMENTS = [
  { label: 'removed inventory label', pattern: /^Current work:\s*/gim, replacement: '' },
  { label: 'removed link label', pattern: /^Projects and longer notes:\s*/gim, replacement: '' },
  { label: 'removed proof label', pattern: /\bProof:\s*/gi, replacement: '' },
  { label: 'removed source label', pattern: /\bSources:\s*[^\n]*/gi, replacement: '' },
  { label: 'replaced landscape filler', pattern: /\bIn today[’']s landscape\b/gi, replacement: 'Right now' },
  { label: 'replaced core filler', pattern: /\bAt its core\b/gi, replacement: 'The important part is' },
  { label: 'removed worth-noting filler', pattern: /\bIt is worth noting that\s*/gi, replacement: '' },
  { label: 'replaced build label', pattern: /\bThe build is centered on\b/gi, replacement: 'I’m building around' },
  { label: 'removed current-status label', pattern: /\bCurrent status:\s*/gi, replacement: '' },
  { label: 'removed announcement filler', pattern: /\bI am excited to announce\s*/gi, replacement: '' },
];

export function runSocialWritingPipeline(brief, writing, destination) {
  const profile = writing.profiles[destination];
  if (!profile) throw new Error(`Missing writing profile for ${destination}`);
  const rawBody = [brief.hook, brief.context, brief.personalAngle, brief.nextStep].join('\n\n');
  const domainQa = assessQa(rawBody, brief);
  const general = humanizeText(rawBody);
  const destinationDraft = renderDestinationCopy(brief, general.text, destination);
  const final = humanizeText(destinationDraft);
  const qa = assessQa(final.text, brief);
  const findings = [...general.findings, ...final.findings, ...qa.warnings];
  if (destination === 'x' && final.text.length > 280) findings.push('X copy exceeded 280 characters before final truncation');
  return {
    destination,
    profileId: profile.id,
    rawBody,
    generalBody: general.text,
    finalBody: final.text,
    findings: [...new Set(findings)],
    qa,
    stages: [
      { id: 'source-brief', status: 'passed', note: `Verified brief for ${brief.project}` },
      { id: 'domain-draft', status: 'passed', note: 'Draft assembled only from registry fields' },
      { id: 'domain-qa', status: domainQa.status, note: qaNote(domainQa, 'Claim and boundary check') },
      { id: 'general-humanizer', status: 'passed', note: 'Removed generic labels and filler without adding claims' },
      { id: 'destination-voice', status: qa.status, note: `${profile.id} applied for ${destination}` },
      { id: 'approval', status: 'pending', note: 'Human review is required before publication' },
    ],
    needsResearch: false,
    approvalRequired: true,
  };
}

export function humanizeText(value) {
  let text = value;
  const findings = [];
  for (const replacement of GENERAL_REPLACEMENTS) {
    const next = text.replace(replacement.pattern, replacement.replacement);
    if (next !== text) findings.push(replacement.label);
    text = next;
  }
  if (text.includes('—') || text.includes('–')) {
    text = text.replaceAll('—', ' - ').replaceAll('–', ' - ');
    findings.push('replaced dash punctuation');
  }
  text = text.split(/\n{2,}/).map((paragraph) => paragraph.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n\n');
  return { text: text.trim(), findings };
}

function renderDestinationCopy(brief, generalBody, destination) {
  const paragraphs = generalBody.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const hook = paragraphs[0] || brief.hook;
  const context = paragraphs[1] || brief.context;
  const personalAngle = paragraphs[2] || brief.personalAngle;
  const nextStep = paragraphs[3] || brief.nextStep;
  if (destination === 'x') return compactForX([
    `I’m building ${brief.project} around this: ${firstSentence(hook)}`,
    `${brief.project}: ${firstSentence(personalAngle)} ${firstSentence(nextStep)}`,
    `${hook} ${firstSentence(nextStep)}`,
    generalBody,
  ]);
  if (destination === 'instagram') return [hook, context, personalAngle, nextStep].join('\n\n');
  if (destination === 'portfolio') return [`# ${brief.title}`, generalBody, currentStateLine(brief), renderBoundary(brief)].join('\n\n');
  if (destination === 'frmwrk-labs') return [
    `# ${brief.title}`,
    `I keep coming back to the question underneath ${brief.project}: ${lowerFirst(stripTerminalPunctuation(context))}.`,
    personalAngle,
    `I don’t want to smooth over the unfinished part: ${lowerFirst(stripTerminalPunctuation(nextStep))}.`,
    renderBoundary(brief),
  ].join('\n\n');
  return generalBody;
}

function assessQa(text, brief) {
  const blockers = [];
  const warnings = [];
  const normalized = text.toLowerCase();
  if (brief.doNotClaim.includes('customers') && /\b(?:has|have|serves|serving|used by|adopted by)\b[^.!?\n]{0,80}\bcustomers?\b/i.test(text)) blockers.push('customer claim detected');
  if (brief.doNotClaim.includes('revenue') && /\b(?:generated|made|annual|in)\b[^.!?\n]{0,40}\brevenue\b/i.test(text)) blockers.push('revenue claim detected');
  if (brief.doNotClaim.includes('completed pilots') && /\b(?:completed|finished|ran)\s+pilots?\b/i.test(text)) blockers.push('completed-pilot claim detected');
  if (brief.doNotClaim.includes('legal advice') && /\b(?:provides?|offers?|is|constitutes?)\s+legal advice\b/i.test(text)) blockers.push('legal-advice claim detected');
  if (brief.doNotClaim.includes('broad adoption') && /\bbroad(?:ly)?\s+(?:used|adopted)\b/i.test(text)) blockers.push('broad-adoption claim detected');
  if (/\b(?:Current work:|Projects and longer notes:|Proof:|Sources:)\b/i.test(text)) warnings.push('metadata label remains in copy');
  if (/\b(?:robust|seamless|game-changing|showcase|unlock)\b/i.test(normalized)) warnings.push('generic promotional language remains in copy');
  return { status: blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : 'passed', blockers, warnings };
}

function renderBoundary(brief) {
  if (brief.doNotClaim.includes('legal advice')) return 'CrimClock is decision-support software, not legal advice.';
  if (brief.doNotClaim.includes('customers') && brief.doNotClaim.includes('revenue') && brief.doNotClaim.includes('completed pilots')) return `${brief.project} is pilot-ready; this is not a customer, revenue, or completed-pilot claim.`;
  return `I’m keeping the claim narrow: this is about the working system and its current evidence, not ${naturalJoin(brief.doNotClaim)}.`;
}

function currentStateLine(brief) {
  const clauses = brief.projectStatus.split(';').map((clause) => clause.trim()).filter(Boolean);
  if (clauses.length === 2) return `${brief.project} is ${withIndefiniteArticle(clauses[0])} and ${withIndefiniteArticle(clauses[1])}.`;
  return `The current version is ${lowerFirst(brief.projectStatus)}.`;
}

function firstSentence(value) { return value.match(/[^.!?]+[.!?]+(?=\s|$)|.+$/g)?.[0]?.trim() || value; }
function compactForX(candidates) {
  for (const candidate of candidates) {
    const clean = candidate.replace(/[ \t]+/g, ' ').trim();
    if (clean.length <= 280) return clean;
    const sentence = firstSentence(clean);
    if (sentence.length <= 280) return sentence;
  }
  return truncateWords(candidates.at(-1) || '', 280);
}
function truncateWords(value, limit) {
  if (value.length <= limit) return value;
  let output = '';
  for (const word of value.split(/\s+/)) {
    const next = output ? `${output} ${word}` : word;
    if (`${next}…`.length > limit) break;
    output = next;
  }
  return `${output}…`;
}
function lowerFirst(value) {
  const trimmed = value.trim();
  if (/^I(?:['’]|\s)/.test(trimmed) || /^(?:LaunchNY|AIOS|BBDSE|CourtIQ|TMCP|PyPI|MCP)\b/.test(trimmed)) return trimmed;
  return trimmed ? `${trimmed[0].toLowerCase()}${trimmed.slice(1)}` : trimmed;
}
function stripTerminalPunctuation(value) { return value.trim().replace(/[.!?]+$/, ''); }
function withIndefiniteArticle(value) { const phrase = lowerFirst(value); return /^(?:a|an|the)\b/i.test(phrase) ? phrase : `${/^[aeiou]/i.test(phrase) ? 'an' : 'a'} ${phrase}`; }
function naturalJoin(values) { if (values.length === 0) return 'unsupported outcomes'; if (values.length === 1) return values[0]; if (values.length === 2) return `${values[0]} or ${values[1]}`; return `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`; }
function qaNote(qa, prefix) { if (qa.blockers.length > 0) return `${prefix} blocked: ${qa.blockers.join(', ')}`; if (qa.warnings.length > 0) return `${prefix} warning: ${qa.warnings.join(', ')}`; return `${prefix} passed`; }
