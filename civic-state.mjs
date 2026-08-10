#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CIVIC_STATE_PATH = path.join(ROOT, 'data', 'civic-state.json');
const SCHEMA_VERSION = 1;

function emptyCivicState() {
  return { schemaVersion: SCHEMA_VERSION, dismissed: {} };
}

function normalizeDismissed(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => key.trim() && entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(([key, entry]) => [key, {
      dismissedAt: typeof entry.dismissedAt === 'string' && entry.dismissedAt.trim()
        ? entry.dismissedAt.trim()
        : null,
      ...(typeof entry.reason === 'string' && entry.reason.trim() ? { reason: entry.reason.trim() } : {}),
    }]));
}

export function loadCivicState(filePath = DEFAULT_CIVIC_STATE_PATH) {
  if (!existsSync(filePath)) return emptyCivicState();
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed?.schemaVersion !== undefined && parsed.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`civic state schemaVersion must be ${SCHEMA_VERSION}`);
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      dismissed: normalizeDismissed(parsed?.dismissed),
    };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Unable to read ${filePath}: invalid JSON`);
    if (error instanceof Error && /schemaVersion/.test(error.message)) throw error;
    throw new Error(`Unable to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function saveCivicState(filePath = DEFAULT_CIVIC_STATE_PATH, state = emptyCivicState()) {
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    dismissed: normalizeDismissed(state?.dismissed),
  };
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`);
  renameSync(temporaryPath, filePath);
  return normalized;
}

export function civicRecordKey(record) {
  const lane = String(record?.lane || '').trim();
  const id = String(record?.id || '').trim();
  return lane && id ? `${lane}:${id}` : '';
}

export function civicRecords(report) {
  return [
    ...(Array.isArray(report?.currentRoles) ? report.currentRoles : []),
    ...(Array.isArray(report?.outreachTargets) ? report.outreachTargets : []),
    ...(Array.isArray(report?.staleLeads) ? report.staleLeads : []),
  ];
}

function withCivicKey(record) {
  const key = civicRecordKey(record);
  return key ? { ...record, civicKey: key } : { ...record };
}

function splitActive(records, dismissed) {
  const active = [];
  const removed = [];
  for (const record of records || []) {
    const key = civicRecordKey(record);
    const dismissal = key ? dismissed[key] : null;
    if (dismissal) {
      removed.push({
        ...withCivicKey(record),
        dismissedAt: dismissal.dismissedAt,
        ...(dismissal.reason ? { dismissalReason: dismissal.reason } : {}),
      });
    } else {
      active.push(withCivicKey(record));
    }
  }
  return { active, removed };
}

export function applyCivicState(report, state = emptyCivicState()) {
  const dismissed = normalizeDismissed(state?.dismissed);
  const current = splitActive(report?.currentRoles, dismissed);
  const outreach = splitActive(report?.outreachTargets, dismissed);
  const stale = splitActive(report?.staleLeads, dismissed);
  const missionFirstTargets = outreach.active.filter((record) => record.orientation === 'mission-first');
  const otherOutreachTargets = outreach.active.filter((record) => record.orientation !== 'mission-first');
  const dismissedRecords = [...current.removed, ...outreach.removed, ...stale.removed]
    .sort((left, right) => String(right.dismissedAt || '').localeCompare(String(left.dismissedAt || ''))
      || String(left.organization || '').localeCompare(String(right.organization || ''))
      || String(left.title || '').localeCompare(String(right.title || '')));

  return {
    ...report,
    counts: {
      ...report.counts,
      currentRoles: current.active.length,
      outreachTargets: outreach.active.length,
      missionFirstTargets: missionFirstTargets.length,
      otherOutreachTargets: otherOutreachTargets.length,
      staleLeads: stale.active.length,
      dismissed: dismissedRecords.length,
      total: current.active.length + outreach.active.length + stale.active.length,
    },
    currentRoles: current.active,
    outreachTargets: outreach.active,
    missionFirstTargets,
    otherOutreachTargets,
    staleLeads: stale.active,
    dismissed: dismissedRecords,
  };
}

function findCivicRecord(report, key) {
  return civicRecords(report).find((record) => civicRecordKey(record) === key);
}

export function dismissCivicRecord(report, filePath = DEFAULT_CIVIC_STATE_PATH, key, reason = '') {
  const record = findCivicRecord(report, key);
  if (!record) throw new Error('civic record not found; refresh the page and try again');
  const state = loadCivicState(filePath);
  const previous = state.dismissed[key];
  state.dismissed[key] = {
    dismissedAt: previous?.dismissedAt || new Date().toISOString(),
    ...(reason ? { reason } : previous?.reason ? { reason: previous.reason } : {}),
  };
  saveCivicState(filePath, state);
  return { changed: !previous, record, state: loadCivicState(filePath) };
}

export function restoreCivicRecord(report, filePath = DEFAULT_CIVIC_STATE_PATH, key) {
  const record = findCivicRecord(report, key);
  if (!record) throw new Error('civic record not found; refresh the page and try again');
  const state = loadCivicState(filePath);
  const changed = Boolean(state.dismissed[key]);
  delete state.dismissed[key];
  saveCivicState(filePath, state);
  return { changed, record, state: loadCivicState(filePath) };
}
