// Vault spike (feature 3): proves Grace links her PayPal once and later payments need no browser.
// Run with:  npm run spike:vault          (all tests)
//      or:   npm run spike:vault -- V2    (start from V2, reuses the saved link)
// Needs PAYEE_JOE_EMAIL in .env for V2. Success: every test shows PASS under "Results".
//
//   V1: link PayPal  -> Grace approves a $1 hold in the browser, PayPal saves her PayPal,
//                       then we release the $1 (nothing is charged)
//   V2: pay Joe $25 with the saved PayPal: CAPTURE to Kin-bill, then PAYOUT to Joe, no browser
//       (charging the saved PayPal directly for Joe fails with BILLING_AGREEMENT_NOT_FOUND:
//        Grace's saved PayPal is an agreement with Kin-bill, not with Joe)
//   V3: hold $300 in Kin-bill with the saved PayPal, AUTHORIZE, no browser, then void
//
// The saved id is written to .kinbill-vault.json (gitignored) so V2 and V3 can be rerun.

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config } from '../server/config.js';
import {
  createOrder,
  authorizeOrder,
  voidAuthorization,
  getAuthorization,
  getOrder,
  extractVaultId,
  settleVaultedOrder,
  sendPayout,
  waitForPayout,
} from '../server/paypal/orders.js';

const VAULT_FILE = '.kinbill-vault.json';
const rl = readline.createInterface({ input, output });
const joeEmail = config.payeeJoeEmail;
const startFrom = (process.argv[2] || 'V1').toUpperCase();

// Read the saved PayPal id from VAULT_FILE; null if the file is missing or unreadable.
function loadVaultId() {
  try { return JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')).vaultId; } catch { return null; }
}

// ---------- Tests ----------

/**
 * V1: link Grace's PayPal with a $1 hold she approves in the browser, then release the hold.
 * Saves the vault id to VAULT_FILE for V2 and V3.
 * @returns {Promise<boolean>} true when PayPal returned a vault id
 */
async function v1LinkPayPal() {
  console.log('\n=== V1: link Grace\'s PayPal once ($1 hold, released right after) ===');
  const { order, approveUrl } = await createOrder({
    intent: 'AUTHORIZE', amount: 1, saveToVault: true, description: 'Link PayPal to Kin-bill (released, not charged)',
  });
  console.log('\n  1) Open this link and approve as the sandbox buyer (Grace):');
  console.log('     ' + approveUrl);
  await rl.question('  2) After approving, press Enter here... ');

  const { order: authorized, authorization } = await authorizeOrder(order.id);
  // The vault id is not always in the authorize reply, so fetch the order as a fallback.
  let vaultId = extractVaultId(authorized) || extractVaultId(await getOrder(order.id));
  console.log('  Saved PayPal id:', vaultId || '(none returned)');

  // The $1 hold only existed so Grace could approve the link; release it straight away.
  await voidAuthorization(authorization.id);
  console.log('  $1 hold released:', (await getAuthorization(authorization.id)).status);

  if (!vaultId) return false;
  fs.writeFileSync(VAULT_FILE, JSON.stringify({ vaultId, savedAt: new Date().toISOString() }, null, 2));
  console.log(`  Stored in ${VAULT_FILE}`);
  return true;
}

/**
 * V2: charge the saved PayPal $25 to Kin-bill with no browser, then forward it to Joe with a payout.
 * @param {string} vaultId  Grace's saved PayPal id
 * @returns {Promise<boolean>} true when the charge is COMPLETED and the payout reaches SUCCESS
 */
async function v2PayJoe(vaultId) {
  console.log('\n=== V2: pay Joe $25 with the saved PayPal, via Kin-bill (no browser) ===');
  // No payeeEmail: a saved PayPal can only be charged for Kin-bill (see the file header).
  // createOrder adds the PayPal-Request-Id header that PayPal requires for vault_id orders.
  const { order } = await createOrder({
    intent: 'CAPTURE', amount: 25, vaultId, description: 'Garden help for Joe (Kin-bill test V2)',
  });
  const { capture } = await settleVaultedOrder(order);
  console.log('  Charged to Kin-bill:', capture?.status, '|', capture?.amount?.value, capture?.amount?.currency_code);
  if (capture?.status !== 'COMPLETED') return false;

  // The payout id is tied to the capture, so the same charge can never be paid out twice.
  const payout = await sendPayout({
    receiverEmail: joeEmail, amount: 25, note: 'Garden help (Kin-bill test V2)', referenceId: `kinbill-v2-${capture.id}`,
  });
  console.log('  Payout to Joe: batch', payout.batchId, '| waiting for PayPal (can take 1-2 minutes)...');
  const status = await waitForPayout(payout.batchId, { onStatus: (st) => console.log('  Payout status:', st) });
  return status === 'SUCCESS';
}

/**
 * V3: hold $300 in Kin-bill's account with the saved PayPal and no browser, then void the hold.
 * @param {string} vaultId  Grace's saved PayPal id
 * @returns {Promise<boolean>} true when the authorization ends up VOIDED
 */
async function v3HoldInKinbill(vaultId) {
  console.log('\n=== V3: hold $300 in Kin-bill with the saved PayPal, then void (no browser) ===');
  const { order } = await createOrder({
    intent: 'AUTHORIZE', amount: 300, vaultId, description: 'Held for review (Kin-bill test V3)',
  });
  const { authorization } = await settleVaultedOrder(order);
  console.log('  Held:      ', authorization?.status, '| authorization id', authorization?.id);
  await voidAuthorization(authorization.id);
  const after = await getAuthorization(authorization.id);
  console.log('  After void:', after.status);
  return after.status === 'VOIDED';
}

// ---------- Run ----------

// V2 and V3 use the id saved by V1, in this run or an earlier one.
// startFrom is compared as text, which works because the names sort in order (V1 < V2 < V3).
const results = {};
try {
  if (startFrom === 'V1') results['V1: link PayPal once'] = await v1LinkPayPal();
  const vaultId = loadVaultId();
  if (!vaultId) throw new Error(`No saved PayPal id found in ${VAULT_FILE}. Run V1 first.`);
  if (startFrom <= 'V2') results['V2: pay Joe, no browser'] = await v2PayJoe(vaultId);
  results['V3: hold in Kin-bill, no browser'] = await v3HoldInKinbill(vaultId);
} catch (err) {
  console.error('\nFAILED:', err.message);
  if (err.details) console.error(JSON.stringify(err.details, null, 2));
} finally {
  rl.close();
}

console.log('\n=== Results ===');
for (const [name, ok] of Object.entries(results)) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
