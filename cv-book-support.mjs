import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(ROOT, "data", "cv-book");
export const DEFAULT_OUTPUT_DIR = path.join(ROOT, "output", "cv-book");
export const DEFAULT_SOURCE_ROOT = path.resolve(process.env.CV_BOOK_SOURCE_ROOT || ROOT);
export const DEFAULT_REPOSITORY_ROOTS = [path.join(os.homedir(), "projects"), path.join(os.homedir(), "Documents")];
export const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
export const DRIVE_PATTERN = /(?:drive|docs)\.google\.com|(?:google\s+drive|drive\s+id)/i;
export const RAW_REPORT_PATTERN = /(?:^|[\\/])reports(?:[\\/]|$)|job[-\s]?evaluation archive/i;
export const RESUME_FILE_PATTERN = /(?:resume|cv)/i;
export const METRIC_PATTERN = /(?:[$€£]\s?\d[\d,.]*\s*[KMB]?|\b\d[\d,.]*\+?\s*(?:%|percent|views?|attendees?|revenue|weeks?|days?|months?|terms?|users?|customers?))/i;
export const ALLOWED_KINDS = new Set(["work", "project", "research", "education", "leadership", "writing", "tooling"]);
export const ALLOWED_VISIBILITIES = new Set(["public", "private", "internal"]);
export const ALLOWED_REVIEW_STATES = new Set(["approved", "pending", "held"]);

export function expandPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

export function readText(filePath, maxBytes = 8_000_000) {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size > maxBytes) return "";
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function readJson(filePath) {
  const content = readText(filePath);
  if (!content) throw new Error(`Missing or unreadable JSON file: ${filePath}`);
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function requiredString(value, field, context) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${context}.${field} must be a non-empty string`);
  return value.trim();
}

export function optionalString(value, field, context) {
  if (value === null || value === undefined) return null;
  return requiredString(value, field, context);
}

export function stringArray(value, field, context) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${context}.${field} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

export function nullableStringArray(value, field, context) {
  if (value === null || value === undefined) return null;
  return stringArray(value, field, context);
}

export function normalizeMonth(value, field, context) {
  if (value === null || value === undefined) return null;
  const month = requiredString(value, field, context);
  if (!MONTH_PATTERN.test(month)) throw new Error(`${context}.${field} must use YYYY-MM or null`);
  return month;
}

export function normalizeDates(value, context) {
  if (!isObject(value)) throw new Error(`${context}.dates must be an object`);
  const start = normalizeMonth(value.start, "start", `${context}.dates`);
  const end = normalizeMonth(value.end, "end", `${context}.dates`);
  if (start && end && start > end) throw new Error(`${context}.dates.start must not be after dates.end`);
  return { start, end, label: requiredString(value.label, "label", `${context}.dates`) };
}

export function sourcePath(source, sourceRoot, workspaceRoot = ROOT) {
  if (!source.path) return null;
  return path.resolve(source.root === "workspace" ? workspaceRoot : sourceRoot, source.path);
}

export function hashText(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashJson(value) {
  return hashText(stableJson(value));
}

export function walkFiles(root) {
  if (!existsSync(root)) return [];
  let stats;
  try { stats = statSync(root); } catch { return []; }
  if (stats.isFile()) return [root];
  let children;
  try { children = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return children.flatMap((child) => walkFiles(path.join(root, child.name))).sort((left, right) => left.localeCompare(right));
}

export function digestPath(filePath) {
  if (!filePath || !existsSync(filePath)) return { exists: false, digest: "" };
  const files = walkFiles(filePath).filter((candidate) => !candidate.includes(`${path.sep}.git${path.sep}`));
  if (files.length === 0) return { exists: false, digest: "" };
  const manifest = files.map((candidate) => ({ path: candidate, digest: hashText(readText(candidate)) }));
  return { exists: true, digest: hashJson(manifest) };
}

export function runGit(repository, args) {
  try {
    const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    return result.status === 0 ? String(result.stdout || "").trim() : "";
  } catch {
    return "";
  }
}

export function humanizeRepositoryName(value) {
  return String(value || "").replace(/^@[^/]+\//, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function firstMeaningfulLine(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/, "").replace(/^#+\s+/, "").replace(/[`*_]/g, ""))
    .find((line) => line.length >= 35 && !/^https?:\/\//i.test(line)) || "";
}
