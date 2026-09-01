#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

import { derivePendingEntry, extractMarkdownCandidates, isExcludedTitle } from "./cv-book-candidates.mjs";
import { loadCvBookLayer, normalizeForMatch } from "./cv-book-data.mjs";
import { renderCvBookRefreshReport, writeRefreshOutputs } from "./cv-book-report.mjs";
import { scanCvBook } from "./cv-book-scan.mjs";
import {
  assertPublicProjection,
  buildPublicProjection,
  renderProjectionHtml,
  writeProjection,
} from "./cv-book-projection.mjs";
import {
  DATA_DIR,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_REPOSITORY_ROOTS,
  DEFAULT_SOURCE_ROOT,
  ID_PATTERN,
  ROOT,
  canonicalize,
  expandPath,
  hashBytes,
  readJson,
} from "./cv-book-support.mjs";

export {
  assertPublicProjection,
  buildPublicProjection,
  extractMarkdownCandidates,
  hashBytes,
  loadCvBookLayer,
  renderCvBookRefreshReport,
  scanCvBook,
};

function parseArgs(argv) {
  const options = {
    command: "refresh",
    roots: [],
    sourceRoot: DEFAULT_SOURCE_ROOT,
    outputDir: DEFAULT_OUTPUT_DIR,
    projectionPath: path.join(DATA_DIR, "public-projection.json"),
    pdfPath: path.join(DEFAULT_OUTPUT_DIR, "cv-book.pdf"),
    maxDepth: 3,
    json: false,
    write: true,
    check: false,
    help: false,
    reviewFile: "",
  };
  let index = 0;
  if (["refresh", "apply", "validate", "pdf"].includes(argv[0])) {
    options.command = argv[0];
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a path");
      options.roots.push(expandPath(value));
      index += 1;
    } else if (argument === "--source-root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--source-root requires a path");
      options.sourceRoot = expandPath(value);
      index += 1;
    } else if (argument === "--output-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output-dir requires a path");
      options.outputDir = expandPath(value);
      index += 1;
    } else if (argument === "--projection") {
      const value = argv[index + 1];
      if (!value) throw new Error("--projection requires a path");
      options.projectionPath = expandPath(value);
      index += 1;
    } else if (argument === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output requires a path");
      options.pdfPath = expandPath(value);
      index += 1;
    } else if (argument === "--max-depth") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 0) throw new Error("--max-depth requires a non-negative integer");
      options.maxDepth = value;
      index += 1;
    } else if (argument === "--review-file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--review-file requires a path");
      options.reviewFile = expandPath(value);
      index += 1;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--no-write") {
      options.write = false;
    } else if (argument === "--check") {
      options.check = true;
    } else if (argument === "--apply") {
      options.command = "apply";
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.roots.length === 0) options.roots = [...DEFAULT_REPOSITORY_ROOTS];
  return options;
}

function printHelp() {
  console.log(`Usage:
  pnpm cv:book:refresh [options]       Report-only evidence scan (default)
  pnpm cv:book:apply -- --review-file <file>
  pnpm cv:book:validate
  pnpm cv:book:pdf -- --projection <file> --output <file>

Refresh options:
  --source-root <path>  Checkout containing cv.md, article-digest.md, and reports
  --root <path>         Repository discovery root (repeatable)
  --output-dir <path>   Report/state directory (default: output/cv-book)
  --max-depth <n>       Repository discovery depth (default: 3)
  --json                Print the deterministic report to stdout
  --no-write            Do not write report/state files
  --check               Exit 2 when review work is pending

Apply requires an explicit reviewed JSON file with the current sourceHash and
reviewed: true. It can update only data/cv-book source/projection files. It
never modifies cv.md, article-digest.md, the accomplishment ledger, email,
Drive, or raw reports.
`);
}

function applyReview(reviewPath, sourceHash) {
  if (!reviewPath) throw new Error("Explicit reviewed apply requires --review-file <path>");
  const review = readJson(reviewPath);
  if (review.schemaVersion !== 1 || review.reviewed !== true) throw new Error("Review file must contain schemaVersion: 1 and reviewed: true");
  if (review.sourceHash !== sourceHash) throw new Error("Review file sourceHash does not match the current deterministic refresh");
  const acceptedCandidateIds = Array.isArray(review.acceptedCandidateIds) ? review.acceptedCandidateIds : [];
  if (acceptedCandidateIds.some((id) => typeof id !== "string" || !ID_PATTERN.test(id))) throw new Error("Review file acceptedCandidateIds must contain stable IDs");
  return [...new Set(acceptedCandidateIds)].sort();
}

function yamlDump(document) {
  return yaml.dump(document, { lineWidth: -1, noRefs: true, sortKeys: false });
}

async function generatePdf(projection, pdfPath) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(renderProjectionHtml(projection), { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, tagged: true });
    mkdirSync(path.dirname(pdfPath), { recursive: true });
    writeFileSync(pdfPath, pdf);
  } finally {
    await browser.close();
  }
  const manifestPath = `${pdfPath}.json`;
  writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, projectionHash: projection.projectionHash, pdfSha256: hashBytes(readFileSync(pdfPath)), fileName: path.basename(pdfPath) }, null, 2)}\n`);
  return { pdfPath, manifestPath };
}

function resultHasReviewWork(result) {
  return result.newItems.length > 0 || result.repositoryCandidates.length > 0 || result.conflicts.length > 0 || result.staleReferences.length > 0 || result.missingConfirmation.length > 0;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    if (options.command === "validate") {
      const layer = loadCvBookLayer(ROOT);
      let projection = null;
      if (existsSync(options.projectionPath)) {
        projection = readJson(options.projectionPath);
        assertPublicProjection(projection, layer);
      }
      const output = { schemaVersion: 1, valid: true, entries: layer.entries.length, sources: layer.sources.length, exclusions: layer.exclusions.length, projectionHash: projection?.projectionHash || null };
      console.log(options.json ? JSON.stringify(output, null, 2) : `CV-book source layer valid (${output.entries} entries, ${output.sources} sources, ${output.exclusions} exclusions).`);
      return;
    }
    if (options.command === "pdf") {
      const projection = readJson(options.projectionPath);
      const layer = loadCvBookLayer(ROOT);
      assertPublicProjection(projection, layer);
      const result = await generatePdf(projection, options.pdfPath);
      console.log(options.json ? JSON.stringify({ ...result, projectionHash: projection.projectionHash }, null, 2) : `CV-book PDF written: ${result.pdfPath}\nProjection hash: ${projection.projectionHash}`);
      return;
    }
    const scan = scanCvBook(options);
    if (options.command === "refresh") {
      const reportPath = options.write ? writeRefreshOutputs(scan.result, options.outputDir) : "";
      if (options.json) console.log(JSON.stringify(canonicalize({ ...scan.result, reportPath }), null, 2));
      else {
        console.log(`CV-book refresh scanned ${scan.result.repositories.length} repositories and ${scan.result.reportMining.reportCount} dated reports.`);
        console.log(`New items: ${scan.result.newItems.length}; conflicts: ${scan.result.conflicts.length}; missing confirmation: ${scan.result.missingConfirmation.length}.`);
        if (reportPath) console.log(`Report: ${reportPath}`);
        console.log("No CV, digest, ledger, email, Drive, or raw-report files were modified.");
      }
      if (options.check && resultHasReviewWork(scan.result)) process.exitCode = 2;
      return;
    }
    const acceptedCandidateIds = applyReview(options.reviewFile, scan.result.sourceHash);
    const acceptedSet = new Set(acceptedCandidateIds);
    const candidateEntries = scan.sourceCorpus.candidates
      .filter((candidate) => acceptedSet.has(candidate.id))
      .filter((candidate) => !isExcludedTitle(candidate.title, scan.layer.exclusions))
      .filter((candidate) => !scan.layer.entries.some((entry) => entry.id === candidate.id || normalizeForMatch(entry.title) === normalizeForMatch(candidate.title)))
      .map((candidate) => ({ ...derivePendingEntry(candidate, candidate.sourceIds), confidence: "medium", reviewState: "approved" }));
    const updatedLayer = { ...scan.layer, entries: [...scan.layer.entries, ...candidateEntries].sort((left, right) => left.id.localeCompare(right.id)) };
    const projection = buildPublicProjection(updatedLayer, scan.sourceCorpus, scan.result);
    if (options.write) {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(path.join(DATA_DIR, "entries.yml"), yamlDump({ schemaVersion: 1, entries: updatedLayer.entries }));
      writeProjection(projection, options.projectionPath);
      writeRefreshOutputs(scan.result, options.outputDir);
    }
    const output = { applied: options.write, acceptedCandidateIds, addedEntries: candidateEntries.map((entry) => entry.id), projectionPath: options.projectionPath, projectionHash: projection.projectionHash };
    console.log(options.json ? JSON.stringify(output, null, 2) : `Reviewed CV-book apply ${options.write ? "completed" : "validated"}. Projection hash: ${projection.projectionHash}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
