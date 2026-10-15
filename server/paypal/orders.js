// PayPal orders: Orders v2, Payments v2 and Payouts v1 helpers.
// These are the only functions in the app that move money, or hold and release it.
// Every payment is made to Kin-bill's own account (no payee) and then forwarded with a payout.
// PayPal refuses to charge Grace's saved PayPal for another payee (BILLING_AGREEMENT_NOT_FOUND)
// and to void or capture a hold made out to another payee (PERMISSION_DENIED).

import { randomUUID } from 'node:crypto';
import { paypalRequest } from './client.js';

// ---------- Orders v2: create and finish orders ----------

// Fallback pages PayPal opens after the buyer approves or cancels in the browser.
// Only the spike scripts rely on them; the app passes its own returnUrl and cancelUrl.
const DEFAULT_RETURN_URL = 'https://example.com/kinbill/approved';
const DEFAULT_CANCEL_URL = 'https://example.com/kinbill/cancelled';

/**
 * Build the JSON body for POST /v2/checkout/orders. Exported so it can be unit-tested.
 * Without vaultId, the buyer must approve on PayPal's page before the order can be finished.
 * @param {object} options
 * @param {'CAPTURE'|'AUTHORIZE'} options.intent  CAPTURE pays now; AUTHORIZE holds the funds for a later decision
 * @param {number|string} options.amount  positive amount, sent with two decimals
 * @param {string} [options.payeeEmail]  pay someone other than Kin-bill (spike test A only)
 * @returns {object} the request body
 * @throws {Error} when intent or amount is invalid
 */
export function buildOrderBody({
  intent, amount, currency = 'USD', payeeEmail, description, returnUrl, cancelUrl,
  vaultId,       // pay with Grace's saved PayPal (no browser needed)
  saveToVault,   // first payment: ask PayPal to save Grace's PayPal for later
}) {
  if (!['CAPTURE', 'AUTHORIZE'].includes(intent)) {
    throw new Error(`intent must be CAPTURE or AUTHORIZE, got ${intent}`);
  }
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`amount must be a positive number, got ${amount}`);
  }

  const purchaseUnit = {
    amount: { currency_code: currency, value: value.toFixed(2) },
    description: description || 'Kin-bill payment',
  };
  // A payee other than Kin-bill. The app never sets it: holds or saved-PayPal charges made out
  // to another payee fail (see the file header), so the money is forwarded with a payout instead.
  if (payeeEmail) purchaseUnit.payee = { email_address: payeeEmail };

  // Saved PayPal: PayPal charges it directly, no approval page.
  if (vaultId) {
    return { intent, purchase_units: [purchaseUnit], payment_source: { paypal: { vault_id: vaultId } } };
  }

  // Approval in the browser. A hold is not a payment yet, so its button says Continue, not Pay Now.
  const paypal = {
    experience_context: {
      brand_name: 'Kin-bill',
      user_action: intent === 'CAPTURE' ? 'PAY_NOW' : 'CONTINUE',
      shipping_preference: 'NO_SHIPPING',
      return_url: returnUrl || DEFAULT_RETURN_URL,
      cancel_url: cancelUrl || DEFAULT_CANCEL_URL,
    },
  };
  // Save Grace's PayPal once she approves. usage_type MERCHANT lets Kin-bill charge it later with no screens.
  if (saveToVault) {
    paypal.attributes = {
      vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' },
    };
  }
  return { intent, purchase_units: [purchaseUnit], payment_source: { paypal } };
}

/**
 * Read the saved PayPal id (vault id) from an order created with saveToVault.
 * PayPal fills it in once the order is authorized or captured.
 * @param {object} order  a PayPal order
 * @returns {string|null} the vault id, or null if PayPal has not returned one
 */
export function extractVaultId(order) {
  return order?.payment_source?.paypal?.attributes?.vault?.id || null;
}

/**
 * Finish an order paid with a saved PayPal and return its capture or authorization.
 * PayPal often completes these in the create call (status COMPLETED). If it did not, this calls
 * POST /v2/checkout/orders/{id}/capture or /authorize.
 * @param {object} order  the order returned by createOrder with a vaultId
 * @returns {Promise<{order: object, capture?: object, authorization?: object}>}
 */
export async function settleVaultedOrder(order) {
  // A function, not a value: it must read the payments of `order` after it is replaced below.
  const pu = () => order.purchase_units?.[0]?.payments || {};
  if (order.intent === 'CAPTURE') {
    if (!pu().captures) order = await captureOrder(order.id);
    return { order, capture: pu().captures?.[0] };
  }
  if (!pu().authorizations) order = (await authorizeOrder(order.id)).order;
  return { order, authorization: pu().authorizations?.[0] };
}

/**
 * Create a PayPal order (POST /v2/checkout/orders) and return it with its approval link.
 * @param {object} options  the buildOrderBody options, plus requestId
 * @param {string} [options.requestId]  unique id per payment, sent as PayPal-Request-Id.
 *   Pass the same requestId when retrying the same payment.
 * @returns {Promise<{order: object, approveUrl: string|null}>} approveUrl is null when PayPal returns no approval link
 */
export async function createOrder({ requestId, ...options }) {
  const order = await paypalRequest('POST', '/v2/checkout/orders', {
    body: buildOrderBody(options),
    // return=representation sends back the full order, so payments and the vault id can be read at once.
    // PayPal-Request-Id is required when charging a saved PayPal, and makes a request sent twice
    // (e.g. after a network glitch) charge only once.
    headers: {
      Prefer: 'return=representation',
      'PayPal-Request-Id': requestId || randomUUID(),
    },
  });
  return { order, approveUrl: findApproveUrl(order) };
}

/**
 * Find the link where the buyer approves the order on PayPal.
 * Orders with payment_source.paypal call it 'payer-action'; older-style orders call it 'approve'.
 * @param {object} order  a PayPal order
 * @returns {string|null} the URL, or null if the order has none
 */
export function findApproveUrl(order) {
  const link = (order.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return link ? link.href : null;
}

/**
 * Fetch an order (GET /v2/checkout/orders/{id}).
 * @param {string} orderId
 * @returns {Promise<object>} the order
 */
export function getOrder(orderId) {
  return paypalRequest('GET', `/v2/checkout/orders/${orderId}`);
}

/**
 * Pay now: capture an approved CAPTURE order (POST /v2/checkout/orders/{id}/capture).
 * @param {string} orderId
 * @returns {Promise<object>} the full order, with the capture in purchase_units[0].payments.captures
 */
export function captureOrder(orderId) {
  return paypalRequest('POST', `/v2/checkout/orders/${orderId}/capture`, {
    headers: { Prefer: 'return=representation' },
  });
}

/**
 * Hold the funds: authorize an approved AUTHORIZE order (POST /v2/checkout/orders/{id}/authorize).
 * @param {string} orderId
 * @returns {Promise<{order: object, authorization: object}>} the order and its first authorization
 */
export async function authorizeOrder(orderId) {
  const order = await paypalRequest('POST', `/v2/checkout/orders/${orderId}/authorize`, {
    headers: { Prefer: 'return=representation' },
  });
  const authorization = order.purchase_units?.[0]?.payments?.authorizations?.[0];
  return { order, authorization };
}

// ---------- Payments v2: capture or void a hold ----------
// Both only work on Kin-bill's own holds; a hold made out to another payee gives PERMISSION_DENIED.

/**
 * David approved: take the held money (POST /v2/payments/authorizations/{id}/capture).
 * @param {string} authorizationId
 * @returns {Promise<object>} the capture
 */
export function captureAuthorization(authorizationId) {
  return paypalRequest('POST', `/v2/payments/authorizations/${authorizationId}/capture`, {
    body: {}, // no amount: capture the full held amount
    headers: { Prefer: 'return=representation' },
  });
}

/**
 * David rejected, or time ran out: release the hold. No money moves.
 * Calls POST /v2/payments/authorizations/{id}/void.
 * @param {string} authorizationId
 * @returns {Promise<object>} {} because PayPal replies 204 No Content
 */
export function voidAuthorization(authorizationId) {
  return paypalRequest('POST', `/v2/payments/authorizations/${authorizationId}/void`);
}

/**
 * Fetch an authorization to check its status, e.g. CREATED, CAPTURED or VOIDED.
 * Calls GET /v2/payments/authorizations/{id}.
 * @param {string} authorizationId
 * @returns {Promise<object>} the authorization
 */
export function getAuthorization(authorizationId) {
  return paypalRequest('GET', `/v2/payments/authorizations/${authorizationId}`);
}

// ---------- Payouts v1: forward money to the real payee ----------
// Every payment first lands in Kin-bill's own account (see the file header). Low-risk payments
// are forwarded straight away; held ones after David approves and the hold is captured.

/**
 * Build the JSON body for POST /v1/payments/payouts: one email payout to the real payee.
 * Exported so it can be unit-tested.
 * @param {object} options
 * @param {string} options.receiverEmail  the real payee's PayPal email
 * @param {number|string} options.amount  positive amount, sent with two decimals
 * @param {string} [options.note]  message the payee sees
 * @param {string} [options.referenceId]  unique id for this payout; reuse it on a retry so PayPal never pays twice
 * @returns {object} the request body
 * @throws {Error} when receiverEmail or amount is invalid
 */
export function buildPayoutBody({ receiverEmail, amount, currency = 'USD', note, referenceId }) {
  const value = Number(amount);
  if (!receiverEmail) throw new Error('receiverEmail is required');
  if (!Number.isFinite(value) || value <= 0) throw new Error(`amount must be a positive number, got ${amount}`);
  // The fallback id is new on every call, so it cannot stop a retry; the app always passes referenceId.
  const id = referenceId || `kinbill-${Date.now()}`;
  return {
    sender_batch_header: {
      sender_batch_id: id, // must be unique; PayPal uses it to block accidental double payouts
      email_subject: 'You received a payment via Kin-bill',
    },
    items: [
      {
        recipient_type: 'EMAIL',
        receiver: receiverEmail,
        amount: { value: value.toFixed(2), currency },
        note: note || 'Payment sent with Kin-bill',
        sender_item_id: id,
      },
    ],
  };
}

/**
 * Send money from Kin-bill's account to the real payee (POST /v1/payments/payouts).
 * PayPal accepts the batch at once and finishes it later; see waitForPayout.
 * @param {object} options  the buildPayoutBody options
 * @returns {Promise<{batchId: string, status: string}>} the payout batch id and its first status
 */
export async function sendPayout(options) {
  const res = await paypalRequest('POST', '/v1/payments/payouts', { body: buildPayoutBody(options) });
  return { batchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status };
}

/**
 * Fetch a payout batch (GET /v1/payments/payouts/{batchId}).
 * @param {string} batchId
 * @returns {Promise<object>} the batch; its status is in batch_header.batch_status
 */
export function getPayout(batchId) {
  return paypalRequest('GET', `/v1/payments/payouts/${batchId}`);
}

/**
 * Check a payout batch every few seconds until it finishes or the time limit passes.
 * Sandbox payouts take about 1-2 minutes to reach SUCCESS, hence the 3-minute default.
 * @param {string} batchId
 * @param {object} [options]
 * @param {number} [options.intervalMs=5000]   time between checks
 * @param {number} [options.timeoutMs=180000]  stop checking after this long
 * @param {(status: string) => void} [options.onStatus]  called with every status seen
 * @returns {Promise<string>} SUCCESS, DENIED or CANCELED, or the last status seen if time ran out
 */
export async function waitForPayout(batchId, { intervalMs = 5000, timeoutMs = 180000, onStatus } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = (await getPayout(batchId)).batch_header.batch_status;
    onStatus?.(status);
    if (['SUCCESS', 'DENIED', 'CANCELED'].includes(status) || Date.now() >= deadline) return status;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
