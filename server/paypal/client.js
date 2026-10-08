// Small PayPal REST client.
// - getAccessToken(): gets an OAuth2 token and reuses it until shortly before it expires.
// - paypalRequest(): calls any PayPal endpoint with that token and returns parsed JSON.

import { config } from '../config.js';

let cachedToken = null; // { value, expiresAt }

export class PayPalError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.details = details; // PayPal's error body, useful for debugging
  }
}

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
    const issue = data?.details?.[0]?.issue || data?.name || 'UNKNOWN_ERROR';
    throw new PayPalError(`PayPal ${method} ${path} failed: ${issue}`, res.status, data);
  }
  return data;
}

// Only for tests.
export function _resetTokenCache() {
  cachedToken = null;
}
