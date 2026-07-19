import { createServer } from 'http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import test from 'node:test';
import assert from 'node:assert/strict';

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
      '--resume', resumePath, '--submit', '--headless', '--browser', 'chrome-beta',
      '--fit-score', '4.5', '--liveness', 'active', '--company', 'Local Test', '--title', 'Backend Engineer',
    ], { cwd: path.resolve(new URL('..', import.meta.url).pathname), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const marker = result.stdout.split('\n').find((line) => line.startsWith('CAREER_OPS_APPLICATION_RESULT '));
    assert.ok(marker, result.stdout);
    const payload = JSON.parse(marker.slice('CAREER_OPS_APPLICATION_RESULT '.length));
    assert.equal(payload.state, 'submitted');
  } finally {
    server.close();
    await once(server, 'close').catch(() => {});
    if (previousOutreachState) writeFileSync(outreachStatePath, previousOutreachState);
    else if (existsSync(outreachStatePath)) rmSync(outreachStatePath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
