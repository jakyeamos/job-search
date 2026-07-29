import test from 'node:test';
import assert from 'node:assert/strict';

import { questionPayload } from '../apply/question-queue.mjs';

test('privacy acknowledgements remain in handoff review but stay out of the answer queue', () => {
  const questions = questionPayload([
    {
      id: 'privacy-review',
      company: 'Sentry',
      title: 'Software Engineer, Ingest',
      applyUrl: 'https://example.com/jobs/1',
      applicationState: 'blocked_by_question',
      applicationResult: {
        needsReview: [
          {
            label: "Legal: I understand the information I submit will be used in accordance with Sentry's Applicant Privacy Policy.",
            reason: 'legal attestation or background question — answer manually',
          },
          {
            label: 'Why do you want to join Sentry?',
            reason: 'required field needs an answer',
          },
        ],
      },
    },
  ], { entries: [] });

  assert.deepEqual(questions.map((question) => question.question), [
    'Why do you want to join Sentry?',
  ]);
});
