import { createServer } from 'http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectConfirmation, detectSubmissionBlock } from '../apply/lib/adapter-core.mjs';

test('confirmation detection prioritizes dialogs and live regions', () => {
  const result = detectConfirmation({
    url: 'https://jobs.ashbyhq.com/deepgram/f424ef6a/application',
    title: 'Deepgram careers',
    bodyText: 'Application form',
    signalTexts: ['Thank you for applying — we will be in touch.'],
    formCount: 1,
    submitControlCount: 1,
  });
  assert.equal(result.confirmed, true);
  assert.ok(result.markers.some((marker) => marker.includes('signal:thank-you')));
});

test('confirmation detection does not trust a body phrase while the form remains', () => {
  const result = detectConfirmation({
    url: 'https://jobs.ashbyhq.com/deepgram/f424ef6a/application',
    title: 'Deepgram careers',
    bodyText: 'Thank you for your interest. Complete the application below.',
    signalTexts: [],
    formCount: 1,
    submitControlCount: 1,
  });
  assert.equal(result.confirmed, false);
});

test('confirmation detection accepts a confirmation page body when the form is gone', () => {
  const result = detectConfirmation({
    url: 'https://jobs.ashbyhq.com/deepgram/f424ef6a/application',
    title: 'Deepgram careers',
    bodyText: 'Your application was submitted successfully.',
    signalTexts: [],
    formCount: 0,
    submitControlCount: 0,
  });
  assert.equal(result.confirmed, true);
  assert.ok(result.markers.some((marker) => marker.includes('body:application-submitted')));
});

test('confirmation detection recognizes a confirmation route in a nested frame', () => {
  const result = detectConfirmation({
    frames: [
      { url: 'https://jobs.ashbyhq.com/deepgram/f424ef6a/application', bodyText: 'Application form', formCount: 1, submitControlCount: 1 },
      { url: 'https://jobs.ashbyhq.com/deepgram/f424ef6a/thank-you', bodyText: '', formCount: 0, submitControlCount: 0 },
    ],
  });
  assert.equal(result.confirmed, true);
  assert.ok(result.markers.some((marker) => marker.includes('frame-1:url')));
});

test('submission block detection classifies explicit possible-spam responses', () => {
  const result = detectSubmissionBlock({
    title: 'Software Engineer, Data Platform @ Ramp',
    signalTexts: [
      "We couldn't submit your application. Your application submission was flagged as possible spam.",
    ],
  });
  assert.equal(result.blocked, true);
  assert.equal(result.state, 'blocked_by_antispam');
  assert.ok(result.markers.some((marker) => marker.includes('possible-spam')));
});

test('submission block detection ignores a reCAPTCHA footer without a block signal', () => {
  const result = detectSubmissionBlock({
    title: 'Software Engineer Application',
    bodyText: 'Protected by reCAPTCHA. Privacy Policy.',
    signalTexts: [],
  });
  assert.equal(result.blocked, false);
  assert.equal(result.state, null);
});

const execFileAsync = promisify(execFile);

test('Greenhouse adapter submits only after the authorized gate and records confirmation', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'career-ops-adapter-'));
  const server = createServer((request, response) => {
    if (request.method === 'POST') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body><h1>Thank you for applying</h1></body></html>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><form method="post" action="/submit">
      <input id="first_name" required><input id="last_name" required>
      <input id="email" required type="email"><input id="phone" required>
      <input id="resume" required type="file">
      <button type="submit">Submit Application</button>
    </form>`);
  });
  const listening = await new Promise((resolve, reject) => {
    const onListening = () => { server.off('error', onError); resolve(true); };
    const onError = (error) => {
      server.off('listening', onListening);
      if (error?.code === 'EPERM') {
        t.skip('sandbox does not permit binding an ephemeral localhost server');
        resolve(false);
      } else reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(0, '127.0.0.1');
  });
  if (!listening) return;
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const profilePath = path.join(directory, 'profile.json');
  const policyPath = path.join(directory, 'policy.json');
  const ledgerPath = path.join(directory, 'ledger.json');
  const resumePath = path.join(directory, 'resume.pdf');
  const outreachStatePath = path.resolve(new URL('../data/outreach-state.json', import.meta.url).pathname);
  const previousOutreachState = existsSync(outreachStatePath) ? readFileSync(outreachStatePath) : null;
  writeFileSync(profilePath, JSON.stringify({
    identity: { first_name: 'Jakye', last_name: 'Amos', full_name: 'Jakye Amos', email: 'jakyejobs@gmail.com', phone: '716-578-8221' },
    links: {},
    address: { country: 'United States' },
    work_authorization: { authorized_us: true, requires_sponsorship: false },
  }));
  writeFileSync(policyPath, JSON.stringify({ enabled: true, authorized: true, minFitScore: 4, allowedAdapters: ['greenhouse'] }));
  writeFileSync(resumePath, 'local smoke-test resume');

  try {
    const result = await execFileAsync(process.execPath, [
      'apply/fill-greenhouse.mjs', `http://127.0.0.1:${port}/jobs/1`,
      '--profile', profilePath, '--policy', policyPath, '--ledger', ledgerPath,
      '--resume', resumePath, '--submit', '--headless', '--browser', 'chrome',
      '--fit-score', '4.5', '--liveness', 'active', '--company', 'Local Test', '--title', 'Backend Engineer',
    ], { cwd: path.resolve(new URL('..', import.meta.url).pathname), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const marker = result.stdout.split('\n').find((line) => line.startsWith('CAREER_OPS_APPLICATION_RESULT '));
    assert.ok(marker, result.stdout);
    const payload = JSON.parse(marker.slice('CAREER_OPS_APPLICATION_RESULT '.length));
    assert.equal(payload.state, 'submitted');
    assert.equal(payload.submissionEvidence.confirmed, true);
    assert.ok(payload.submissionEvidence.markers.length > 0);
  } finally {
    server.close();
    await once(server, 'close').catch(() => {});
    if (previousOutreachState) writeFileSync(outreachStatePath, previousOutreachState);
    else if (existsSync(outreachStatePath)) rmSync(outreachStatePath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
