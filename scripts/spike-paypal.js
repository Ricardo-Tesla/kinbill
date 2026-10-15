// PayPal spike (feature 2): proves in the sandbox the money paths Kin-bill depends on.
// Run with:  npm run spike         (all tests)
//      or:   npm run spike -- B    (start from test B)
// Needs PAYEE_JOE_EMAIL in .env. Success: every test shows PASS under "Results".
//
//   Test A: CAPTURE straight to Joe          -> low-risk payment, paid now
//   Test B: AUTHORIZE to Kin-bill -> VOID    -> David rejects, no money moves
//   Test C: AUTHORIZE to Kin-bill -> CAPTURE -> PAYOUT to Joe  -> David approves
//
// Why B and C hold the money in Kin-bill's own account: PayPal only lets our app
// void or capture holds that belong to our account (holds made out to Joe gave
// PERMISSION_DENIED). So Kin-bill acts as a safety box for risky payments.
// Test A needs a browser approval. The app pays low-risk payments to Kin-bill too and forwards
// them with a payout, because a saved PayPal cannot be charged for Joe (see spike-vault.js).
//
// For each test the script prints a link. Open it, log in as your sandbox buyer (Grace),
// approve, then come back here and press Enter. The example.com page you land on
// afterwards looks broken; that is expected.

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config } from '../server/config.js';
import {
  createOrder,
  captureOrder,
  authorizeOrder,
  captureAuthorization,
  voidAuthorization,
  getAuthorization,
  sendPayout,
  getPayout,
} from '../server/paypal/orders.js';

const rl = readline.createInterface({ input, output });
const joeEmail = config.payeeJoeEmail;
const startFrom = (process.argv[2] || 'A').toUpperCase();

if (!joeEmail) {
  console.error('Set PAYEE_JOE_EMAIL in .env (your second sandbox BUSINESS account).');
  process.exit(1);
}

// Pause between payout status checks.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Print the PayPal approval link and wait until the tester has approved it as Grace.
 * @param {string} approveUrl  link returned by createOrder
 * @returns {Promise<void>}
 */
async function waitForApproval(approveUrl) {
  console.log('\n  1) Open this link and approve as the sandbox buyer (Grace):');
  console.log('     ' + approveUrl);
  await rl.question('  2) After approving, press Enter here... ');
}

// One line describing a capture: status, amount and id.
function summarizeCapture(capture) {
  return `${capture.status} | ${capture.amount.value} ${capture.amount.currency_code} | capture id ${capture.id}`;
}

// ---------- Tests ----------

/**
 * Test A: create a CAPTURE order made out to Joe, approve it, then capture it.
 * @returns {Promise<boolean>} true when the capture is COMPLETED
 */
async function testA() {
  console.log('\n=== Test A: pay Joe $80 now (CAPTURE straight to Joe) ===');
  const { order, approveUrl } = await createOrder({
    intent: 'CAPTURE', amount: 80, payeeEmail: joeEmail, description: 'Plumbing repair (Kin-bill test A)',
  });
  await waitForApproval(approveUrl);
  const result = await captureOrder(order.id);
  const capture = result.purchase_units[0].payments.captures[0];
  console.log('  Captured:', summarizeCapture(capture));
  console.log('  Paid to: ', result.purchase_units[0].payee?.email_address);
  return capture.status === 'COMPLETED';
}

/**
 * Test B: hold $600 in Kin-bill's account, then void the hold, as when David rejects.
 * @returns {Promise<boolean>} true when the authorization ends up VOIDED
 */
async function testB() {
  console.log('\n=== Test B: hold $600 in Kin-bill, then VOID (David rejects) ===');
  // No payeeEmail: the hold belongs to Kin-bill's own account.
  const { order, approveUrl } = await createOrder({
    intent: 'AUTHORIZE', amount: 600, description: 'Held for review (Kin-bill test B)',
  });
  await waitForApproval(approveUrl);
  const { authorization } = await authorizeOrder(order.id);
  console.log('  Held:      ', authorization.status, '| authorization id', authorization.id, '| expires', authorization.expiration_time);
  await voidAuthorization(authorization.id);
  const after = await getAuthorization(authorization.id);
  console.log('  After void:', after.status, '(no money moved)');
  return after.status === 'VOIDED';
}

/**
 * Test C: hold $150 in Kin-bill's account, capture it, then pay Joe with a payout, as when David approves.
 * @returns {Promise<boolean>} true when the capture is COMPLETED and the payout reaches SUCCESS
 */
async function testC() {
  console.log('\n=== Test C: hold $150 in Kin-bill, CAPTURE, then PAYOUT to Joe (David approves) ===');
  const { order, approveUrl } = await createOrder({
    intent: 'AUTHORIZE', amount: 150, description: 'Held for review (Kin-bill test C)',
  });
  await waitForApproval(approveUrl);
  const { authorization } = await authorizeOrder(order.id);
  console.log('  Held:    ', authorization.status, '| authorization id', authorization.id);

  const capture = await captureAuthorization(authorization.id);
  console.log('  Captured:', summarizeCapture(capture));

  // The payout id is tied to the hold, so the same hold can never be paid out twice.
  const payout = await sendPayout({
    receiverEmail: joeEmail, amount: 150, note: 'New roofer, approved by David (Kin-bill test C)',
    referenceId: `kinbill-test-c-${authorization.id}`,
  });
  console.log('  Payout sent to Joe: batch', payout.batchId, '| status', payout.status);

  // Sandbox payouts take about 1-2 minutes; check every 5 s for up to 3 minutes.
  let status = payout.status;
  for (let i = 0; i < 36 && !['SUCCESS', 'DENIED', 'CANCELED'].includes(status); i++) {
    await sleep(5000);
    status = (await getPayout(payout.batchId)).batch_header.batch_status;
    console.log('  Payout status:', status);
  }
  return capture.status === 'COMPLETED' && status === 'SUCCESS';
}

// ---------- Run ----------

// Skip the tests before the letter given on the command line.
const tests = [
  ['A', 'A: capture now (straight to Joe)', testA],
  ['B', 'B: hold in Kin-bill, then void', testB],
  ['C', 'C: hold, capture, payout to Joe', testC],
].filter(([letter]) => letter >= startFrom);

// Stop at the first error; the tests that finished are still listed under Results.
const results = {};
try {
  for (const [, name, fn] of tests) results[name] = await fn();
} catch (err) {
  console.error('\nFAILED:', err.message);
  if (err.details) console.error(JSON.stringify(err.details, null, 2));
} finally {
  rl.close();
}

console.log('\n=== Results ===');
for (const [name, ok] of Object.entries(results)) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
