import {
  normalizeForMatch,
} from "./cv-book-data.mjs";

export function slugify(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[’']/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "untitled-source-item";
}

function cleanCandidateTitle(value) {
  let title = String(value || "").trim();
  title = title.replace(/\s+\*+$/, "");
  title = title.replace(/\s+`[^`]+`/g, "");
  title = title.split(/\s+—\s+/)[0];
  title = title.replace(/\s+\((?:published|public|private|live|working|current|project|pilot|beta|README|product|report-only)[^)]*\)$/i, "");
  return title.replace(/\s+/g, " ").trim();
}

function extractDateHints(text) {
  return [...new Set([...String(text || "").matchAll(/\b(20\d{2})\b/g)].map((match) => match[1]))].sort();
}

export function extractMarkdownCandidates(text, sourceId) {
  const lines = String(text || "").split("\n");
  const candidates = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^###\s+(.+?)\s*$/);
    if (!match) continue;
    const title = cleanCandidateTitle(match[1]);
    if (!title || /^(lane|auto-refreshed|source-derived|professional experience)/i.test(title)) continue;
    const body = lines.slice(index, index + 10).join(" ");
    const id = slugify(title);
    const existing = candidates.get(id);
    if (existing) {
      existing.sourceIds = [...new Set([...existing.sourceIds, sourceId])].sort();
      existing.dateHints = [...new Set([...existing.dateHints, ...extractDateHints(body)])].sort();
      if (normalizeForMatch(existing.title) !== normalizeForMatch(title)) existing.variants = [...new Set([...existing.variants, title])].sort();
    } else {
      candidates.set(id, { id, title, sourceIds: [sourceId], dateHints: extractDateHints(body), variants: [] });
    }
  }
  return [...candidates.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function mergeCandidates(...candidateLists) {
  const merged = new Map();
  for (const candidate of candidateLists.flat()) {
    const existing = merged.get(candidate.id);
    if (!existing) {
      merged.set(candidate.id, { ...candidate, sourceIds: [...candidate.sourceIds], dateHints: [...candidate.dateHints], variants: [...(candidate.variants || [])] });
      continue;
    }
    existing.sourceIds = [...new Set([...existing.sourceIds, ...candidate.sourceIds])].sort();
    existing.dateHints = [...new Set([...existing.dateHints, ...candidate.dateHints])].sort();
    if (normalizeForMatch(existing.title) !== normalizeForMatch(candidate.title)) existing.variants = [...new Set([...existing.variants, candidate.title])].sort();
    existing.variants = [...new Set([...existing.variants, ...(candidate.variants || [])])].sort();
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function isExcludedTitle(title, exclusions) {
  const normalizedTitle = normalizeForMatch(title);
  return exclusions.some((exclusion) => [exclusion.id, exclusion.title, ...exclusion.aliases].some((alias) => {
    const normalizedAlias = normalizeForMatch(alias);
    return normalizedAlias && (normalizedTitle === normalizedAlias || normalizedTitle.includes(normalizedAlias) || normalizedAlias.includes(normalizedTitle));
  }));
}

export function derivePendingEntry(candidate, sourceIds) {
  const privateTitle = /\bprivate\b|personal|internal/i.test(candidate.title);
  return {
    id: candidate.id,
    kind: "project",
    title: candidate.title,
    organization: null,
    role: null,
    dates: { start: null, end: null, label: "Date to confirm" },
    status: "pending-confirmation",
    summary: "Source item found in the current CV or article digest; description pending review.",
    contributions: [],
    outcomes: [],
    technologies: [],
    visibility: privateTitle ? "private" : "public",
    evidence: [...sourceIds].sort(),
    confidence: "pending",
    reviewState: "pending",
  };
}
