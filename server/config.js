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
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${Number(process.env.PORT) || 3000}`).replace(/\/$/, ''),
  userName: process.env.KINBILL_USER_NAME || 'Grace',
  helperName: process.env.KINBILL_HELPER_NAME || 'David',
};

// Safety net: refuse to run against live PayPal by accident.
if (!config.paypal.apiBase.includes('sandbox')) {
  throw new Error('Kin-bill only runs against the PayPal SANDBOX. Check PAYPAL_API_BASE in .env.');
}

export function isPayPalConfigured() {
  return Boolean(config.paypal.clientId && config.paypal.clientSecret);
}
