// Verifies that a webhook really came from PayPal, by asking PayPal to check its signature.
// Docs: POST /v1/notifications/verify-webhook-signature

import { paypalRequest } from './client.js';

export async function verifyWebhook({ headers, event, webhookId }) {
  if (!webhookId) return false;
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
  if (!body.transmission_id || !body.transmission_sig) return false;
  const res = await paypalRequest('POST', '/v1/notifications/verify-webhook-signature', { body });
  return res.verification_status === 'SUCCESS';
}
