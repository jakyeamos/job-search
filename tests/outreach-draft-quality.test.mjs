import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessOutreachDraftQuality,
  prepareOutreachDraft,
  validateOutreachDraftReceipt,
} from '../outreach-draft-quality.mjs';

test('Humanizer and quality produce a content-bound receipt before persistence', () => {
  const prepared = prepareOutreachDraft({
    channel: 'linkedin',
    body: 'Hi Avery — I applied for Software Engineer at Glean. I would enjoy hearing how the team approaches developer tools.',
    contactName: 'Avery Example',
    company: 'Glean',
  });

  assert.equal(prepared.receipt.passed, true);
  assert.doesNotMatch(prepared.body, /—|I would enjoy hearing/);
  assert.equal(validateOutreachDraftReceipt({ channel: 'linkedin', body: prepared.body, receipt: prepared.receipt }).ok, true);
});

test('the known Glean fragment and capitalization defects fail quality', () => {
  const quality = assessOutreachDraftQuality({
    channel: 'email',
    subject: 'Software Engineer at Glean',
    body: 'Hi Avery,\n\nI applied for Software Engineer at Glean. Because of our existing case western reserve university connection, I wanted to reach out directly. Three Amazon SDE internships across Ads and FinTech teams.\n\nhttps://jakye.netlify.app/',
    contactName: 'Avery Example',
    company: 'Glean',
  });

  assert.equal(quality.passed, false);
  assert.match(quality.errors.join('\n'), /university name|sentence fragment|proof-point fragment/i);
});

test('editing approved social copy invalidates its receipt', () => {
  const prepared = prepareOutreachDraft({
    channel: 'x',
    body: 'Hi Avery, I applied for Software Engineer at Glean. Could you point me to the right engineering contact?',
    contactName: 'Avery Example',
    company: 'Glean',
  });
  const validation = validateOutreachDraftReceipt({
    channel: 'x',
    body: `${prepared.body} Thanks!`,
    receipt: prepared.receipt,
  });
  assert.equal(validation.ok, false);
});
