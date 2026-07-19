import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isProjectAccomplishmentQuestion,
  projectAccomplishmentAnswerTable,
  selectProjectAccomplishment,
} from '../project-accomplishment-ledger.mjs';
import { answerFor, loadLedgerAnswers } from '../apply/lib/adapter-core.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ledger = {
  schemaVersion: 1,
  entries: [
    {
      id: 'tenure',
      name: 'Tenure',
      approved: true,
      priority: 8,
      evidenceStrength: 5,
      lanes: ['applied_ai_client_delivery'],
      laneWeights: { applied_ai_client_delivery: 14 },
      keywords: ['knowledge', 'retrieval', 'organizational'],
      answer: 'Tenure answer',
    },
    {
      id: 'quality-runner',
      name: 'Quality Runner',
      approved: true,
      priority: 7,
      evidenceStrength: 5,
      lanes: ['developer_tools_infrastructure'],
      laneWeights: { developer_tools_infrastructure: 14 },
      keywords: ['quality', 'mcp', 'cli'],
      answer: 'Quality Runner answer',
    },
  ],
};

test('recognizes accomplishment questions without matching ordinary form fields', () => {
  assert.equal(isProjectAccomplishmentQuestion('What is the most impressive thing you built with AI?'), true);
  assert.equal(isProjectAccomplishmentQuestion('Are you authorized to work in the United States?'), false);
});

test('selects the project whose lane and job signals fit best', () => {
  const result = selectProjectAccomplishment({
    title: 'Applied AI Engineer',
    description: 'Build knowledge retrieval and organizational intelligence workflows.',
  }, ledger);
  assert.equal(result?.id, 'tenure');

  const infrastructure = selectProjectAccomplishment({
    title: 'Developer Infrastructure Engineer',
    description: 'Build a CLI and MCP quality gate for engineering workflows.',
  }, ledger);
  assert.equal(infrastructure?.id, 'quality-runner');
});

test('builds a deterministic answer table with source provenance', () => {
  const table = projectAccomplishmentAnswerTable({
    title: 'Applied AI Engineer',
    description: 'Build knowledge retrieval workflows.',
  }, ledger);
  assert.equal(table.length, 1);
  assert.equal(table[0].value, 'Tenure answer');
  assert.equal(table[0].source, 'project-accomplishment:tenure');
  assert.equal(table[0].re.test('What accomplishment are you most proud of?'), true);
});

test('adapters use the job-aware project ledger when no explicit answer exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'career-ops-project-ledger-'));
  const file = join(directory, 'questions.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, entries: [] }));
  const tables = await loadLedgerAnswers(file, {
    company: 'Example AI company',
    role: 'Developer Infrastructure Engineer',
    description: 'Build a CLI, MCP server, and quality workflow for engineering teams.',
  });
  assert.match(
    answerFor('What is the most impressive thing you have personally built?', [tables]),
    /Quality Runner/,
  );
});
