import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { canonicalize } from "./cv-book-support.mjs";

function formatList(values) {
  return values.length > 0 ? values.join(", ") : "none";
}

export function renderCvBookRefreshReport(result) {
  const lines = [
    "# CV book evidence refresh",
    "",
    "This report is report-only. It does not modify `cv.md`, `article-digest.md`, the accomplishment ledger, email, Drive, or raw reports.",
    "",
    "## Scan summary",
    "",
    `- Source root: \`${result.sourceRoot}\``,
    `- CV-book entries in source layer: ${result.entryCount} (${result.publicEntryCount} public)`,
    `- Markdown source candidates: ${result.sourceCandidateCount}`,
    `- New source items since the last written scan: ${result.newItems.length}`,
    `- Repository evidence records: ${result.repositories.length}`,
    `- Repository review candidates: ${result.repositoryCandidates.length}`,
    `- Dated reports scanned: ${result.reportMining.datedReportCount} of ${result.reportMining.reportCount}`,
    `- Older resume/CV artifacts inventoried as corroboration only: ${result.resumeMining.fileCount}`,
    `- Conflicts: ${result.conflicts.length}`,
    `- Stale or pending source references: ${result.staleReferences.length}`,
    `- Missing confirmation items: ${result.missingConfirmation.length}`,
    `- Source hash: \`${result.sourceHash}\``,
    "",
    "## Review queue",
    "",
    `### New items (${result.newItems.length})`,
    "",
  ];
  if (result.newItems.length === 0) lines.push("No new CV or digest titles were found.", "");
  else for (const item of result.newItems) lines.push(`- ${item.title} — sources: ${formatList(item.sourceIds)}${item.dateHints.length ? `; date hints: ${formatList(item.dateHints)}` : ""}`);
  lines.push("", `### Repository candidates (${result.repositoryCandidates.length})`, "");
  if (result.repositoryCandidates.length === 0) lines.push("No unrepresented repository evidence was found.", "");
  else for (const item of result.repositoryCandidates) lines.push(`- ${item.title} — repository evidence requires human review${item.dirty ? "; working tree is dirty" : ""}`);
  lines.push("", `### Conflicts (${result.conflicts.length})`, "");
  if (result.conflicts.length === 0) lines.push("No conflicting source titles were detected.", "");
  else for (const conflict of result.conflicts) lines.push(`- ${conflict.id}: ${formatList(conflict.titles)} — sources: ${formatList(conflict.sourceIds)}`);
  lines.push("", `### Stale or pending references (${result.staleReferences.length})`, "");
  if (result.staleReferences.length === 0) lines.push("No stale references were detected.", "");
  else for (const stale of result.staleReferences) lines.push(`- ${stale.sourceId}: ${stale.reason}`);
  lines.push("", `### Missing confirmation (${result.missingConfirmation.length})`, "");
  if (result.missingConfirmation.length === 0) lines.push("No confirmation is missing.", "");
  else for (const missing of result.missingConfirmation) lines.push(`- ${missing.id}: ${missing.reason}`);
  lines.push(
    "",
    "## Dated-report mining",
    "",
    `- Recurring evidence signals: ${result.reportMining.recurringEvidence.length}`,
    `- Report headings scanned: ${result.reportMining.reportHeadingCount}`,
    `- Unmatched report headings retained for review only: ${result.reportMining.unmatchedHeadingCount}`,
    "- Older resume artifacts are hashed and inventoried, not copied into the public projection.",
    "- Raw report contents and job-evaluation archive files are not copied into the public projection.",
    "",
    "## Safety boundary",
    "",
    "- Evidence precedence is owner confirmation and current public artifacts, then current CV/digest, then corroborating older/private sources.",
    "- Metrics require evidence references; unresolved conflicts stay in this queue.",
    "- GCC and the CSDS 312 GNU/GCC project remain held and are excluded from public output.",
    "- Use the explicit reviewed apply command with a source-hash-bound review file before changing the source layer or projection.",
    "",
  );
  return lines.join("\n");
}

export function writeRefreshOutputs(result, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const state = {
    schemaVersion: 1,
    sourceHash: result.sourceHash,
    sourceCandidateIds: result.pendingSourceCandidates.map((candidate) => candidate.id).sort(),
    sourceRoot: result.sourceRoot,
  };
  const report = renderCvBookRefreshReport(result);
  writeFileSync(path.join(outputDir, "latest.md"), `${report}\n`);
  writeFileSync(path.join(outputDir, "latest.json"), `${JSON.stringify(canonicalize(result), null, 2)}\n`);
  writeFileSync(path.join(outputDir, "state.json"), `${JSON.stringify(canonicalize(state), null, 2)}\n`);
  return path.join(outputDir, "latest.md");
}
