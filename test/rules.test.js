// Tests for Grace's rules and the database. No network needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, describeTriggers, DEFAULT_SETTINGS } from '../server/rules/engine.js';
import { openDb, getSettings, saveSettings, addContact, findContactByName, isKnownContact, recordPaymentToContact, getContact, seedDemoContacts, listContacts } from '../server/db.js';

const safe = { riskScore: 5, triggers: [], knownPayee: true };

test('small, low-risk payment to someone Grace knows is paid now', () => {
  assert.deepEqual(decide({ ...safe, amount: 80 }), { decision: 'PAY_NOW', reasons: [], graceReasons: [] });
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

test('Grace gets gentle reasons in "you" wording, one for each of David\'s reasons', () => {
  const r = decide({ amount: 600, riskScore: 92, triggers: ['GIFT_CARD', 'SECRECY'], knownPayee: false, payeeName: 'Bob' });
  assert.equal(r.graceReasons.length, r.reasons.length);
  assert.ok(r.graceReasons.includes('You have not paid Bob before.'));
  assert.ok(r.graceReasons.includes('It is more than your limit of $100.00.'));
  assert.ok(r.graceReasons.includes('Real companies and family members rarely ask for gift cards.'));
  assert.ok(r.graceReasons.every((t) => !/scam/i.test(t)), 'never says "scam" to Grace');
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

test('contacts: matching spoken names and becoming known after a payment', () => {
  const db = openDb(':memory:');
  const joe = addContact(db, { name: 'Joe the plumber', email: 'Joe@Example.com' });
  addContact(db, { name: 'Sam the gardener', email: 'sam@example.com' });
  assert.equal(findContactByName(db, 'Joe').id, joe.id);
  assert.equal(findContactByName(db, 'joe the plumber').id, joe.id);
  assert.equal(findContactByName(db, 'the plumber').id, joe.id);
  assert.equal(findContactByName(db, 'Sam').name, 'Sam the gardener');
  assert.equal(findContactByName(db, 'PayPal'), null);
  assert.equal(findContactByName(db, 'Grandson'), null);
  assert.equal(isKnownContact(joe), false);
  recordPaymentToContact(db, joe.id);
  assert.equal(isKnownContact(getContact(db, joe.id)), true);
  assert.equal(getContact(db, joe.id).email, 'joe@example.com');
});

test('demo contacts are added once', () => {
  const db = openDb(':memory:');
  seedDemoContacts(db, 'joe@example.com');
  seedDemoContacts(db, 'joe@example.com');
  assert.deepEqual(listContacts(db).map((c) => [c.name, c.times_paid]), [['Joe the plumber', 1], ['Sam the gardener', 0]]);
});

test('online: the saved PayPal link can come from KINBILL_VAULT_ID, and demo mode adds example history once', async () => {
  const { importVaultFromEnv, getVaultId, seedDemoHistory, listPayments, listAudit } = await import('../server/db.js');
  const db = openDb(':memory:');
  assert.equal(importVaultFromEnv(db, ''), false);
  assert.equal(importVaultFromEnv(db, 'vault-123'), true);
  assert.equal(getVaultId(db), 'vault-123');
  assert.equal(importVaultFromEnv(db, 'other'), false, 'an existing link is kept');

  assert.equal(seedDemoHistory(db), true);
  assert.equal(seedDemoHistory(db), false, 'only into an empty database');
  const statuses = listPayments(db, { limit: 10 }).map((p) => p.status).sort();
  assert.deepEqual(statuses, ['EXPIRED', 'PAID', 'REJECTED']);
  assert.ok(listAudit(db).every((a) => a.detail.endsWith('(example)')));
});
