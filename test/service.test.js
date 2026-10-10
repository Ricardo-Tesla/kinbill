// Tests for the payment flow, with a fake PayPal and a fake AI (no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, seedDemoContacts, setAccountValue, getPayment, getContact, findContactByName, getVaultId, listContacts } from '../server/db.js';
import { createPaymentService } from '../server/payments/service.js';

// A fake AI that returns whatever the test wants.
function fakeAnalyze(result) {
  return async (text) => ({
    intent: { payee_name: 'Joe', payee_email: null, amount: 80, currency: 'USD', note: text },
    risk_score: 5, flagged_triggers: [], spoken_summary: 'Paying Joe.', helper_explanation: 'Normal.', source: 'gemini',
    ...result,
    intent: { payee_name: 'Joe', payee_email: null, amount: 80, currency: 'USD', note: text, ...(result?.intent || {}) },
  });
}

// A fake PayPal that records every call.
function fakePayPal({ failCharge = false, failPayout = false, payoutStatus = 'SUCCESS' } = {}) {
  const calls = [];
  return {
    calls,
    async createOrder(o) {
      calls.push(['createOrder', o]);
      if (failCharge) throw new Error('INSTRUMENT_DECLINED');
      if (o.saveToVault) return { order: { id: 'LINK1' }, approveUrl: 'https://sandbox.paypal.com/approve' };
      return { order: { id: `O-${o.intent}`, intent: o.intent } };
    },
    async settleVaultedOrder(order) {
      calls.push(['settle', order.id]);
      return order.intent === 'CAPTURE'
        ? { order, capture: { id: 'CAP1', status: 'COMPLETED' } }
        : { order, authorization: { id: 'AUTH1', status: 'CREATED' } };
    },
    async sendPayout(o) {
      calls.push(['payout', o]);
      if (failPayout) throw new Error('payout error');
      return { batchId: 'BATCH1', status: 'PENDING' };
    },
    async waitForPayout() { calls.push(['waitPayout']); return payoutStatus; },
    async authorizeOrder(id) { calls.push(['authorize', id]); return { order: { id, payment_source: { paypal: { attributes: { vault: { id: 'VAULT9' } } } } }, authorization: { id: 'A-LINK' } }; },
    extractVaultId(order) { return order?.payment_source?.paypal?.attributes?.vault?.id || null; },
    async getOrder() { return {}; },
    async voidAuthorization(id) { calls.push(['void', id]); },
    async captureAuthorization(id) { calls.push(['captureAuth', id]); return { id: 'CAP-HELD', status: 'COMPLETED' }; },
  };
}

function setup({ ai, paypal = fakePayPal(), linked = true } = {}) {
  const db = openDb(':memory:');
  seedDemoContacts(db, 'joe@example.com');
  if (linked) setAccountValue(db, 'vault_id', 'VAULT1');
  const service = createPaymentService({ db, paypal, analyze: fakeAnalyze(ai), log: { error() {} } });
  return { db, service, paypal };
}

test('normal payment to Joe: read back, then charged to Kin-bill and paid out to Joe', async () => {
  const { db, service, paypal } = setup();
  const r = await service.createRequest('Pay my plumber Joe 80 dollars');
  assert.equal(r.spoken, 'You want to pay Joe the plumber 80 dollars. Is that right?');
  assert.equal(r.payment.status, 'AWAITING_CONFIRMATION');
  assert.equal(r.payment.decision, 'PAY_NOW');
  assert.equal(paypal.calls.length, 0, 'nothing charged before Grace says yes');

  const c = await service.confirm(r.payment.id);
  assert.equal(c.payment.status, 'PAYING');
  assert.equal(c.spoken, 'Done. 80 dollars is on its way to Joe the plumber.');
  const order = paypal.calls.find(([n]) => n === 'createOrder')[1];
  assert.equal(order.intent, 'CAPTURE');
  assert.equal(order.vaultId, 'VAULT1');
  assert.equal(order.requestId, `kinbill-pay-${r.payment.id}`);
  assert.equal(order.payeeEmail, undefined, 'charged to Kin-bill, not directly to Joe');
  assert.equal(paypal.calls.find(([n]) => n === 'payout')[1].receiverEmail, 'joe@example.com');

  await service.idle();
  assert.equal(getPayment(db, r.payment.id).status, 'PAID');
  assert.equal(findContactByName(db, 'Joe').times_paid, 2);
});

test('scam: the money is only held, never paid out', async () => {
  const { db, service, paypal } = setup({
    ai: { intent: { payee_name: 'PayPal', amount: 600 }, risk_score: 95, flagged_triggers: ['IMPERSONATION', 'URGENCY'], spoken_summary: 'I have paused this and will ask David to check it first.' },
  });
  const r = await service.createRequest('A man from PayPal says my account is locked, send 600 today');
  assert.equal(r.payment.decision, 'ASK_HELPER');
  assert.equal(r.payment.inContacts, false);
  assert.match(r.payment.reasons[0], /not in Grace's contacts/);
  assert.equal(r.payment.graceReasons[0], 'PayPal is not in your contacts.');

  const c = await service.confirm(r.payment.id);
  assert.equal(c.payment.status, 'HELD');
  assert.equal(c.spoken, 'I have paused this and will ask David to check it first. The main reason: PayPal is not in your contacts.');
  assert.equal(paypal.calls.find(([n]) => n === 'createOrder')[1].intent, 'AUTHORIZE');
  assert.equal(paypal.calls.some(([n]) => n === 'payout'), false);
  const saved = getPayment(db, r.payment.id);
  assert.equal(saved.authorization_id, 'AUTH1');
  assert.ok(new Date(saved.hold_expires_at) > new Date());
});

test('first payment to Sam (new person) is held for David', async () => {
  const { service } = setup({ ai: { intent: { payee_name: 'Sam', amount: 40 } } });
  const r = await service.createRequest('Pay Sam the gardener 40 dollars');
  assert.equal(r.payment.payeeName, 'Sam the gardener');
  assert.equal(r.payment.decision, 'ASK_HELPER');
  const c = await service.confirm(r.payment.id);
  assert.equal(c.payment.status, 'HELD');
  assert.match(c.spoken, /asked David to check it first. No money has been sent. The main reason: You have not paid Sam the gardener before./);
  assert.deepEqual(c.payment.graceReasons, ['You have not paid Sam the gardener before.']);
});

test('Grace says no: nothing is charged', async () => {
  const { service, paypal } = setup();
  const r = await service.createRequest('Pay Joe 80 dollars');
  const c = service.cancel(r.payment.id);
  assert.equal(c.payment.status, 'CANCELLED');
  assert.equal(paypal.calls.length, 0);
  await assert.rejects(service.confirm(r.payment.id), /already handled/);
});

test('unclear amount asks Grace to repeat', async () => {
  const { service } = setup({ ai: { intent: { amount: null } } });
  const r = await service.createRequest('Pay Joe');
  assert.equal(r.needsRetry, true);
  assert.match(r.spoken, /did not catch how much/);
});

test('cannot pay before PayPal is connected', async () => {
  const { service } = setup({ linked: false });
  const r = await service.createRequest('Pay Joe 80 dollars');
  await assert.rejects(service.confirm(r.payment.id), (e) => e.code === 'NOT_LINKED');
});

test('a PayPal error means FAILED and Grace is told nothing was sent', async () => {
  const { service } = setup({ paypal: fakePayPal({ failCharge: true }) });
  const r = await service.createRequest('Pay Joe 80 dollars');
  const c = await service.confirm(r.payment.id);
  assert.equal(c.payment.status, 'FAILED');
  assert.match(c.spoken, /no money was sent/);
});

test('a failed payout is recorded so David can help', async () => {
  const { service } = setup({ paypal: fakePayPal({ failPayout: true }) });
  const r = await service.createRequest('Pay Joe 80 dollars');
  const c = await service.confirm(r.payment.id);
  assert.equal(c.payment.status, 'PAYOUT_FAILED');
});

test('connecting PayPal saves the link and releases the $1 check', async () => {
  const { db, service, paypal } = setup({ linked: false });
  const { approveUrl } = await service.startLink();
  assert.match(approveUrl, /paypal/);
  assert.equal(paypal.calls[0][1].saveToVault, true);
  assert.match(paypal.calls[0][1].returnUrl, /\/api\/link\/return$/);
  await service.finishLink('LINK1');
  assert.equal(getVaultId(db), 'VAULT9');
  assert.ok(paypal.calls.some(([n, id]) => n === 'void' && id === 'A-LINK'));
});

test('an older database gets the new column added automatically', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = (await import('node:path')).join(os.tmpdir(), `kinbill-old-${Date.now()}.db`);
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, said TEXT NOT NULL, payee_name TEXT NOT NULL, contact_id INTEGER, amount REAL NOT NULL, risk_score INTEGER, triggers TEXT, ai_source TEXT, spoken_summary TEXT, helper_explanation TEXT, decision TEXT NOT NULL, reasons TEXT, status TEXT NOT NULL, order_id TEXT, authorization_id TEXT, capture_id TEXT, payout_batch_id TEXT, hold_expires_at TEXT, error TEXT)');
  old.close();
  const db = openDb(path);
  const cols = db.prepare('PRAGMA table_info(payments)').all().map((c) => c.name);
  assert.ok(cols.includes('grace_reasons'));
  db.close();
  fs.rmSync(path, { force: true });
});

// ---- David's decisions ----

async function heldPayment(ai) {
  const ctx = setup({ ai });
  const r = await ctx.service.createRequest('test');
  await ctx.service.confirm(r.payment.id);
  return { ...ctx, id: r.payment.id };
}

test('David approves a held payment to Sam: held money is taken, then paid out to Sam', async () => {
  const { db, service, paypal, id } = await heldPayment({ intent: { payee_name: 'Sam', amount: 40 } });
  const changes = [];
  service.events.on('change', (e) => changes.push(e.status));
  const r = await service.approve(id);
  assert.equal(r.payment.status, 'PAYING');
  assert.equal(r.payment.decidedBy, 'helper');
  assert.ok(paypal.calls.some(([n, a]) => n === 'captureAuth' && a === 'AUTH1'));
  assert.equal(paypal.calls.find(([n]) => n === 'payout')[1].receiverEmail, 'joe@example.com');
  await service.idle();
  assert.equal(getPayment(db, id).status, 'PAID');
  assert.equal(findContactByName(db, 'Sam').times_paid, 1, 'Sam is now known');
  assert.ok(changes.includes('PAYING') && changes.includes('PAID'), 'screens are told about changes');
});

test('David rejects: the hold is cancelled and nothing is paid out', async () => {
  const { service, paypal, id } = await heldPayment({ intent: { payee_name: 'PayPal', amount: 600 }, risk_score: 95 });
  const r = await service.reject(id);
  assert.equal(r.payment.status, 'REJECTED');
  assert.ok(paypal.calls.some(([n, a]) => n === 'void' && a === 'AUTH1'));
  assert.equal(paypal.calls.some(([n]) => n === 'payout'), false);
  await assert.rejects(service.approve(id), (e) => e.code === 'NOT_HELD', 'cannot approve after rejecting');
});

test('approving someone not in contacts needs their PayPal email, then adds them', async () => {
  const { db, service, paypal, id } = await heldPayment({ intent: { payee_name: 'Bob', amount: 30 } });
  await assert.rejects(service.approve(id), (e) => e.code === 'EMAIL_REQUIRED');
  await assert.rejects(service.approve(id, { email: 'not-an-email' }), (e) => e.code === 'EMAIL_REQUIRED');
  const r = await service.approve(id, { email: 'Bob@Example.com' });
  assert.equal(r.payment.payeeName, 'Bob');
  assert.equal(r.payment.inContacts, true);
  assert.ok(listContacts(db).some((c) => c.name === 'Bob' && c.email === 'bob@example.com'));
  assert.equal(paypal.calls.find(([n]) => n === 'payout')[1].receiverEmail, 'bob@example.com');
});

test('only HELD payments can be decided', async () => {
  const { service } = setup();
  const r = await service.createRequest('Pay Joe 80 dollars');
  await assert.rejects(service.reject(r.payment.id), (e) => e.code === 'NOT_HELD');
});

test('helper overview lists waiting payments separately from history', async () => {
  const { service, id } = await heldPayment({ intent: { payee_name: 'Sam', amount: 40 } });
  const o = service.helperOverview();
  assert.deepEqual(o.held.map((p) => p.id), [id]);
  assert.ok(o.history.some((p) => p.id === id));
});
