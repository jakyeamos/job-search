#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGETS_PATH = path.join(SCRIPT_DIR, 'data', 'civic-opportunities.yml');
const DEFAULT_DISCOVERIES_PATH = path.join(SCRIPT_DIR, 'data', 'civic-discoveries.yml');
const DEFAULT_OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');

const DISCOVERY_LANES = new Set(['current-role', 'outreach-target', 'stale-lead']);
const REPORT_RULES = Object.freeze({
  applicationTracker: false,
  autoContact: false,
  autoSubmit: false,
  verifyBeforeAction: true,
});

function fail(message) {
  throw new Error(`Civic discovery validation failed: ${message}`);
}

function requireString(record, field, label) {
  if (typeof record?.[field] !== 'string' || record[field].trim() === '') {
    fail(`${label} must include a non-empty ${field}`);
  }
  return record[field].trim();
}

function optionalString(record, field) {
  return typeof record?.[field] === 'string' && record[field].trim() !== ''
    ? record[field].trim()
    : undefined;
}

function arrayOrEmpty(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function readYamlDocument(filePath, fallback) {
  try {
    return yaml.load(readFileSync(filePath, 'utf8')) ?? fallback;
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new Error(`Unable to read ${filePath}: ${error.message}`);
  }
}

function sourceEvidence(value, label) {
  const evidence = arrayOrEmpty(value, `${label}.sourceEvidence`);
  return evidence.map((entry, index) => {
    if (typeof entry === 'string' && entry.trim() !== '') return entry.trim();
    if (entry && typeof entry === 'object') return { ...entry };
    fail(`${label}.sourceEvidence[${index}] must be a non-empty string or object`);
  });
}

function normalizeTarget(target, index, seenIds) {
  const label = `opportunities[${index}]`;
  const id = requireString(target, 'id', label);
  if (seenIds.has(id)) fail(`duplicate target id: ${id}`);
  seenIds.add(id);

  const organization = requireString(target, 'name', label);
  const url = optionalString(target, 'url');
  const layer = optionalString(target, 'layer');
  return {
    id,
    lane: 'outreach-target',
    organization,
    ...(url ? { url } : {}),
    ...(layer ? { layer } : {}),
    ...(optionalString(target, 'orientation') ? { orientation: optionalString(target, 'orientation') } : {}),
    kind: optionalString(target, 'kind'),
    status: optionalString(target, 'status'),
    location: optionalString(target, 'location'),
    fitBasis: arrayOrEmpty(target?.fitBasis, `${label}.fitBasis`),
    interestFit: optionalString(target, 'interestFit'),
    technicalBridge: optionalString(target, 'technicalBridge'),
    contributionModes: arrayOrEmpty(target?.contributionModes, `${label}.contributionModes`),
    nextAction: optionalString(target, 'nextAction'),
    sourceEvidence: sourceEvidence(target?.sourceEvidence, label),
    verification: optionalString(target, 'verification') ?? 'unverified-lead',
    humanAction: 'human-review-before-contact',
  };
}

function normalizeDiscovery(discovery, index, seenIds) {
  const label = `discoveries[${index}]`;
  const id = requireString(discovery, 'id', label);
  if (seenIds.has(id)) fail(`duplicate discovery id: ${id}`);
  seenIds.add(id);

  const lane = requireString(discovery, 'lane', label);
  if (!DISCOVERY_LANES.has(lane)) {
    fail(`${label}.lane must be one of ${[...DISCOVERY_LANES].join(', ')}`);
  }

  const organization = requireString(discovery, 'organization', label);
  const title = requireString(discovery, 'title', label);
  const url = optionalString(discovery, 'url');
  const verification = requireString(discovery, 'verification', label);
  const evidence = sourceEvidence(discovery?.sourceEvidence, label);

  if (lane === 'current-role') {
    if (!url) fail(`${label}.url is required for current-role discoveries`);
    if (verification !== 'live-verified') {
      fail(`${label}.verification must be live-verified for current-role discoveries`);
    }
    if (evidence.length === 0) fail(`${label}.sourceEvidence is required for current-role discoveries`);
  }

  if (lane === 'stale-lead' && !optionalString(discovery, 'reason')) {
    fail(`${label}.reason is required for stale-lead discoveries`);
  }

  return {
    ...discovery,
    id,
    lane,
    organization,
    title,
    ...(url ? { url } : {}),
    verification,
    sourceEvidence: evidence,
    humanAction:
      lane === 'current-role'
        ? 'human-review-before-apply'
        : lane === 'stale-lead'
          ? 'human-review-before-research-refresh'
          : 'human-review-before-contact',
  };
}

function validateDocumentVersion(document, label) {
  if (document?.schemaVersion !== undefined && document.schemaVersion !== 1) {
    fail(`${label}.schemaVersion must be 1`);
  }
}

export function buildCivicDiscoveryReport({ targets = [], discoveries = [], generatedAt = new Date().toISOString() } = {}) {
  const targetList = Array.isArray(targets) ? targets : targets?.opportunities;
  const discoveryList = Array.isArray(discoveries) ? discoveries : discoveries?.discoveries;
  if (!Array.isArray(targetList)) fail('targets must be an array or a civic-opportunities document');
  if (!Array.isArray(discoveryList)) fail('discoveries must be an array or a civic-discoveries document');

  const targetsSeen = new Set();
  const discoveriesSeen = new Set();
  const outreachTargets = targetList.map((target, index) => normalizeTarget(target, index, targetsSeen));
  const currentRoles = [];
  const explicitOutreachTargets = [];
  const staleLeads = [];

  discoveryList.forEach((discovery, index) => {
    const normalized = normalizeDiscovery(discovery, index, discoveriesSeen);
    if (normalized.lane === 'current-role') currentRoles.push(normalized);
    if (normalized.lane === 'outreach-target') explicitOutreachTargets.push(normalized);
    if (normalized.lane === 'stale-lead') staleLeads.push(normalized);
  });

  outreachTargets.push(...explicitOutreachTargets);
  const missionFirstTargets = outreachTargets.filter((record) => record.orientation === 'mission-first');
  const otherOutreachTargets = outreachTargets.filter((record) => record.orientation !== 'mission-first');
  const sortNewest = (left, right) => {
    const observedOrder = String(right.observedAt ?? '').localeCompare(String(left.observedAt ?? ''));
    return observedOrder || left.organization.localeCompare(right.organization) || left.title.localeCompare(right.title);
  };
  currentRoles.sort(sortNewest);
  staleLeads.sort(sortNewest);
  outreachTargets.sort((left, right) => left.organization.localeCompare(right.organization) || left.id.localeCompare(right.id));
  missionFirstTargets.sort((left, right) => left.organization.localeCompare(right.organization) || left.id.localeCompare(right.id));
  otherOutreachTargets.sort((left, right) => left.organization.localeCompare(right.organization) || left.id.localeCompare(right.id));

  return {
    schemaVersion: 1,
    generatedAt,
    rules: { ...REPORT_RULES },
    counts: {
      currentRoles: currentRoles.length,
      outreachTargets: outreachTargets.length,
      missionFirstTargets: missionFirstTargets.length,
      otherOutreachTargets: otherOutreachTargets.length,
      staleLeads: staleLeads.length,
      total: currentRoles.length + outreachTargets.length + staleLeads.length,
    },
    currentRoles,
    outreachTargets,
    missionFirstTargets,
    otherOutreachTargets,
    staleLeads,
  };
}

export function loadCivicDiscoveryReport({
  targetsPath = DEFAULT_TARGETS_PATH,
  discoveriesPath = DEFAULT_DISCOVERIES_PATH,
  generatedAt,
} = {}) {
  const targetsDocument = readYamlDocument(targetsPath, { schemaVersion: 1, opportunities: [] });
  const discoveriesDocument = readYamlDocument(discoveriesPath, { schemaVersion: 1, discoveries: [] });
  validateDocumentVersion(targetsDocument, 'targets');
  validateDocumentVersion(discoveriesDocument, 'discoveries');
  return buildCivicDiscoveryReport({
    targets: targetsDocument,
    discoveries: discoveriesDocument,
    generatedAt,
  });
}

function evidenceLabel(record) {
  if (!record.sourceEvidence?.length) return '';
  const first = record.sourceEvidence[0];
  if (typeof first === 'string') return ` Evidence: ${first}`;
  if (first?.url) return ` Evidence: ${first.url}`;
  return '';
}

function markdownRecord(record) {
  const heading = record.title ? `${record.organization} — ${record.title}` : record.organization;
  const linkedHeading = record.url ? `[${heading}](${record.url})` : heading;
  const details = [
    record.location,
    record.employmentType,
    record.compensation,
    record.verification,
    record.reason,
  ].filter(Boolean).join(' · ');
  const sentenceDetails = details.replace(/[.!?]+$/, '');
  const action = record.nextAction ? ` Next: ${record.nextAction}` : '';
  const interestFit = record.interestFit ? ` Interest fit: ${record.interestFit.replace(/[.!?]+$/, '')}.` : '';
  const technicalBridge = record.technicalBridge ? ` Secondary bridge: ${record.technicalBridge.replace(/[.!?]+$/, '')}.` : '';
  return `- **${linkedHeading}**${sentenceDetails ? ` — ${sentenceDetails}.` : '.'}${interestFit}${technicalBridge}${action}${evidenceLabel(record)}`;
}

export function renderCivicDiscoveryMarkdown(report) {
  const section = (title, records, emptyText) => [
    `## ${title}`,
    '',
    ...(records.length ? records.map(markdownRecord) : [`_${emptyText}_`]),
    '',
  ];

  return [
    '# Civic discovery',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    'This additive lane keeps civic discovery separate from the paid application tracker. All actions remain human-reviewed.',
    '',
    ...section('Current roles — human review before applying', report.currentRoles, 'No live civic roles recorded.'),
    ...section('Outreach targets — human review before contacting', report.outreachTargets, 'No civic outreach targets recorded.'),
    ...section('Stale leads — refresh before acting', report.staleLeads, 'No stale civic leads recorded.'),
  ].join('\n');
}

export function parseCivicDiscoveryArgs(argv) {
  const options = { json: false, write: false, outputDir: DEFAULT_OUTPUT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--write') options.write = true;
    else if (arg === '--output-dir') {
      const value = argv[++index];
      if (!value) fail('--output-dir requires a path');
      options.outputDir = path.resolve(value);
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else fail(`unknown argument: ${arg}`);
  }
  return options;
}

export function runCivicDiscoveryCli(argv = process.argv.slice(2)) {
  const options = parseCivicDiscoveryArgs(argv);
  if (options.help) {
    return [
      'Usage: node civic-discovery.mjs [--json] [--write] [--output-dir <dir>]',
      '',
      'Reads data/civic-opportunities.yml and data/civic-discoveries.yml.',
      'Never reads or writes data/applications.md.',
    ].join('\n');
  }

  const report = loadCivicDiscoveryReport();
  if (options.write) {
    mkdirSync(options.outputDir, { recursive: true });
    const jsonPath = path.join(options.outputDir, 'civic-discovery.json');
    const markdownPath = path.join(options.outputDir, 'civic-discovery.md');
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(markdownPath, `${renderCivicDiscoveryMarkdown(report)}\n`);
    return `Wrote ${markdownPath}\nWrote ${jsonPath}`;
  }

  return options.json ? JSON.stringify(report, null, 2) : renderCivicDiscoveryMarkdown(report);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    process.stdout.write(`${runCivicDiscoveryCli()}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
