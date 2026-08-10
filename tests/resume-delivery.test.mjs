import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  copyResumePdfToDelivery,
  normalizeResumeToken,
  resumeDeliveryPath,
} from '../resume-delivery.mjs';

test('resume delivery normalizes candidate and company names', () => {
  assert.equal(normalizeResumeToken('Jakye Amos'), 'Jakye-Amos');
  assert.equal(normalizeResumeToken('FlexAI, Inc.'), 'FlexAI-Inc');
  assert.equal(resumeDeliveryPath('Atlanta Hawks', {
    candidate: { full_name: 'Jakye Amos' },
  }, { outputDir: '/tmp/career-ops-cvs' }), '/tmp/career-ops-cvs/Jakye-Amos-CV-Atlanta-Hawks.pdf');
});

test('resume delivery copies only the requested PDF to the normalized path', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-resume-delivery-'));
  try {
    const source = path.join(root, 'resume.pdf');
    writeFileSync(source, '%PDF-1.7 fixture');
    const target = copyResumePdfToDelivery(source, 'Example AI', {
      candidate: { full_name: 'Jakye Amos' },
    }, { outputDir: path.join(root, 'CVs') });
    assert.equal(target, path.join(root, 'CVs', 'Jakye-Amos-CV-Example-AI.pdf'));
    assert.equal(readFileSync(target, 'utf8'), '%PDF-1.7 fixture');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
