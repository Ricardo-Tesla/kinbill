// Check PayPal: confirms that the sandbox Client ID and Secret in .env work.
// Run with:  npm run check:paypal
// It only asks PayPal for an OAuth2 token; no money moves.
// Success prints "SUCCESS" and the start of the token. Failure prints PayPal's error and exits with code 1.

import { getAccessToken } from '../server/paypal/client.js';

try {
  const token = await getAccessToken();
  // Print only the start of the token, so the full secret never ends up in logs.
  console.log('SUCCESS: connected to PayPal sandbox. Token starts with:', token.slice(0, 12) + '...');
} catch (err) {
  console.error('FAILED:', err.message);
  if (err.details) console.error(JSON.stringify(err.details, null, 2));
  console.error('Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in your .env file.');
  process.exit(1);
}
