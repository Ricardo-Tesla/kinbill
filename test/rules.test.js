// Tests for Grace's rules and the database. No network needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, describeTriggers, DEFAULT_SETTINGS } from '../server/rules/engine.js';
import { openDb, getSettings, saveSettings, isKnownPayee, recordPayment, listPayees } from '../server/db.js';

const safe = { riskScore: 5, triggers: [], knownPayee: true };

test('small, low-risk payment to someone Grace knows is paid now', () => {
  assert.deepEqual(decide({ ...safe, amount: 80 }), { decision: 'PAY_NOW', reasons: [] });
});

test('amount above Grace\'s limit asks David', () => {
  const r = decide({ ...safe, amount: 150 });
  assert.equal(r.decision, 'ASK_HELPER');
  assert.match(r.reasons.join(' '), /above Grace's limit of \$100/);
});

test('exactly the limit is still paid now', () => {
  assert.equal(decide({ ...safe, amount: 100 }).decision, 'PAY_NOW');
});

test('high AI risk score asks David, even for small amounts', () => {
  const r = decide({ ...safe, amount: 20, riskScore: 75 });
  assert.equal(r.decision, 'ASK_HELPER');
  assert.match(r.reasons[0], /75 out of 100/);
});

test('first payment to a new person asks David', () => {
  const r = decide({ ...safe, amount: 20, knownPayee: false });
  assert.equal(r.decision, 'ASK_HELPER');
  assert.match(r.reasons.join(' '), /not paid this person before/);
});

test('Grace can turn off the new-person rule', () => {
  const r = decide({ ...safe, amount: 20, knownPayee: false, settings: { askForNewPayees: false } });
  assert.equal(r.decision, 'PAY_NOW');
});

test('gift cards, impersonation, crypto and secrecy always ask David', () => {
  for (const flag of ['GIFT_CARD', 'IMPERSONATION', 'CRYPTO', 'secrecy', 'COACHED']) {
    const r = decide({ ...safe, amount: 10, riskScore: 0, triggers: [flag] });
    assert.equal(r.decision, 'ASK_HELPER', flag);
  }
});

test('scam phone call: several reasons are all listed for David', () => {
  const r = decide({ amount: 600, riskScore: 92, triggers: ['URGENCY', 'IMPERSONATION', 'NEW_PAYEE'], knownPayee: false });
  assert.equal(r.decision, 'ASK_HELPER');
  assert.equal(r.reasons.length, 4); // score, limit, new person, impersonation
});

test('fails safe: unclear amount or missing risk score asks David', () => {
  assert.equal(decide({ ...safe, amount: 'eighty' }).decision, 'ASK_HELPER');
  assert.equal(decide({ ...safe, amount: -5 }).decision, 'ASK_HELPER');
  assert.equal(decide({ amount: 20, knownPayee: true }).decision, 'ASK_HELPER');
  assert.equal(decide({ ...safe, amount: 20, riskScore: 400 }).decision, 'ASK_HELPER');
});

test('describeTriggers gives plain words for David', () => {
  assert.deepEqual(describeTriggers(['GIFT_CARD', 'URGENCY']), ['a request for gift cards', 'pressure to pay quickly']);
});

test('settings start with defaults and can be changed', () => {
  const db = openDb(':memory:');
  assert.deepEqual(getSettings(db), DEFAULT_SETTINGS);
  saveSettings(db, { perPaymentLimit: '250', somethingElse: 'ignored' });
  assert.equal(getSettings(db).perPaymentLimit, 250);
  assert.equal(getSettings(db).somethingElse, undefined);
  assert.throws(() => saveSettings(db, { perPaymentLimit: -1 }), /positive/);
  assert.throws(() => saveSettings(db, { riskThreshold: 150 }), /between/);
});

test('payees become known after a payment', () => {
  const db = openDb(':memory:');
  assert.equal(isKnownPayee(db, 'joe@example.com'), false);
  recordPayment(db, { email: 'Joe@Example.com', name: 'Joe the plumber' });
  recordPayment(db, { email: 'joe@example.com', name: 'Joe the plumber' });
  assert.equal(isKnownPayee(db, 'joe@example.com'), true);
  assert.equal(listPayees(db)[0].times_paid, 2);
});
