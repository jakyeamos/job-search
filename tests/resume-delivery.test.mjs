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

test('resume delivery preserves the canonical lane filename', () => {
  assert.equal(normalizeResumeToken('Jakye Amos'), 'Jakye-Amos');
  assert.equal(normalizeResumeToken('FlexAI, Inc.'), 'FlexAI-Inc');
  assert.equal(resumeDeliveryPath('/repo/output/lanes/Jakye-Amos-Resume-Sports-Analytics.pdf', {
    candidate: { full_name: 'Jakye Amos' },
  }, { outputDir: '/tmp/career-ops-cvs' }), '/tmp/career-ops-cvs/Jakye-Amos-Resume-Sports-Analytics.pdf');
});

test('resume delivery copies only the requested PDF to the normalized path', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-resume-delivery-'));
  try {
    const source = path.join(root, 'Jakye-Amos-Resume-Backend-AI-Data.pdf');
    writeFileSync(source, '%PDF-1.7 fixture');
    const target = copyResumePdfToDelivery(source, {
      candidate: { full_name: 'Jakye Amos' },
    }, { outputDir: path.join(root, 'CVs') });
    assert.equal(target, path.join(root, 'CVs', 'Jakye-Amos-Resume-Backend-AI-Data.pdf'));
    assert.equal(readFileSync(target, 'utf8'), '%PDF-1.7 fixture');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
