// Tests for the PayPal client and order helpers, using a fake fetch (no network needed).

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.PAYPAL_CLIENT_ID = 'test-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-secret';

const { getAccessToken, paypalRequest, PayPalError, _resetTokenCache } = await import('../server/paypal/client.js');
const { buildOrderBody, findApproveUrl, authorizeOrder, buildPayoutBody, extractVaultId, settleVaultedOrder, createOrder, waitForPayout } = await import('../server/paypal/orders.js');

function jsonResponse(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status });
}

beforeEach(() => {
  _resetTokenCache();
  mock.restoreAll();
});

test('getAccessToken sends Basic auth and caches the token', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.match(url, /\/v1\/oauth2\/token$/);
    assert.equal(opts.headers.Authorization, 'Basic ' + Buffer.from('test-id:test-secret').toString('base64'));
    return jsonResponse(200, { access_token: 'abc123', expires_in: 32400 });
  });

  assert.equal(await getAccessToken(), 'abc123');
  assert.equal(await getAccessToken(), 'abc123');
  assert.equal(fetchMock.mock.callCount(), 1, 'second call should use the cache');
});

test('getAccessToken throws a PayPalError on bad credentials', async () => {
  mock.method(globalThis, 'fetch', async () => jsonResponse(401, { error: 'invalid_client' }));
  await assert.rejects(getAccessToken(), (err) => err instanceof PayPalError && err.status === 401);
});

test('paypalRequest handles 204 No Content (e.g. void)', async () => {
  mock.method(globalThis, 'fetch', async (url) =>
    url.endsWith('/token') ? jsonResponse(200, { access_token: 't', expires_in: 3600 }) : new Response(null, { status: 204 }),
  );
  assert.deepEqual(await paypalRequest('POST', '/v2/payments/authorizations/X/void'), {});
});

test('paypalRequest surfaces the PayPal issue code', async () => {
  mock.method(globalThis, 'fetch', async (url) =>
    url.endsWith('/token')
      ? jsonResponse(200, { access_token: 't', expires_in: 3600 })
      : jsonResponse(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] }),
  );
  await assert.rejects(paypalRequest('POST', '/v2/checkout/orders/X/capture'), /ORDER_NOT_APPROVED/);
});

test('buildOrderBody sets intent, amount and payee', () => {
  const body = buildOrderBody({ intent: 'AUTHORIZE', amount: 600, payeeEmail: 'joe@example.com' });
  assert.equal(body.intent, 'AUTHORIZE');
  assert.equal(body.purchase_units[0].amount.value, '600.00');
  assert.equal(body.purchase_units[0].payee.email_address, 'joe@example.com');
  assert.equal(body.payment_source.paypal.experience_context.user_action, 'CONTINUE');
});

test('buildOrderBody rejects bad input', () => {
  assert.throws(() => buildOrderBody({ intent: 'PAY', amount: 10 }), /intent/);
  assert.throws(() => buildOrderBody({ intent: 'CAPTURE', amount: -5 }), /amount/);
  assert.throws(() => buildOrderBody({ intent: 'CAPTURE', amount: 'abc' }), /amount/);
});

test('findApproveUrl supports both link names PayPal uses', () => {
  assert.equal(findApproveUrl({ links: [{ rel: 'payer-action', href: 'https://a' }] }), 'https://a');
  assert.equal(findApproveUrl({ links: [{ rel: 'approve', href: 'https://b' }] }), 'https://b');
  assert.equal(findApproveUrl({ links: [] }), null);
});

test('authorizeOrder returns the authorization from the response', async () => {
  mock.method(globalThis, 'fetch', async (url) =>
    url.endsWith('/token')
      ? jsonResponse(200, { access_token: 't', expires_in: 3600 })
      : jsonResponse(201, { purchase_units: [{ payments: { authorizations: [{ id: 'AUTH1', status: 'CREATED' }] } }] }),
  );
  const { authorization } = await authorizeOrder('ORDER1');
  assert.equal(authorization.id, 'AUTH1');
});

test('buildOrderBody leaves out payee when none is given (hold goes to Kin-bill)', () => {
  const body = buildOrderBody({ intent: 'AUTHORIZE', amount: 150 });
  assert.equal(body.purchase_units[0].payee, undefined);
});

test('buildPayoutBody pays the receiver by email with a unique id', () => {
  const body = buildPayoutBody({ receiverEmail: 'joe@example.com', amount: 150, referenceId: 'ref-1' });
  assert.equal(body.items[0].receiver, 'joe@example.com');
  assert.equal(body.items[0].amount.value, '150.00');
  assert.equal(body.sender_batch_header.sender_batch_id, 'ref-1');
  assert.throws(() => buildPayoutBody({ amount: 10 }), /receiverEmail/);
});

test('buildOrderBody with vaultId pays with the saved PayPal and no approval page', () => {
  const body = buildOrderBody({ intent: 'CAPTURE', amount: 25, vaultId: 'VAULT1', payeeEmail: 'joe@example.com' });
  assert.deepEqual(body.payment_source, { paypal: { vault_id: 'VAULT1' } });
  assert.equal(body.purchase_units[0].payee.email_address, 'joe@example.com');
});

test('buildOrderBody with saveToVault asks PayPal to save Grace\'s PayPal', () => {
  const body = buildOrderBody({ intent: 'AUTHORIZE', amount: 1, saveToVault: true });
  assert.equal(body.payment_source.paypal.attributes.vault.store_in_vault, 'ON_SUCCESS');
  assert.equal(body.payment_source.paypal.attributes.vault.usage_type, 'MERCHANT');
});

test('extractVaultId reads the saved id from an order', () => {
  assert.equal(extractVaultId({ payment_source: { paypal: { attributes: { vault: { id: 'V9' } } } } }), 'V9');
  assert.equal(extractVaultId({}), null);
});

test('settleVaultedOrder uses PayPal\'s one-step result without extra calls', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('should not call PayPal'); });
  const order = { id: 'O1', intent: 'CAPTURE', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ status: 'COMPLETED' }] } }] };
  const { capture } = await settleVaultedOrder(order);
  assert.equal(capture.status, 'COMPLETED');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('settleVaultedOrder authorizes when PayPal did not finish the order', async () => {
  mock.method(globalThis, 'fetch', async (url) =>
    url.endsWith('/token')
      ? jsonResponse(200, { access_token: 't', expires_in: 3600 })
      : jsonResponse(201, { id: 'O2', purchase_units: [{ payments: { authorizations: [{ id: 'A2', status: 'CREATED' }] } }] }),
  );
  const { authorization } = await settleVaultedOrder({ id: 'O2', intent: 'AUTHORIZE', status: 'APPROVED', purchase_units: [{}] });
  assert.equal(authorization.id, 'A2');
});

test('createOrder always sends a PayPal-Request-Id, and reuses one when given', async () => {
  const seen = [];
  mock.method(globalThis, 'fetch', async (url, opts) => {
    if (url.endsWith('/token')) return jsonResponse(200, { access_token: 't', expires_in: 3600 });
    seen.push(opts.headers['PayPal-Request-Id']);
    return jsonResponse(201, { id: 'O3', status: 'COMPLETED', links: [] });
  });
  await createOrder({ intent: 'CAPTURE', amount: 25, vaultId: 'V1' });
  await createOrder({ intent: 'CAPTURE', amount: 25, vaultId: 'V1', requestId: 'pay-123' });
  assert.match(seen[0], /^[0-9a-f-]{36}$/);
  assert.equal(seen[1], 'pay-123');
});

test('waitForPayout keeps checking until PayPal reports SUCCESS', async () => {
  const statuses = ['PENDING', 'PROCESSING', 'SUCCESS'];
  mock.method(globalThis, 'fetch', async (url) =>
    url.endsWith('/token')
      ? jsonResponse(200, { access_token: 't', expires_in: 3600 })
      : jsonResponse(200, { batch_header: { batch_status: statuses.shift() } }),
  );
  const seen = [];
  const final = await waitForPayout('B1', { intervalMs: 1, onStatus: (s) => seen.push(s) });
  assert.equal(final, 'SUCCESS');
  assert.deepEqual(seen, ['PENDING', 'PROCESSING', 'SUCCESS']);
});
