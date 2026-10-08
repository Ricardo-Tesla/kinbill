// PayPal Orders v2 + Payments v2 helpers.
// These are the only places in the app that move money (or hold / release it).

import { paypalRequest } from './client.js';

// Where PayPal sends the buyer after they approve in the browser.
// For the spike this can be any URL; the app will use its own pages later.
const DEFAULT_RETURN_URL = 'https://example.com/kinbill/approved';
const DEFAULT_CANCEL_URL = 'https://example.com/kinbill/cancelled';

/**
 * Build the JSON body for "create order". Exported so it can be unit-tested.
 * intent: 'CAPTURE' (pay now) or 'AUTHORIZE' (hold funds, decide later)
 */
export function buildOrderBody({ intent, amount, currency = 'USD', payeeEmail, description, returnUrl, cancelUrl }) {
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
  // The person who receives the money (e.g. Joe the plumber), if different from our app account.
  if (payeeEmail) purchaseUnit.payee = { email_address: payeeEmail };

  return {
    intent,
    purchase_units: [purchaseUnit],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Kin-bill',
          user_action: intent === 'CAPTURE' ? 'PAY_NOW' : 'CONTINUE',
          shipping_preference: 'NO_SHIPPING',
          return_url: returnUrl || DEFAULT_RETURN_URL,
          cancel_url: cancelUrl || DEFAULT_CANCEL_URL,
        },
      },
    },
  };
}

export async function createOrder(options) {
  const order = await paypalRequest('POST', '/v2/checkout/orders', {
    body: buildOrderBody(options),
    headers: { Prefer: 'return=representation' },
  });
  return { order, approveUrl: findApproveUrl(order) };
}

export function findApproveUrl(order) {
  const link = (order.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return link ? link.href : null;
}

export function getOrder(orderId) {
  return paypalRequest('GET', `/v2/checkout/orders/${orderId}`);
}

// Pay now (for intent CAPTURE, after the buyer approved).
export function captureOrder(orderId) {
  return paypalRequest('POST', `/v2/checkout/orders/${orderId}/capture`, {
    headers: { Prefer: 'return=representation' },
  });
}

// Hold the funds (for intent AUTHORIZE, after the buyer approved).
export async function authorizeOrder(orderId) {
  const order = await paypalRequest('POST', `/v2/checkout/orders/${orderId}/authorize`, {
    headers: { Prefer: 'return=representation' },
  });
  const authorization = order.purchase_units?.[0]?.payments?.authorizations?.[0];
  return { order, authorization };
}

// David approved: take the held money.
export function captureAuthorization(authorizationId) {
  return paypalRequest('POST', `/v2/payments/authorizations/${authorizationId}/capture`, {
    body: {},
    headers: { Prefer: 'return=representation' },
  });
}

// David rejected (or time ran out): release the hold. No money moves.
export function voidAuthorization(authorizationId) {
  return paypalRequest('POST', `/v2/payments/authorizations/${authorizationId}/void`);
}

export function getAuthorization(authorizationId) {
  return paypalRequest('GET', `/v2/payments/authorizations/${authorizationId}`);
}

// --- Payouts: forward money from Kin-bill's own account to the real payee ---
// Why: PayPal only lets our app void/capture holds that belong to OUR account.
// So risky payments are held by Kin-bill; when David approves, we capture and
// then pay the money out to Joe.

export function buildPayoutBody({ receiverEmail, amount, currency = 'USD', note, referenceId }) {
  const value = Number(amount);
  if (!receiverEmail) throw new Error('receiverEmail is required');
  if (!Number.isFinite(value) || value <= 0) throw new Error(`amount must be a positive number, got ${amount}`);
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

export async function sendPayout(options) {
  const res = await paypalRequest('POST', '/v1/payments/payouts', { body: buildPayoutBody(options) });
  return { batchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status };
}

export function getPayout(batchId) {
  return paypalRequest('GET', `/v1/payments/payouts/${batchId}`);
}
