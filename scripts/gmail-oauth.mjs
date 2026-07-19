#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET_ACCOUNT = 'jakyejobs@gmail.com';
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.send',
];
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(projectRoot, '.env');

function readEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
    .map((line) => line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]));
}

function writeRefreshToken(filePath, token) {
  const lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/) : [];
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (!line.startsWith('GMAIL_REFRESH_TOKEN=')) return line;
    replaced = true;
    return `GMAIL_REFRESH_TOKEN=${token}`;
  });
  if (!replaced) nextLines.push(`GMAIL_REFRESH_TOKEN=${token}`);
  fs.writeFileSync(filePath, `${nextLines.filter((line, index) => index < nextLines.length - 1 || line).join('\n').replace(/\n*$/, '\n')}`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function base64Url(value) {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function exchangeCode({ code, redirectUri, verifier, clientId, clientSecret }) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Google token exchange failed: ${payload.error_description || payload.error || response.status}`);
  if (typeof payload.refresh_token !== 'string' || !payload.refresh_token) {
    throw new Error('Google did not return a refresh token. Re-run the flow and keep prompt=consent enabled.');
  }
  return payload.refresh_token;
}

async function main() {
  const env = readEnv(envPath);
  const clientId = env.GMAIL_CLIENT_ID;
  const clientSecret = env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error(`Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in ${envPath}`);

  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64Url(crypto.randomBytes(32));

  const result = await new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== '/') {
          response.writeHead(404).end('Not found');
          return;
        }
        if (requestUrl.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
        const error = requestUrl.searchParams.get('error');
        if (error) throw new Error(`Google authorization failed: ${error}`);
        const code = requestUrl.searchParams.get('code');
        if (!code) throw new Error('Google authorization returned no code');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Unable to determine local callback port');
        const redirectUri = `http://127.0.0.1:${address.port}`;
        const refreshToken = await exchangeCode({ code, redirectUri, verifier, clientId, clientSecret });
        writeRefreshToken(envPath, refreshToken);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<h1>Gmail authorization complete</h1><p>You can close this tab and return to career-ops.</p>');
        resolve(true);
        server.close();
      } catch (error) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(error instanceof Error ? error.message : 'Authorization failed');
        reject(error);
        server.close();
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Unable to start local OAuth callback'));
      const redirectUri = `http://127.0.0.1:${address.port}`;
      const authUrl = new URL(AUTH_ENDPOINT);
      authUrl.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GMAIL_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        login_hint: TARGET_ACCOUNT,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      console.log(`Open this URL in Chrome Beta while signed into ${TARGET_ACCOUNT}:`);
      console.log(authUrl.toString());
      console.log('Waiting for Google authorization...');
    });
  });
  if (result) console.log(`Refresh token saved to ${envPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
