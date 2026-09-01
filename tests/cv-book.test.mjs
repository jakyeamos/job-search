import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertPublicProjection,
  buildPublicProjection,
  extractMarkdownCandidates,
  hashBytes,
  loadCvBookLayer,
  renderCvBookRefreshReport,
  scanCvBook,
} from "../cv-book.mjs";

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "career-ops-cv-book-"));
  const sourceRoot = path.join(root, "source");
  const projectsRoot = path.join(root, "projects");
  const portfolioRoot = path.join(root, "portfolio");
  const outputDir = path.join(root, "output");
  mkdirSync(path.join(sourceRoot, "reports"), { recursive: true });
  mkdirSync(path.join(projectsRoot, "fixture-tool", ".git"), { recursive: true });
  mkdirSync(portfolioRoot, { recursive: true });
  writeFileSync(path.join(sourceRoot, "cv.md"), `# Fixture CV\n\n### Fixture Project\nA source-backed project.\n\n### GCC\nHeld source item.\n`);
  writeFileSync(path.join(sourceRoot, "article-digest.md"), `# Fixture Digest\n\n### Pending Fixture\nA title awaiting owner review.\n`);
  writeFileSync(path.join(sourceRoot, "reports", "2026-08-report.md"), "## Fixture Project\nRepeated evidence for review only.\n");
  writeFileSync(path.join(portfolioRoot, "Older Resume 2025.pdf"), "%PDF-fixture");
  writeFileSync(path.join(projectsRoot, "fixture-tool", "README.md"), "A fixture repository with public evidence and a stable description.\n");
  writeFileSync(path.join(projectsRoot, "fixture-tool", "package.json"), JSON.stringify({ name: "fixture-tool", description: "A fixture public repository." }));
  return { root, sourceRoot, projectsRoot, outputDir };
}

test("CV-book source layer contains pending research and explicit GCC holds", () => {
  const layer = loadCvBookLayer();
  const roger = layer.entries.find((entry) => entry.id === "ai-research-roger-french-sdle");
  const datta = layer.entries.find((entry) => entry.id === "research-position-professor-datta");
  assert.deepEqual(roger?.dates, { start: "2026-08", end: null, label: "August 2026–present" });
  assert.equal(roger?.role, "Research contributor — pending confirmation; research led by Roger French");
  assert.equal(roger?.contributions, null);
  assert.equal(roger?.outcomes, null);
  assert.deepEqual(datta?.dates, { start: "2026-08", end: null, label: "August 2026–present" });
  assert.equal(datta?.title, "Research position with Professor Datta");
  assert.match(datta?.role || "", /pending confirmation/);
  assert.equal(layer.exclusions.length, 2);
  assert.deepEqual(layer.exclusions.map((exclusion) => exclusion.id), ["gcc", "csds-312-gnu-gcc"]);
  assert.equal(layer.sources.find((source) => source.id === "datta-email-confirmation")?.status, "pending");
});

test("markdown candidates are normalized and stable across repeated headings", () => {
  const candidates = extractMarkdownCandidates("### Example Project\nA metric of 25% is only a source hint.\n### Example Project\n", "cv-current");
  assert.deepEqual(candidates, [{
    id: "example-project",
    title: "Example Project",
    sourceIds: ["cv-current"],
    dateHints: [],
    variants: [],
  }]);
});

test("binary artifact hashes use bytes rather than string coercion", () => {
  assert.equal(hashBytes(Buffer.from("cv-book")), "10434e335464e62f86c4e647ef342aa370959829b8b8ab84e34c9dfd017e9c19");
});

test("refresh scans resumes and reports without publishing their contents", () => {
  const fixture = makeFixture();
  try {
    const beforeCv = readFileSync(path.join(fixture.sourceRoot, "cv.md"), "utf8");
    const beforeDigest = readFileSync(path.join(fixture.sourceRoot, "article-digest.md"), "utf8");
    const scan = scanCvBook({ sourceRoot: fixture.sourceRoot, roots: [fixture.projectsRoot], outputDir: fixture.outputDir });
    assert.equal(scan.result.reportMining.reportCount, 1);
    assert.equal(scan.result.resumeMining.fileCount, 1);
    assert.equal(scan.result.repositories.length, 1);
    assert.ok(scan.result.newItems.some((item) => item.id === "fixture-project"));
    assert.ok(!scan.result.newItems.some((item) => /gcc/i.test(item.title)));
    assert.match(renderCvBookRefreshReport(scan.result), /corroboration only/);
    assert.equal(readFileSync(path.join(fixture.sourceRoot, "cv.md"), "utf8"), beforeCv);
    assert.equal(readFileSync(path.join(fixture.sourceRoot, "article-digest.md"), "utf8"), beforeDigest);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("public projection keeps pending research visible, excludes private and held entries, and rejects unsafe metrics", () => {
  const fixture = makeFixture();
  try {
    const scan = scanCvBook({ sourceRoot: fixture.sourceRoot, roots: [fixture.projectsRoot], outputDir: fixture.outputDir });
    const projection = buildPublicProjection(scan.layer, scan.sourceCorpus, scan.result);
    assertPublicProjection(projection, scan.layer);
    const entries = JSON.stringify(projection.entries);
    assert.ok(projection.entries.some((entry) => entry.id === "ai-research-roger-french-sdle"));
    assert.ok(projection.entries.some((entry) => entry.id === "research-position-professor-datta"));
    assert.doesNotMatch(entries, /gcc/i);
    assert.doesNotMatch(entries, /ai-context-runtime|relay|elihealth/);
    assert.doesNotMatch(entries, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    assert.doesNotMatch(entries, /drive\.google\.com|reports[\\/]|job[- ]evaluation archive/i);
    const unsafeRoot = mkdtempSync(path.join(os.tmpdir(), "career-ops-cv-book-invalid-"));
    try {
      mkdirSync(path.join(unsafeRoot, "data", "cv-book"), { recursive: true });
      writeFileSync(path.join(unsafeRoot, "data", "cv-book", "entries.yml"), `schemaVersion: 1\nentries:\n  - id: unsafe-metric\n    kind: project\n    title: Unsafe metric\n    organization: null\n    role: null\n    dates: { start: null, end: null, label: Current }\n    status: pending\n    summary: 95% without evidence\n    contributions: []\n    outcomes: []\n    technologies: []\n    visibility: public\n    evidence: []\n    confidence: pending\n    reviewState: pending\n`);
      writeFileSync(path.join(unsafeRoot, "data", "cv-book", "sources.yml"), "schemaVersion: 1\nsources: []\n");
      writeFileSync(path.join(unsafeRoot, "data", "cv-book", "exclusions.yml"), "schemaVersion: 1\nexclusions: []\n");
      assert.throws(() => loadCvBookLayer(unsafeRoot), /metric without an evidence reference/);
    } finally {
      rmSync(unsafeRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("refresh output is deterministic and explicit apply remains review-file gated", () => {
  const fixture = makeFixture();
  try {
    const args = ["cv-book.mjs", "refresh", "--source-root", fixture.sourceRoot, "--root", fixture.projectsRoot, "--output-dir", fixture.outputDir, "--json"];
    const first = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
    const second = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
    assert.deepEqual(second, first);
    assert.match(readFileSync(path.join(fixture.outputDir, "latest.md"), "utf8"), /report-only/);
    const applyArgs = ["cv-book.mjs", "apply", "--source-root", fixture.sourceRoot, "--root", fixture.projectsRoot, "--output-dir", fixture.outputDir, "--json"];
    assert.throws(() => execFileSync(process.execPath, applyArgs, { encoding: "utf8", stdio: "pipe" }), /review-file/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
