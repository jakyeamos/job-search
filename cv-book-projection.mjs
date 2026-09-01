import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { hasMetric, normalizeForMatch } from "./cv-book-data.mjs";
import { derivePendingEntry, isExcludedTitle, slugify } from "./cv-book-candidates.mjs";
import {
  DRIVE_PATTERN,
  EMAIL_PATTERN,
  RAW_REPORT_PATTERN,
  canonicalize,
  hashJson,
  isObject,
} from "./cv-book-support.mjs";

function publicTextValues(entry) {
  return [entry.title, entry.organization, entry.role, entry.dates.label, entry.status, entry.summary, ...(entry.contributions || []), ...(entry.outcomes || []), ...entry.technologies].filter(Boolean);
}

function assertPublicSafeEntry(entry) {
  for (const value of publicTextValues(entry)) {
    if (EMAIL_PATTERN.test(value)) throw new Error(`Public projection rejected an email address in ${entry.id}`);
    if (DRIVE_PATTERN.test(value)) throw new Error(`Public projection rejected a Drive reference in ${entry.id}`);
    if (RAW_REPORT_PATTERN.test(value)) throw new Error(`Public projection rejected a raw report reference in ${entry.id}`);
  }
  if (hasMetric(entry) && entry.evidence.length === 0) throw new Error(`Public projection rejected an unsupported metric in ${entry.id}`);
}

function entryPublicCopy(entry) {
  assertPublicSafeEntry(entry);
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    organization: entry.organization,
    role: entry.role,
    dates: entry.dates,
    status: entry.status,
    summary: entry.summary,
    contributions: entry.contributions,
    outcomes: entry.outcomes,
    technologies: entry.technologies,
    visibility: entry.visibility,
    evidence: entry.evidence,
    confidence: entry.confidence,
    reviewState: entry.reviewState,
  };
}

function excludedIds(layer) {
  return new Set(layer.exclusions.flatMap((exclusion) => [exclusion.id, slugify(exclusion.title), ...exclusion.aliases.map(slugify)]));
}

export function buildPublicProjection(layer, sourceCorpus, result) {
  const explicit = [...layer.entries];
  const explicitTitles = new Set(explicit.map((entry) => normalizeForMatch(entry.title)));
  const pending = sourceCorpus.candidates
    .filter((candidate) => !isExcludedTitle(candidate.title, layer.exclusions))
    .filter((candidate) => !explicitTitles.has(normalizeForMatch(candidate.title)))
    .map((candidate) => derivePendingEntry(candidate, candidate.sourceIds));
  const allEntries = [...explicit, ...pending];
  const excluded = excludedIds(layer);
  const visibleEntries = allEntries
    .filter((entry) => entry.visibility === "public")
    .filter((entry) => !excluded.has(entry.id) && !isExcludedTitle(entry.title, layer.exclusions))
    .map(entryPublicCopy)
    .sort((left, right) => {
      const leftDate = left.dates.start || "9999-99";
      const rightDate = right.dates.start || "9999-99";
      return leftDate.localeCompare(rightDate) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
    });
  const visibleIds = new Set(visibleEntries.map((entry) => entry.id));
  const caseStudyIds = ["forward-automations", "terrace", "quality-runner", "pre-cr-suite", "tenure", "pronto", "macctl"].filter((id) => visibleIds.has(id));
  const sections = [
    { id: "timeline", title: "Chronological timeline", entryIds: visibleEntries.map((entry) => entry.id) },
    { id: "case-studies", title: "Selected narrative case studies", entryIds: caseStudyIds },
    { id: "project-index", title: "Complete searchable project and work index", entryIds: visibleEntries.map((entry) => entry.id) },
    { id: "research-labs", title: "Research, labs, education, and writing", entryIds: visibleEntries.filter((entry) => ["research", "education", "writing"].includes(entry.kind)).map((entry) => entry.id) },
    { id: "open-source-tooling", title: "Open-source packages and developer tooling", entryIds: visibleEntries.filter((entry) => entry.kind === "tooling").map((entry) => entry.id) },
    { id: "evidence-notes", title: "Public-safe appendix and evidence notes", entryIds: [] },
  ];
  const unsigned = {
    schemaVersion: 1,
    projectionId: "comprehensive-cv-book",
    generatedFrom: { sourceHash: result.sourceHash, sourceLayer: "data/cv-book" },
    profile: {
      name: "Jakye Amos",
      headline: "Lead Engineer, Forward Automations",
      summary: "Lead engineer building applied AI products, agent infrastructure, and evidence-driven developer tooling.",
    },
    sections,
    entries: visibleEntries,
    evidenceNotes: {
      publicBoundary: "This book publishes only reviewed public-safe entries. Private source contents, raw reports, email, Drive references, and held work are excluded.",
      precedence: "Owner confirmation and current public artifacts take precedence over current CV/digest text; older or private sources corroborate but do not silently resolve conflicts.",
      pending: visibleEntries.filter((entry) => entry.reviewState === "pending").map((entry) => `${entry.title}: role or deliverables pending confirmation.`),
      sourceLabels: [
        { id: "cv-current", label: "Current CV" },
        { id: "article-digest-current", label: "Current article digest" },
        { id: "current-public-artifacts", label: "Current public repository artifacts" },
        { id: "user-confirmed-research-aug-2026", label: "Owner-confirmed August 2026 research scope" },
      ],
      excluded: [],
    },
  };
  const projection = { ...unsigned, projectionHash: hashJson(unsigned) };
  assertPublicProjection(projection, layer);
  return projection;
}

export function assertPublicProjection(projection, layer) {
  if (!isObject(projection) || typeof projection.projectionHash !== "string") throw new Error("Public projection is missing projectionHash");
  const { projectionHash, ...unsigned } = projection;
  if (hashJson(unsigned) !== projectionHash) throw new Error("Public projection hash does not match its content");
  const excluded = excludedIds(layer);
  for (const entry of projection.entries || []) {
    if (entry.visibility !== "public") throw new Error(`Non-public entry entered the public projection: ${entry.id}`);
    if (excluded.has(entry.id) || isExcludedTitle(entry.title, layer.exclusions)) throw new Error(`Held entry entered the public projection: ${entry.id}`);
    assertPublicSafeEntry(entry);
  }
  const serialized = JSON.stringify(projection);
  if (EMAIL_PATTERN.test(serialized) || DRIVE_PATTERN.test(serialized) || RAW_REPORT_PATTERN.test(serialized)) throw new Error("Public projection contains a forbidden private or raw-report reference");
  return true;
}

export function writeProjection(projection, projectionPath) {
  mkdirSync(path.dirname(projectionPath), { recursive: true });
  writeFileSync(projectionPath, `${JSON.stringify(canonicalize(projection), null, 2)}\n`);
  return projectionPath;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderHtmlEntry(entry) {
  const list = (values) => values && values.length ? `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : "";
  return `<article class="entry"><div class="entry-meta"><span>${escapeHtml(entry.kind)}</span><span>${escapeHtml(entry.dates.label)}</span><span>${escapeHtml(entry.status)}</span></div><h3>${escapeHtml(entry.title)}</h3><p class="entry-org">${escapeHtml([entry.organization, entry.role].filter(Boolean).join(" · "))}</p><p>${escapeHtml(entry.summary)}</p>${list(entry.contributions)}${list(entry.outcomes)}</article>`;
}

export function renderProjectionHtml(projection) {
  const byId = new Map(projection.entries.map((entry) => [entry.id, entry]));
  const section = (sectionDefinition) => {
    const entries = sectionDefinition.entryIds.map((id) => byId.get(id)).filter(Boolean);
    return `<section id="${escapeHtml(sectionDefinition.id)}"><h2>${escapeHtml(sectionDefinition.title)}</h2>${entries.map(renderHtmlEntry).join("")}</section>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="cv-book-projection-hash" content="${escapeHtml(projection.projectionHash)}"><title>Comprehensive CV Book — Jakye Amos</title><style>@page{size:A4;margin:16mm}*{box-sizing:border-box}body{margin:0;color:#241a16;background:#fffaf0;font:10.5pt/1.45 Georgia,serif}h1,h2,h3{font-family:Arial,sans-serif;line-height:1.1}h1{font-size:30pt;margin:0 0 5pt}h2{font-size:18pt;border-bottom:1px solid #a6784e;padding-bottom:5pt;margin:20pt 0 10pt}h3{font-size:13pt;margin:5pt 0}.lede{font-size:13pt;max-width:44em}.entry{break-inside:avoid;border-top:1px solid #ddc8a9;padding:9pt 0}.entry-meta{display:flex;gap:10pt;color:#805f48;text-transform:uppercase;font:8pt Arial,sans-serif;letter-spacing:.08em}.entry-org{color:#805f48;margin:.1em 0}.entry ul{margin:3pt 0 0 15pt;padding:0}.appendix{break-before:page;color:#5c4636;font-size:9pt}.hash{word-break:break-all;font:8pt monospace}</style></head><body><header><p>COMPREHENSIVE CV BOOK</p><h1>${escapeHtml(projection.profile.name)}</h1><p class="lede"><strong>${escapeHtml(projection.profile.headline)}</strong><br>${escapeHtml(projection.profile.summary)}</p></header><nav><h2>Contents</h2><ol>${projection.sections.map((item) => `<li>${escapeHtml(item.title)}</li>`).join("")}</ol></nav>${projection.sections.filter((item) => item.id !== "evidence-notes").map(section).join("")}<section class="appendix" id="evidence-notes"><h2>Public-safe appendix and evidence notes</h2><p>${escapeHtml(projection.evidenceNotes.publicBoundary)}</p><p>${escapeHtml(projection.evidenceNotes.precedence)}</p><p>Projection hash: <span class="hash">${escapeHtml(projection.projectionHash)}</span></p></section></body></html>`;
}
