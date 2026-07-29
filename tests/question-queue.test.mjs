import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { questionPayload } from '../apply/question-queue.mjs';

test('privacy acknowledgements remain in handoff review but stay out of the answer queue', () => {
  const questions = questionPayload(fixture('handoff-only-review.json'), { entries: [] });

  assert.deepEqual(questions, []);
});

test('answerable questions remain in the reusable answer queue', () => {
  const questions = questionPayload(fixture('answerable-question.json'), { entries: [] });

  assert.deepEqual(questions.map((question) => question.question), ['Why do you want to join Sentry?']);
});

function fixture(name) {
  return JSON.parse(
    fs.readFileSync(new URL(`fixtures/question-queue/${name}`, import.meta.url), 'utf8'),
  );
}
