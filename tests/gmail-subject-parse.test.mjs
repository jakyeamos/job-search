import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRoleAtCompany } from '../plugins/gmail/_helpers.mjs';

test('a single-job subject yields role and company', () => {
  const parsed = parseRoleAtCompany('Backend Engineer at Acme Corp');
  assert.deepEqual(parsed, { role: 'Backend Engineer', company: 'Acme Corp', digest: false });
});

test('alert prefixes and trailing separators are stripped before parsing', () => {
  const parsed = parseRoleAtCompany('Job alert: Data Platform Engineer at Stripe - LinkedIn');
  assert.equal(parsed.role, 'Data Platform Engineer');
  assert.equal(parsed.company, 'Stripe');
});

test('a digest subject does not swallow its tail into the company name', () => {
  // Regression: the greedy company capture produced
  // "F-ADA and 7 more jobs in New York, NY for you. Apply Now." as the company,
  // short enough to pass the length check and land in the queue verbatim.
  const parsed = parseRoleAtCompany('Data Analyst at F-ADA and 7 more jobs in New York, NY for you. Apply Now.');
  assert.equal(parsed.role, 'Data Analyst');
  assert.equal(parsed.company, 'F-ADA');
  assert.equal(parsed.digest, true, 'the subject describes 8 jobs, not one');
});

test('digest subjects are flagged across the phrasings alert senders use', () => {
  assert.equal(parseRoleAtCompany('Analyst at Acme and 3 other jobs for you').digest, true);
  assert.equal(parseRoleAtCompany('Backend Engineer at Acme & 12 more jobs').digest, true);
  assert.equal(parseRoleAtCompany('Backend Engineer at Acme: 9 new jobs').digest, true);
  assert.equal(parseRoleAtCompany('Backend Engineer at Acme Corp').digest, false);
});

test('call-to-action tails and trailing punctuation are dropped from the company', () => {
  assert.equal(parseRoleAtCompany('Software Engineer at Nuro. Apply Now.').company, 'Nuro');
  assert.equal(parseRoleAtCompany('Software Engineer at Nuro — see all matches').company, 'Nuro');
  assert.equal(parseRoleAtCompany('Software Engineer at Nuro for you').company, 'Nuro');
});

test('leftover subject prose is rejected rather than stored as a company', () => {
  assert.equal(parseRoleAtCompany('Your job alert for engineer at a growing team in the greater New York metropolitan area'), null);
  assert.equal(parseRoleAtCompany('61 people noticed your profile'), null);
  assert.equal(parseRoleAtCompany(''), null);
});

test('a company name containing "in" survives, since only digest tails are cut', () => {
  // "Analyst at Partners in Health" must not be truncated to "Partners".
  assert.equal(parseRoleAtCompany('Analyst at Partners in Health').company, 'Partners in Health');
});
