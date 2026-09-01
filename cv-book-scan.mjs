import { discoverRepositories } from "./cv-refresh.mjs";

import {
  DEFAULT_REPOSITORY_ROOTS,
  DEFAULT_SOURCE_ROOT,
  RESUME_FILE_PATTERN,
  digestPath,
  expandPath,
  firstMeaningfulLine,
  hashJson,
  hashText,
  humanizeRepositoryName,
  readText,
  runGit,
  sourcePath,
  walkFiles,
  ROOT,
} from "./cv-book-support.mjs";
import { loadCvBookLayer, normalizeForMatch } from "./cv-book-data.mjs";
import {
  derivePendingEntry,
  extractMarkdownCandidates,
  isExcludedTitle,
  mergeCandidates,
} from "./cv-book-candidates.mjs";

function repositoryEvidence(repository, knownEntries, sourceCorpus) {
  const readmePath = ["README.md", "readme.md"].map((name) => `${repository}/${name}`).find((filePath) => digestPath(filePath).exists) || "";
  const truthPath = [".tracker/PROJECT_TRUTH.md", "PROJECT_TRUTH.md"].map((name) => `${repository}/${name}`).find((filePath) => digestPath(filePath).exists) || "";
  const packageText = readText(`${repository}/package.json`);
  let packageName = "";
  let packageDescription = "";
  if (packageText) {
    try {
      const packageJson = JSON.parse(packageText);
      packageName = typeof packageJson.name === "string" ? packageJson.name : "";
      packageDescription = typeof packageJson.description === "string" ? packageJson.description : "";
    } catch {
      // README and project-truth evidence remain usable when package metadata is malformed.
    }
  }
  const repositoryName = repository.split("/").pop() || repository;
  const title = packageName || humanizeRepositoryName(repositoryName);
  const evidenceText = [readText(truthPath), readText(readmePath)].join("\n");
  const normalizedEvidence = normalizeForMatch(`${title} ${repositoryName} ${evidenceText}`);
  const represented = knownEntries.some((entry) => normalizedEvidence.includes(normalizeForMatch(entry.title)));
  const status = runGit(repository, ["status", "--short"]);
  return {
    path: repository,
    title,
    description: (packageDescription || firstMeaningfulLine(evidenceText)).replace(/\s+/g, " ").slice(0, 280),
    branch: runGit(repository, ["branch", "--show-current"]),
    remote: runGit(repository, ["config", "--get", "remote.origin.url"]),
    dirty: Boolean(status),
    represented,
    sourceFiles: [truthPath, readmePath].filter(Boolean),
    evidenceDigest: hashText(evidenceText),
    sourceCorpusDigest: sourceCorpus.digest,
  };
}

function sourceSnapshot(source, sourceRoot, options = {}) {
  const resolved = sourcePath(source, sourceRoot);
  if (source.kind === "repository-evidence" && resolved) {
    const repositories = options.repositoryPaths || discoverRepositories([resolved], options.maxDepth ?? 3);
    const evidenceFiles = repositories.flatMap((repository) => [
      `${repository}/README.md`,
      `${repository}/readme.md`,
      `${repository}/.tracker/PROJECT_TRUTH.md`,
      `${repository}/PROJECT_TRUTH.md`,
      `${repository}/package.json`,
    ].filter((filePath) => digestPath(filePath).exists));
    return {
      id: source.id,
      resolved,
      exists: repositories.length > 0,
      digest: hashJson(evidenceFiles.map((filePath) => ({ path: filePath, digest: hashText(readText(filePath)) }))),
      status: source.status,
    };
  }
  const digest = digestPath(resolved);
  return { id: source.id, resolved, exists: digest.exists, digest: digest.digest, status: source.status };
}

function reportSourceRefs(layer, sourceRoot) {
  const sourceById = new Map(layer.sources.map((source) => [source.id, source]));
  const missing = [];
  for (const source of layer.sources) {
    const snapshot = sourceSnapshot(source, sourceRoot);
    if (source.status !== "pending" && source.status !== "blocked" && source.path && !snapshot.exists) missing.push({ sourceId: source.id, reason: "configured source path is missing" });
    if (["stale", "blocked", "pending"].includes(source.status)) missing.push({ sourceId: source.id, reason: `source status is ${source.status}` });
  }
  for (const entry of layer.entries) {
    for (const evidenceId of entry.evidence) if (!sourceById.has(evidenceId)) missing.push({ sourceId: evidenceId, reason: `referenced by ${entry.id} but not defined` });
  }
  return missing.sort((left, right) => `${left.sourceId}:${left.reason}`.localeCompare(`${right.sourceId}:${right.reason}`));
}

function mineDatedReports(reportRoot, candidates, entries) {
  const files = walkFiles(reportRoot).filter((filePath) => /\.md$/i.test(filePath));
  const mentionCounts = new Map(candidates.map((candidate) => [candidate.id, 0]));
  let reportHeadingCount = 0;
  let unmatchedHeadingCount = 0;
  const knownTitles = [...entries, ...candidates].map((entry) => normalizeForMatch(entry.title));
  for (const filePath of files) {
    const text = readText(filePath, 1_000_000);
    for (const candidate of candidates) {
      if (normalizeForMatch(text).includes(normalizeForMatch(candidate.title))) mentionCounts.set(candidate.id, (mentionCounts.get(candidate.id) || 0) + 1);
    }
    const headings = text.match(/^#{2,3}\s+.+$/gm) || [];
    reportHeadingCount += headings.length;
    unmatchedHeadingCount += headings.filter((heading) => !knownTitles.some((title) => title && normalizeForMatch(heading).includes(title))).length;
  }
  const recurringEvidence = [...mentionCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([id, mentionCount]) => ({ id, mentionCount }))
    .sort((left, right) => right.mentionCount - left.mentionCount || left.id.localeCompare(right.id));
  return {
    reportCount: files.length,
    datedReportCount: files.filter((filePath) => /20\d{2}/.test(filePath.split("/").pop() || "")).length,
    reportHeadingCount,
    unmatchedHeadingCount,
    recurringEvidence,
    rawArchivePublished: false,
    digest: hashJson(files.map((filePath) => ({ path: filePath, digest: hashText(readText(filePath, 1_000_000)) }))),
  };
}

function mineCorroboratingResumes(resumeRoot) {
  const files = walkFiles(resumeRoot).filter((filePath) => RESUME_FILE_PATTERN.test(filePath.split("/").pop() || "") && /\.(?:pdf|docx?|md|txt)$/i.test(filePath));
  return {
    root: resumeRoot,
    fileCount: files.length,
    files: files.map((filePath) => ({
      name: filePath.split("/").pop() || filePath,
      extension: `.${(filePath.split(".").pop() || "").toLowerCase()}`,
      digest: hashText(readText(filePath, 20_000_000)),
    })),
    digest: hashJson(files.map((filePath) => ({ path: filePath, digest: hashText(readText(filePath, 20_000_000)) }))),
    publicable: false,
  };
}

function detectConflicts(candidates) {
  return candidates
    .filter((candidate) => candidate.variants && candidate.variants.length > 0)
    .map((candidate) => ({ id: candidate.id, titles: [candidate.title, ...candidate.variants].sort(), sourceIds: candidate.sourceIds }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function buildSourceCorpus(sourceRoot, layer) {
  const cvSource = layer.sources.find((source) => source.id === "cv-current");
  const digestSource = layer.sources.find((source) => source.id === "article-digest-current");
  const cvText = cvSource ? readText(sourcePath(cvSource, sourceRoot)) : "";
  const digestText = digestSource ? readText(sourcePath(digestSource, sourceRoot)) : "";
  return {
    cvText,
    digestText,
    digest: hashJson({ cv: hashText(cvText), digest: hashText(digestText) }),
    candidates: mergeCandidates(extractMarkdownCandidates(cvText, "cv-current"), extractMarkdownCandidates(digestText, "article-digest-current")),
  };
}

export function scanCvBook(options = {}) {
  const sourceRoot = expandPath(options.sourceRoot || DEFAULT_SOURCE_ROOT);
  const roots = (options.roots || DEFAULT_REPOSITORY_ROOTS).map(expandPath);
  const layer = loadCvBookLayer(ROOT);
  const sourceCorpus = buildSourceCorpus(sourceRoot, layer);
  const sourceCandidates = sourceCorpus.candidates.filter((candidate) => !isExcludedTitle(candidate.title, layer.exclusions));
  const existingEntryMatches = new Set(layer.entries.map((entry) => normalizeForMatch(entry.title)));
  const pendingSourceCandidates = sourceCandidates.filter((candidate) => !existingEntryMatches.has(normalizeForMatch(candidate.title)));
  const repositoryPaths = discoverRepositories(roots, options.maxDepth ?? 3);
  const repositories = repositoryPaths.map((repository) => repositoryEvidence(repository, layer.entries, sourceCorpus));
  const reportSource = layer.sources.find((source) => source.id === "dated-reports");
  const reportRoot = reportSource ? sourcePath(reportSource, sourceRoot) : `${sourceRoot}/reports`;
  const reportMining = mineDatedReports(reportRoot, sourceCandidates, layer.entries);
  const resumeSource = layer.sources.find((source) => source.id === "older-resumes");
  const resumeRoot = resumeSource ? sourcePath(resumeSource, sourceRoot) : null;
  const resumeMining = mineCorroboratingResumes(resumeRoot);
  const snapshots = layer.sources.map((source) => sourceSnapshot(source, sourceRoot, { repositoryPaths, maxDepth: options.maxDepth ?? 3 }));
  const conflicts = detectConflicts(sourceCorpus.candidates.filter((candidate) => !isExcludedTitle(candidate.title, layer.exclusions)));
  const staleReferences = reportSourceRefs(layer, sourceRoot);
  const layerSourceHash = hashJson({ entries: layer.entries, sources: layer.sources, exclusions: layer.exclusions });
  const sourceHash = hashJson({
    schemaVersion: 1,
    layerSourceHash,
    snapshots,
    sourceCorpus: sourceCorpus.digest,
    repositories: repositories.map((repository) => ({ path: repository.path, evidenceDigest: repository.evidenceDigest, represented: repository.represented })),
    reportMining: { reportCount: reportMining.reportCount, digest: reportMining.digest },
    resumeMining: { fileCount: resumeMining.fileCount, digest: resumeMining.digest },
  });
  const result = {
    schemaVersion: 1,
    sourceRoot,
    roots,
    maxDepth: options.maxDepth ?? 3,
    sourceHash,
    sourceFiles: snapshots.map(({ id, exists, digest, status }) => ({ id, exists, digest, status })),
    entryCount: layer.entries.length,
    publicEntryCount: layer.entries.filter((entry) => entry.visibility === "public").length,
    sourceCandidateCount: sourceCandidates.length,
    newItems: pendingSourceCandidates,
    pendingSourceCandidates,
    conflicts,
    staleReferences,
    missingConfirmation: [
      ...layer.entries.filter((entry) => entry.reviewState === "pending").map((entry) => ({ id: entry.id, reason: "entry reviewState is pending" })),
      ...layer.sources.filter((source) => source.status === "pending").map((source) => ({ id: source.id, reason: "source confirmation is pending" })),
    ].sort((left, right) => left.id.localeCompare(right.id)),
    repositories: repositories.map(({ path: repositoryPath, title, description, branch, dirty, represented, sourceFiles }) => ({ path: repositoryPath, title, description, branch, dirty, represented, sourceFiles })),
    repositoryCandidates: repositories.filter((repository) => !repository.represented).map((repository) => ({ path: repository.path, title: repository.title, description: repository.description, branch: repository.branch, dirty: repository.dirty })),
    reportMining,
    resumeMining,
    safety: { cvModified: false, digestModified: false, ledgerModified: false, emailAccessed: false, driveAccessed: false, rawReportsPublished: false },
  };
  return { layer, sourceCorpus, result };
}
