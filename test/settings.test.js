// Grace's safety rules: she can make them stricter herself; only David can loosen them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { openDb, getSettings, listAudit } from '../server/db.js';
import { createPaymentService } from '../server/payments/service.js';
import { loosenedSettings, describeRules, careLabel, DEFAULT_SETTINGS } from '../server/rules/engine.js';

// ---- the plain rules ----

test('stricter changes are allowed, looser ones are spotted', () => {
  const now = DEFAULT_SETTINGS; // limit 100, threshold 40, ask about new people
  assert.deepEqual(loosenedSettings(now, { perPaymentLimit: 50 }), []);
  assert.deepEqual(loosenedSettings(now, { riskThreshold: 25 }), []);
  assert.deepEqual(loosenedSettings(now, { askForNewPayees: true }), []);
  assert.deepEqual(loosenedSettings(now, { perPaymentLimit: 100 }), [], 'the same value is not looser');
  assert.deepEqual(loosenedSettings(now, { perPaymentLimit: 500 }), ['perPaymentLimit']);
  assert.deepEqual(loosenedSettings(now, { riskThreshold: 60 }), ['riskThreshold']);
  assert.deepEqual(loosenedSettings(now, { askForNewPayees: false }), ['askForNewPayees']);
  assert.deepEqual(loosenedSettings(now, { perPaymentLimit: 20, riskThreshold: 80 }), ['riskThreshold'], 'one looser change is enough to block');
});

test('rules are described in plain words', () => {
  const lines = describeRules({ perPaymentLimit: 75, riskThreshold: 25, askForNewPayees: true }, { helperName: 'David', holdTime: '2 minutes' });
  assert.match(lines[0], /over 75 dollars wait for David/);
  assert.match(lines[1], /someone new waits for David/);
  assert.match(lines[2], /Very careful/);
  assert.match(lines.at(-1), /2 minutes/);
  assert.equal(careLabel(40), 'Careful');
  assert.equal(careLabel(60), 'Relaxed');
});

// ---- through the web API ----

async function withApp(fn) {
  const db = openDb(':memory:');
  const service = createPaymentService({ db, holdTimeoutSeconds: 120 });
  const server = createApp({ db, service, helperPin: '2468', webhookId: '' }).listen(0);
  const base = `http://localhost:${server.address().port}`;
  const post = (path, body, pin) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(pin ? { 'x-helper-pin': pin } : {}) },
    body: JSON.stringify(body),
  });
  try { await fn({ base, post, db }); } finally { server.close(); }
}

test('Grace can see her rules', async () => {
  await withApp(async ({ base }) => {
    const r = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(r.settings.perPaymentLimit, 100);
    assert.equal(r.careLevel, 'Careful');
    assert.match(r.summary.at(-1), /2 minutes/);
  });
});

test('Grace can make her rules stricter', async () => {
  await withApp(async ({ post, db }) => {
    const res = await post('/api/settings', { perPaymentLimit: 50, riskThreshold: 25 });
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.changed, true);
    assert.match(r.spoken, /over 50 dollars/);
    assert.equal(getSettings(db).perPaymentLimit, 50);
    assert.equal(getSettings(db).riskThreshold, 25);
    assert.equal(listAudit(db)[0].action, 'RULES_CHANGED');
  });
});

test('Grace cannot loosen her rules; David is told she tried', async () => {
  await withApp(async ({ post, db }) => {
    const res = await post('/api/settings', { perPaymentLimit: 2000 });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'NEEDS_HELPER');
    assert.match(body.error, /Only David/);
    assert.equal(getSettings(db).perPaymentLimit, 100, 'nothing changed');
    const log = listAudit(db)[0];
    assert.equal(log.action, 'RULES_BLOCKED');
    assert.match(log.detail, /\$100 -> \$2000/);

    assert.equal((await post('/api/settings', { askForNewPayees: false })).status, 403);
    assert.equal(getSettings(db).askForNewPayees, true);
  });
});

test('David can change any rule, but only with his PIN', async () => {
  await withApp(async ({ post, db }) => {
    assert.equal((await post('/api/helper/settings', { perPaymentLimit: 300 })).status, 401);
    assert.equal((await post('/api/helper/settings', { perPaymentLimit: 300 }, '0000')).status, 401);
    const res = await post('/api/helper/settings', { perPaymentLimit: 300, riskThreshold: 60, askForNewPayees: false }, '2468');
    assert.equal(res.status, 200);
    assert.deepEqual(getSettings(db), { perPaymentLimit: 300, riskThreshold: 60, askForNewPayees: false });
    const log = listAudit(db)[0];
    assert.equal(log.actor, 'david');
    assert.match(log.detail, /David changed the rules/);
  });
});

test('wrong values are refused with a clear message', async () => {
  await withApp(async ({ post, db }) => {
    for (const bad of [{ perPaymentLimit: -5 }, { perPaymentLimit: 'lots' }, { riskThreshold: 150 }, { perPaymentLimit: 50000 }, {}]) {
      const res = await post('/api/helper/settings', bad, '2468');
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal((await res.json()).code, 'BAD_SETTING');
    }
    assert.deepEqual(getSettings(db), DEFAULT_SETTINGS);
  });
});

test('new rules are used for the next payment check', async () => {
  const db = openDb(':memory:');
  const service = createPaymentService({ db });
  service.updateRules({ perPaymentLimit: 30 }, { by: 'grace' });
  assert.equal(getSettings(db).perPaymentLimit, 30);
  // the payment flow reads getSettings(db) every time, so a $40 payment now waits for David
  const { decide } = await import('../server/rules/engine.js');
  assert.equal(decide({ amount: 40, riskScore: 0, knownPayee: true, settings: getSettings(db) }).decision, 'ASK_HELPER');
});
