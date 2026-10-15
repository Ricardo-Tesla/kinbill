// PayPal client: small REST client used by every PayPal call in Kin-bill.
// getAccessToken() gets an OAuth2 token and reuses it until shortly before it expires.
// paypalRequest() calls any PayPal endpoint with that token and returns the parsed JSON,
// or throws a PayPalError that carries PayPal's error body.
// The API base comes from config.js, which refuses to run against anything but the sandbox.

import { config } from '../config.js';

let cachedToken = null; // { value, expiresAt }, shared by all requests in this process

/**
 * Error thrown when a PayPal call fails.
 * @param {string} message  readable summary, including PayPal's issue code when there is one
 * @param {number} status   HTTP status, or 0 when the request was never sent
 * @param {object} [details]  PayPal's error body
 */
export class PayPalError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.details = details; // PayPal's error body, useful for debugging
  }
}

/**
 * Get an OAuth2 access token (client credentials), reusing the cached one while it is valid.
 * Calls POST /v1/oauth2/token.
 * @param {object} [options]
 * @param {boolean} [options.forceRefresh=false]  skip the cache and ask PayPal for a new token
 * @returns {Promise<string>} the bearer token
 * @throws {PayPalError} when the credentials are missing or PayPal rejects them
 */
export async function getAccessToken({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.value;
  }

  const { clientId, clientSecret, apiBase } = config.paypal;
  if (!clientId || !clientSecret) {
    throw new PayPalError('PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is missing in .env', 0);
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  // An error reply may not be JSON; fall back to {} so the HTTP status is still reported.
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new PayPalError(`Could not get PayPal token (HTTP ${res.status})`, res.status, body);
  }

  // Refresh 60 seconds early so a token never expires mid-request.
  cachedToken = {
    value: body.access_token,
    expiresAt: now + (body.expires_in - 60) * 1000,
  };
  return cachedToken.value;
}

/**
 * Call a PayPal REST endpoint with a bearer token and return the parsed JSON reply.
 * @param {string} method  HTTP method, e.g. 'POST'
 * @param {string} path    path below the API base, e.g. '/v2/checkout/orders'
 * @param {object} [options]
 * @param {object} [options.body]     JSON request body
 * @param {object} [options.headers]  extra headers, e.g. Prefer or PayPal-Request-Id
 * @returns {Promise<object>} the reply body, or {} when PayPal sends none
 * @throws {PayPalError} on any non-2xx reply, with PayPal's issue code in the message
 */
export async function paypalRequest(method, path, { body, headers = {} } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${config.paypal.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Some PayPal calls (e.g. void) return 204 with no body.
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    // The specific reason (e.g. PERMISSION_DENIED) is in details[0].issue; otherwise use the error name.
    const issue = data?.details?.[0]?.issue || data?.name || 'UNKNOWN_ERROR';
    throw new PayPalError(`PayPal ${method} ${path} failed: ${issue}`, res.status, data);
  }
  return data;
}

// Clears the cached token so each test starts fresh. Only for tests.
export function _resetTokenCache() {
  cachedToken = null;
}
