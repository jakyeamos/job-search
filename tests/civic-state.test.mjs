import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadCivicDiscoveryReport } from '../civic-discovery.mjs';
import { applyCivicAction } from '../queue-ui.mjs';
import {
  applyCivicState,
  civicRecordKey,
  dismissCivicRecord,
  loadCivicState,
  restoreCivicRecord,
} from '../civic-state.mjs';

test('Civic dismissal hides active records, retains evidence, and restores them', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'civic-state-'));
  const statePath = path.join(directory, 'civic-state.json');
  try {
    const report = loadCivicDiscoveryReport({ generatedAt: '2026-08-09T12:00:00.000Z' });
    const target = report.missionFirstTargets.find((record) => record.id === 'cleveland-owns');
    const key = civicRecordKey(target);

    assert.equal(loadCivicState(statePath).dismissed[key], undefined);
    const dismissed = dismissCivicRecord(report, statePath, key);
    const hidden = applyCivicState(report, dismissed.state);
    assert.equal(hidden.missionFirstTargets.some((record) => record.id === target.id), false);
    assert.equal(hidden.dismissed.length, 1);
    assert.equal(hidden.dismissed[0].civicKey, key);
    assert.equal(hidden.dismissed[0].sourceEvidence.length, target.sourceEvidence.length);
    assert.equal(hidden.counts.missionFirstTargets, report.counts.missionFirstTargets - 1);
    assert.equal(hidden.counts.total, report.counts.total - 1);

    const restored = restoreCivicRecord(report, statePath, key);
    const visible = applyCivicState(report, restored.state);
    assert.equal(visible.missionFirstTargets.some((record) => record.id === target.id), true);
    assert.equal(visible.dismissed.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Civic actions return only the refreshed Civic projection', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'civic-action-'));
  const statePath = path.join(directory, 'civic-state.json');
  try {
    const report = loadCivicDiscoveryReport({ generatedAt: '2026-08-09T12:00:00.000Z' });
    const target = report.currentRoles.find((record) => record.id === 'blue-rose-product-manager');
    const key = civicRecordKey(target);

    const dismissed = applyCivicAction({ action: 'dismiss', key }, { civicStatePath: statePath });
    assert.equal(dismissed.state, undefined);
    assert.equal(dismissed.civic.currentRoles.some((record) => record.id === target.id), false);
    assert.equal(dismissed.civic.dismissed.some((record) => record.civicKey === key), true);

    const restored = applyCivicAction({ action: 'restore', key }, { civicStatePath: statePath });
    assert.equal(restored.state, undefined);
    assert.equal(restored.civic.currentRoles.some((record) => record.id === target.id), true);
    assert.equal(restored.civic.dismissed.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
