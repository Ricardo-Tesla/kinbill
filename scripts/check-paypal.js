// Run with:  npm run check:paypal
// Confirms your sandbox Client ID and Secret work.

import { getAccessToken } from '../server/paypal/client.js';

try {
  const token = await getAccessToken();
  console.log('SUCCESS: connected to PayPal sandbox. Token starts with:', token.slice(0, 12) + '...');
} catch (err) {
  console.error('FAILED:', err.message);
  if (err.details) console.error(JSON.stringify(err.details, null, 2));
  console.error('Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in your .env file.');
  process.exit(1);
}
