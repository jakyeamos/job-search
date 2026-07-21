#!/usr/bin/env node

// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';

export const RESUME_CONTRACT_VERSION = 1;
export const DEFAULT_RESUME_ARTIFACT_RELATIVE = 'output/Jakye_Amos_Canonical_Base_Resume.pdf';
export const DEFAULT_RESUME_MANIFEST_ROOT_RELATIVE = 'output/applications';

const SUPPORTED_ARTIFACT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);
const EVIDENCE_SOURCE_PATHS = ['cv.md', 'article-digest.md', 'config/profile.yml'];
const EUROPE_RE = /\b(europe|emea|uk|united kingdom|england|scotland|wales|ireland|france|germany|spain|netherlands|belgium|luxembourg|switzerland|italy|austria|czech(?:ia)?|poland|romania|hungary|slovakia|slovenia|croatia|serbia|greece|bulgaria|sweden|norway|denmark|finland|iceland|portugal|malta|cyprus|london|berlin|paris|madrid|amsterdam|dublin|stockholm|oslo|prague|vienna|lisbon|barcelona|munich|zurich|milan|copenhagen|helsinki|warsaw|budapest|bucharest)\b/i;
const NORTH_AMERICA_RE = /\b(us|usa|u\.s\.|united states|canada|ontario|toronto|vancouver|montreal|calgary|ottawa|edmonton|quebec|winnipeg|halifax|waterloo|new york|nyc|chicago|seattle|buffalo|boston|austin|san francisco|los angeles)\b/i;

const FALLBACK_LANE_PROJECTS = {
  backend_ai_platform: ['Tenure', 'BidCamp', 'Quality Runner'],
  developer_tools_infrastructure: ['Quality Runner', 'Pre-CR Suite', 'AIOS'],
  applied_ai_client_delivery: ['Tenure', 'BidCamp', 'Forward Automations'],
  product_full_stack: ['BidCamp', 'Hoopscout', 'Court Vision'],
  data_analytics: ['Dsci-proj', 'BBDSE/CourtIQ', 'Tenure'],
  solutions_forward_deployed: ['Forward Automations', 'Tenure', 'BidCamp'],
  sports_analytics: ['BBDSE/CourtIQ', 'Court Vision', 'Fantasy'],
};

/** @param {unknown} value */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} value */
function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** @param {string} value */
function normalizeKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** @param {string} value */
function hashText(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

/** @param {string} file */
function hashFile(file) {
  return hashText(readFileSync(file));
}

/** @param {string} value @param {string} fallback */
function slugify(value, fallback) {
  const slug = normalizeText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 54);
  return slug || fallback;
}

/** @param {string} root @param {string} value */
function absolutePath(root, value) {
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

/** @param {string} root @param {string} file */
function repoRelativePath(root, file) {
  const relativePath = relative(root, resolve(file));
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return '';
  return relativePath.split(/[/\\]/g).join('/');
}

/** @param {string} root */
function loadLaneMatrix(root) {
  const profilePath = join(root, 'config', 'profile.yml');
  if (!existsSync(profilePath)) return {};
  try {
    const parsed = yaml.load(readFileSync(profilePath, 'utf8'));
    if (!isObject(parsed)) return {};
    const strategy = parsed.search_strategy;
    if (!isObject(strategy) || !isObject(strategy.lane_matrix)) return {};
    return strategy.lane_matrix;
  } catch {
    return {};
  }
}

/** @param {string} root @param {string} lane */
function laneProjects(root, lane) {
  const matrix = loadLaneMatrix(root);
  const configured = matrix[lane];
  if (isObject(configured) && Array.isArray(configured.resume_projects)) {
    const projects = configured.resume_projects.map((project) => normalizeText(String(project))).filter(Boolean);
    if (projects.length) return projects;
  }
  return FALLBACK_LANE_PROJECTS[lane] || FALLBACK_LANE_PROJECTS.backend_ai_platform;
}

/** @param {string} location @param {string} description */
export function inferResumeFormat(location = '', description = '') {
  const text = `${location} ${description}`;
  if (NORTH_AMERICA_RE.test(text)) return 'letter';
  if (EUROPE_RE.test(text)) return 'a4';
  return 'letter';
}

/** @param {Record<string, unknown>} item */
export function resumeJobKey(item) {
  const company = normalizeText(String(item.company || ''));
  const title = normalizeText(String(item.title || ''));
  const url = normalizeText(String(item.canonicalUrl || item.applyUrl || ''));
  const stablePart = String(item.id || hashText(`${company}|${title}|${url}`).slice(0, 12));
  return `${slugify(company, 'company')}-${slugify(title, 'role')}-${stablePart.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 20)}`;
}

/** @param {string} root */
function evidenceSources(root) {
  return EVIDENCE_SOURCE_PATHS
    .map((relativePath) => ({ relativePath, absolutePath: join(root, relativePath) }))
    .filter((source) => existsSync(source.absolutePath))
    .map((source) => ({
      path: source.relativePath,
      sha256: hashFile(source.absolutePath),
    }));
}

/** @param {Record<string, unknown>} item @param {string} root */
export function buildResumeRequest(item, root) {
  const lane = normalizeText(String(item.lane || 'backend_ai_platform')) || 'backend_ai_platform';
  const company = normalizeText(String(item.company || ''));
  const title = normalizeText(String(item.title || 'Job lead'));
  const location = normalizeText(String(item.location || ''));
  const description = normalizeText(String(item.description || ''));
  const jobKey = String(item.resumeJobKey || resumeJobKey(item));
  const manifestPath = join(root, DEFAULT_RESUME_MANIFEST_ROOT_RELATIVE, jobKey, 'resume-manifest.json');
  const configuredArtifact = normalizeText(String(item.resumeArtifact || ''));
  const artifactPath = configuredArtifact
    ? absolutePath(root, configuredArtifact)
    : join(root, DEFAULT_RESUME_ARTIFACT_RELATIVE);

  return {
    contractVersion: RESUME_CONTRACT_VERSION,
    jobKey,
    job: {
      company,
      title,
      location,
      url: normalizeText(String(item.applyUrl || item.canonicalUrl || '')),
      descriptionSha256: hashText(description),
    },
    lane,
    paperFormat: inferResumeFormat(location, description),
    selectedProjects: laneProjects(root, lane),
    evidenceSources: evidenceSources(root),
    artifactPath,
    manifestPath,
  };
}

/** @param {string} file */
function isSupportedArtifact(file) {
  return SUPPORTED_ARTIFACT_EXTENSIONS.has(extname(file).toLowerCase());
}

/** @param {string} root @param {string} file */
function artifactMetadata(root, file) {
  const relativePath = repoRelativePath(root, file);
  if (!relativePath) throw new Error(`resume artifact must be inside Career Ops: ${file}`);
  const stats = statSync(file);
  return {
    path: relativePath,
    sha256: hashFile(file),
    bytes: stats.size,
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
  };
}

/** @param {ReturnType<typeof buildResumeRequest>} request @param {string} artifactPath @param {{ root?: string, htmlPath?: string, sourceMode?: string, auditStatus?: string }} [options] */
export function createResumeManifest(request, artifactPath, options = {}) {
  const absoluteArtifact = resolve(artifactPath);
  if (!existsSync(absoluteArtifact)) throw new Error(`resume artifact does not exist: ${absoluteArtifact}`);
  if (!isSupportedArtifact(absoluteArtifact)) throw new Error(`unsupported resume artifact type: ${extname(absoluteArtifact) || '(none)'}`);
  const manifestRoot = options.root || process.cwd();
  const htmlPath = options.htmlPath ? repoRelativePath(manifestRoot, options.htmlPath) : '';
  return {
    schemaVersion: RESUME_CONTRACT_VERSION,
    jobKey: request.jobKey,
    createdAt: new Date().toISOString(),
    sourceMode: options.sourceMode || 'tailored',
    auditStatus: options.auditStatus || 'not-run',
    job: request.job,
    lane: request.lane,
    paperFormat: request.paperFormat,
    selectedProjects: request.selectedProjects,
    evidenceSources: request.evidenceSources,
    artifact: artifactMetadata(manifestRoot, absoluteArtifact),
    htmlPath,
  };
}

/** @param {string} file @param {Record<string, unknown>} manifest */
export function writeResumeManifest(file, manifest) {
  const target = resolve(file);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(temp, target);
  return target;
}

/** @param {string} file */
function readResumeManifest(file) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {Record<string, unknown>} item @param {string} root */
export function resolveResumeArtifact(item, root) {
  const request = buildResumeRequest(item, root);
  const manifestPath = normalizeText(String(item.resumeManifest || ''))
    ? absolutePath(root, String(item.resumeManifest))
    : request.manifestPath;
  const manifest = readResumeManifest(manifestPath);

  if (manifest) {
    const artifact = isObject(manifest.artifact) ? manifest.artifact : {};
    const artifactPath = typeof artifact.path === 'string' ? absolutePath(root, artifact.path) : '';
    if (!artifactPath || !existsSync(artifactPath)) {
      return { ok: false, status: 'missing', reason: 'resume manifest points to a missing artifact', request, manifestPath };
    }
    if (!isSupportedArtifact(artifactPath)) {
      return { ok: false, status: 'unsupported', reason: `resume manifest points to an unsupported file type: ${extname(artifactPath)}`, request, manifestPath };
    }
    if (manifest.jobKey && manifest.jobKey !== request.jobKey) {
      return { ok: false, status: 'stale', reason: 'resume manifest belongs to a different queue role', request, manifestPath };
    }
    if (typeof artifact.sha256 === 'string' && artifact.sha256 !== hashFile(artifactPath)) {
      return { ok: false, status: 'stale', reason: 'resume artifact changed after its manifest was written', request, manifestPath };
    }
    return { ok: true, status: 'manifested', artifactPath, manifestPath, manifest, request };
  }

  const artifactPath = request.artifactPath;
  if (!existsSync(artifactPath)) {
    return { ok: false, status: 'missing', reason: `resume artifact does not exist: ${artifactPath}`, request, manifestPath };
  }
  if (!isSupportedArtifact(artifactPath)) {
    return { ok: false, status: 'unsupported', reason: `resume artifact must be PDF, DOC, or DOCX: ${artifactPath}`, request, manifestPath };
  }

  const legacyManifest = createResumeManifest(request, artifactPath, {
    root,
    sourceMode: 'legacy-existing',
    auditStatus: 'unknown',
  });
  return { ok: true, status: 'legacy-existing', artifactPath, manifestPath, manifest: legacyManifest, request };
}

/** @param {Record<string, unknown>} item @param {string} root @param {{ artifactPath: string, htmlPath?: string, sourceMode?: string, auditStatus?: string }} options */
export function registerResumeArtifact(item, root, options) {
  const request = buildResumeRequest(item, root);
  const artifactPath = absolutePath(root, options.artifactPath);
  const manifest = createResumeManifest(request, artifactPath, {
    root,
    htmlPath: options.htmlPath ? absolutePath(root, options.htmlPath) : '',
    sourceMode: options.sourceMode || 'tailored',
    auditStatus: options.auditStatus || 'not-run',
  });
  writeResumeManifest(request.manifestPath, manifest);
  return { request, manifest, artifactPath, manifestPath: request.manifestPath };
}
