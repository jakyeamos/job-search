// @ts-check

/**
 * Small Gmail REST client shared by the alert organizer and the ingest plugin.
 * It deliberately keeps OAuth/account verification in one place so a token
 * for another signed-in account cannot silently feed the job queue.
 */

export const TARGET_GMAIL_ACCOUNT = 'jakyejobs@gmail.com';
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const GMAIL_SETTINGS_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.basic';
export const GMAIL_REQUIRED_SCOPES = [GMAIL_MODIFY_SCOPE, GMAIL_SETTINGS_SCOPE];

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SETTINGS_ROOT = `${API_ROOT}/settings`;

export class GmailClientError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status) {
    super(message);
    this.name = 'GmailClientError';
    this.status = status;
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {(input: string, init?: RequestInit) => Promise<Response>} fetchFn
 * @returns {Promise<string>}
 */
export async function getAccessToken(env, fetchFn = globalThis.fetch) {
  const clientId = env.GMAIL_CLIENT_ID;
  const clientSecret = env.GMAIL_CLIENT_SECRET;
  const refreshToken = env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new GmailClientError('missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN');
  }

  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await response.text();
  let payload = /** @type {Record<string, unknown>} */ ({});
  try { payload = JSON.parse(body); } catch { /* handled by the error below */ }
  if (!response.ok) {
    const detail = typeof payload.error_description === 'string'
      ? payload.error_description
      : `HTTP ${response.status}`;
    throw new GmailClientError(`Gmail token refresh failed: ${detail}`, response.status);
  }
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new GmailClientError('Gmail token refresh returned no access token');
  }
  return payload.access_token;
}

/** @param {string} value */
function normalizeEmail(value) {
  return value.trim().toLowerCase();
}

/**
 * @param {{ env?: Record<string, string | undefined>, fetchFn?: (input: string, init?: RequestInit) => Promise<Response>, expectedAccount?: string }} [options]
 * @returns {Promise<{
 *  getProfile: () => Promise<Record<string, unknown>>,
 *  verifyAccount: () => Promise<string>,
 *  listLabels: () => Promise<Array<Record<string, unknown>>>,
 *  createLabel: (name: string) => Promise<Record<string, unknown>>,
 *  listFilters: () => Promise<Array<Record<string, unknown>>>,
 *  createFilter: (filter: Record<string, unknown>) => Promise<Record<string, unknown>>,
 *  deleteFilter: (id: string) => Promise<void>,
 *  listMessages: (query: string, options?: { limit?: number }) => Promise<Array<{ id: string, threadId?: string }>>,
 *  getMessage: (id: string, format?: string) => Promise<Record<string, unknown>>,
 *  modifyMessage: (id: string, addLabelIds?: string[], removeLabelIds?: string[]) => Promise<Record<string, unknown>>
 * }>}
 */
export async function createGmailClient(options = {}) {
  const env = options.env || process.env;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const expectedAccount = options.expectedAccount || TARGET_GMAIL_ACCOUNT;
  const token = await getAccessToken(env, fetchFn);
  const headers = { Authorization: `Bearer ${token}` };

  /**
   * @param {string} url
   * @param {{ method?: string, body?: Record<string, unknown> }} [requestOptions]
   * @returns {Promise<Record<string, unknown>>}
   */
  async function request(url, requestOptions = {}) {
    const init = {
      method: requestOptions.method || 'GET',
      headers: requestOptions.body
        ? { ...headers, 'Content-Type': 'application/json' }
        : headers,
      ...(requestOptions.body ? { body: JSON.stringify(requestOptions.body) } : {}),
    };
    const response = await fetchFn(url, init);
    const text = await response.text();
    let payload = /** @type {Record<string, unknown>} */ ({});
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 240) }; }
    }
    if (!response.ok) {
      const error = payload.error;
      const message = error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : typeof payload.error_description === 'string'
          ? payload.error_description
          : `HTTP ${response.status}`;
      throw new GmailClientError(`Gmail API request failed: ${message}`, response.status);
    }
    return payload;
  }

  async function getProfile() {
    return request(`${API_ROOT}/profile`);
  }

  async function verifyAccount() {
    const profile = await getProfile();
    const actual = typeof profile.emailAddress === 'string' ? profile.emailAddress : '';
    if (!actual || normalizeEmail(actual) !== normalizeEmail(expectedAccount)) {
      throw new GmailClientError(
        `Gmail account mismatch: expected ${expectedAccount}, received ${actual || '(unknown account)'}`,
      );
    }
    return actual;
  }

  async function listLabels() {
    const payload = await request(`${API_ROOT}/labels`);
    return Array.isArray(payload.labels)
      ? payload.labels.filter((label) => label && typeof label === 'object')
      : [];
  }

  async function createLabel(name) {
    return request(`${API_ROOT}/labels`, {
      method: 'POST',
      body: {
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    });
  }

  async function listFilters() {
    const payload = await request(`${SETTINGS_ROOT}/filters`);
    return Array.isArray(payload.filter)
      ? payload.filter.filter((filter) => filter && typeof filter === 'object')
      : [];
  }

  async function createFilter(filter) {
    return request(`${SETTINGS_ROOT}/filters`, { method: 'POST', body: filter });
  }

  async function deleteFilter(id) {
    await request(`${SETTINGS_ROOT}/filters/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async function listMessages(query, { limit = 200 } = {}) {
    const messages = [];
    let pageToken = '';
    while (messages.length < limit) {
      const params = new URLSearchParams({
        q: query,
        maxResults: String(Math.min(100, limit - messages.length)),
      });
      if (pageToken) params.set('pageToken', pageToken);
      const payload = await request(`${API_ROOT}/messages?${params.toString()}`);
      if (Array.isArray(payload.messages)) {
        for (const message of payload.messages) {
          if (message && typeof message.id === 'string') messages.push(message);
          if (messages.length >= limit) break;
        }
      }
      pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : '';
      if (!pageToken || !Array.isArray(payload.messages) || payload.messages.length === 0) break;
    }
    return messages;
  }

  async function getMessage(id, format = 'full') {
    const params = new URLSearchParams({ format });
    return request(`${API_ROOT}/messages/${encodeURIComponent(id)}?${params.toString()}`);
  }

  async function modifyMessage(id, addLabelIds = [], removeLabelIds = []) {
    return request(`${API_ROOT}/messages/${encodeURIComponent(id)}/modify`, {
      method: 'POST',
      body: { addLabelIds, removeLabelIds },
    });
  }

  return {
    getProfile,
    verifyAccount,
    listLabels,
    createLabel,
    listFilters,
    createFilter,
    deleteFilter,
    listMessages,
    getMessage,
    modifyMessage,
  };
}
