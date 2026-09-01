import yaml from "js-yaml";

import {
  ALLOWED_KINDS,
  ALLOWED_REVIEW_STATES,
  ALLOWED_VISIBILITIES,
  ID_PATTERN,
  METRIC_PATTERN,
  ROOT,
  isObject,
  normalizeDates,
  optionalString,
  readText,
  requiredString,
  stringArray,
  nullableStringArray,
} from "./cv-book-support.mjs";

function loadYaml(filePath) {
  const content = readText(filePath);
  if (!content) throw new Error(`Missing or unreadable YAML file: ${filePath}`);
  try {
    const value = yaml.load(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("document must be an object");
    return value;
  } catch (error) {
    throw new Error(`Invalid YAML in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function ensureUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value.id)) throw new Error(`Duplicate ${label} ID: ${value.id}`);
    seen.add(value.id);
  }
}

export function hasMetric(value) {
  if (typeof value === "string") return METRIC_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(hasMetric);
  if (isObject(value)) return Object.values(value).some(hasMetric);
  return false;
}

export function normalizeForMatch(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeEntry(value, index) {
  const context = `entries[${index}]`;
  if (!isObject(value)) throw new Error(`${context} must be an object`);
  const id = requiredString(value.id, "id", context);
  if (!ID_PATTERN.test(id)) throw new Error(`${context}.id must be a stable kebab-case ID`);
  const kind = requiredString(value.kind, "kind", context);
  if (!ALLOWED_KINDS.has(kind)) throw new Error(`${context}.kind is unsupported: ${kind}`);
  const contributions = nullableStringArray(value.contributions, "contributions", context);
  const outcomes = nullableStringArray(value.outcomes, "outcomes", context);
  if (kind === "research" && (contributions === undefined || outcomes === undefined)) throw new Error(`${context} research fields must be null or arrays`);
  const visibility = requiredString(value.visibility, "visibility", context);
  if (!ALLOWED_VISIBILITIES.has(visibility)) throw new Error(`${context}.visibility is unsupported: ${visibility}`);
  const reviewState = requiredString(value.reviewState, "reviewState", context);
  if (!ALLOWED_REVIEW_STATES.has(reviewState)) throw new Error(`${context}.reviewState is unsupported: ${reviewState}`);
  const entry = {
    id,
    kind,
    title: requiredString(value.title, "title", context),
    organization: optionalString(value.organization, "organization", context),
    role: optionalString(value.role, "role", context),
    dates: normalizeDates(value.dates, context),
    status: requiredString(value.status, "status", context),
    summary: requiredString(value.summary, "summary", context),
    contributions,
    outcomes,
    technologies: stringArray(value.technologies, "technologies", context),
    visibility,
    evidence: stringArray(value.evidence, "evidence", context),
    confidence: requiredString(value.confidence, "confidence", context),
    reviewState,
  };
  if (hasMetric(entry) && entry.evidence.length === 0) throw new Error(`${context} contains a metric without an evidence reference`);
  return entry;
}

function normalizeSource(value, index) {
  const context = `sources[${index}]`;
  if (!isObject(value)) throw new Error(`${context} must be an object`);
  const id = requiredString(value.id, "id", context);
  if (!ID_PATTERN.test(id)) throw new Error(`${context}.id must be a stable kebab-case ID`);
  const root = requiredString(value.root, "root", context);
  if (!["workspace", "source-root"].includes(root)) throw new Error(`${context}.root must be workspace or source-root`);
  const pathValue = value.path === null || value.path === undefined ? null : requiredString(value.path, "path", context);
  return {
    id,
    kind: requiredString(value.kind, "kind", context),
    label: requiredString(value.label, "label", context),
    root,
    path: pathValue,
    status: requiredString(value.status, "status", context),
    visibility: requiredString(value.visibility, "visibility", context),
    note: requiredString(value.note, "note", context),
  };
}

function normalizeExclusion(value, index) {
  const context = `exclusions[${index}]`;
  if (!isObject(value)) throw new Error(`${context} must be an object`);
  const id = requiredString(value.id, "id", context);
  if (!ID_PATTERN.test(id)) throw new Error(`${context}.id must be a stable kebab-case ID`);
  return {
    id,
    title: requiredString(value.title, "title", context),
    aliases: stringArray(value.aliases || [], "aliases", context),
    status: requiredString(value.status, "status", context),
    reason: requiredString(value.reason, "reason", context),
    evidence: stringArray(value.evidence || [], "evidence", context),
  };
}

export function loadCvBookLayer(root = ROOT) {
  const entriesDocument = loadYaml(`${root}/data/cv-book/entries.yml`);
  const sourcesDocument = loadYaml(`${root}/data/cv-book/sources.yml`);
  const exclusionsDocument = loadYaml(`${root}/data/cv-book/exclusions.yml`);
  if (entriesDocument.schemaVersion !== 1 || sourcesDocument.schemaVersion !== 1 || exclusionsDocument.schemaVersion !== 1) {
    throw new Error("CV-book YAML files must use schemaVersion 1");
  }
  if (!Array.isArray(entriesDocument.entries) || !Array.isArray(sourcesDocument.sources) || !Array.isArray(exclusionsDocument.exclusions)) {
    throw new Error("CV-book YAML files must contain entries, sources, and exclusions arrays");
  }
  const entries = entriesDocument.entries.map(normalizeEntry);
  const sources = sourcesDocument.sources.map(normalizeSource);
  const exclusions = exclusionsDocument.exclusions.map(normalizeExclusion);
  ensureUnique(entries, "entry");
  ensureUnique(sources, "source");
  ensureUnique(exclusions, "exclusion");
  const sourceIds = new Set(sources.map((source) => source.id));
  for (const entry of entries) {
    for (const evidenceId of entry.evidence) if (!sourceIds.has(evidenceId)) throw new Error(`${entry.id} references unknown evidence source ${evidenceId}`);
  }
  for (const exclusion of exclusions) {
    for (const evidenceId of exclusion.evidence) if (!sourceIds.has(evidenceId)) throw new Error(`${exclusion.id} references unknown evidence source ${evidenceId}`);
  }
  return { entries, sources, exclusions };
}
