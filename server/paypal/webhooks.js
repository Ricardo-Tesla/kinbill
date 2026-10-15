// PayPal webhooks: checks that a webhook event really came from PayPal.
// Instead of checking the certificate here, Kin-bill asks PayPal to verify the signature
// with POST /v1/notifications/verify-webhook-signature.
// Used by POST /api/paypal/webhook in server/app.js before any event is trusted.

import { paypalRequest } from './client.js';

/**
 * Ask PayPal whether a webhook event is genuine (POST /v1/notifications/verify-webhook-signature).
 * @param {object} options
 * @param {object} options.headers    the request headers PayPal sent (paypal-transmission-id and others)
 * @param {object} options.event      the parsed event body
 * @param {string} options.webhookId  this app's webhook id from the PayPal developer dashboard (PAYPAL_WEBHOOK_ID)
 * @returns {Promise<boolean>} true only when PayPal answers SUCCESS
 */
export async function verifyWebhook({ headers, event, webhookId }) {
  // PayPal needs the webhook id to check the signature; without it, trust nothing.
  if (!webhookId) return false;
  // Read a header by name (Node gives incoming header names in lower case).
  const h = (name) => headers[name] || headers[name.toLowerCase()];
  const body = {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: webhookId,
    webhook_event: event,
  };
  // No signature headers means the request did not come from PayPal, so skip the API call.
  if (!body.transmission_id || !body.transmission_sig) return false;
  const res = await paypalRequest('POST', '/v1/notifications/verify-webhook-signature', { body });
  return res.verification_status === 'SUCCESS';
}
