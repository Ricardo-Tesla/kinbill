// Reads settings from environment variables (loaded from .env by Node's --env-file flag).
// Keeping all config in one place makes it easy to see what the app needs.

export const config = {
  port: Number(process.env.PORT) || 3000,
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    apiBase: process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
  },
  payeeJoeEmail: process.env.PAYEE_JOE_EMAIL || '',
  holdTimeoutSeconds: Number(process.env.HOLD_TIMEOUT_SECONDS) || 172800,
  // Where the app is reachable; PayPal sends Grace back here after connecting her PayPal.
  // On Render, RENDER_EXTERNAL_URL is set automatically (e.g. https://kinbill.onrender.com).
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${Number(process.env.PORT) || 3000}`).replace(/\/$/, ''),
  // Grace's saved PayPal link. Online hosts like Render's free plan wipe the database on restart,
  // so the link can also be given here and is restored on every start (sandbox only).
  vaultId: process.env.KINBILL_VAULT_ID || '',
  // KINBILL_DEMO=1 fills an empty database with a few example payments so David's tables aren't empty.
  demo: process.env.KINBILL_DEMO === '1',
  userName: process.env.KINBILL_USER_NAME || 'Grace',
  helperName: process.env.KINBILL_HELPER_NAME || 'David',
  // PIN David types on his screen before he can see or approve payments. Empty = no PIN (not recommended).
  helperPin: process.env.HELPER_PIN || '',
  // From developer.paypal.com > your app > Webhooks (only needed once Kin-bill is online, feature 10).
  webhookId: process.env.PAYPAL_WEBHOOK_ID || '',
  // How often the safety timer checks for holds whose time is up.
  sweepIntervalSeconds: Number(process.env.SWEEP_INTERVAL_SECONDS) || 30,
};

// Safety net: refuse to run against live PayPal by accident.
if (!config.paypal.apiBase.includes('sandbox')) {
  throw new Error('Kin-bill only runs against the PayPal SANDBOX. Check PAYPAL_API_BASE in .env.');
}

export function isPayPalConfigured() {
  return Boolean(config.paypal.clientId && config.paypal.clientSecret);
}
