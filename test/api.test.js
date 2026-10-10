// Tests the web API routes with a fake payment service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { openDb, seedDemoContacts } from '../server/db.js';
import { PaymentError } from '../server/payments/service.js';

async function withServer(service, fn) {
  const db = openDb(':memory:');
  seedDemoContacts(db, 'joe@example.com');
  const server = createApp({ db, service }).listen(0);
  const base = `http://localhost:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const fakeService = {
  async createRequest(text) { return { payment: { id: 1, said: text }, spoken: 'Is that right?' }; },
  async confirm(id) { if (id === 99) throw new PaymentError('Not connected', 'NOT_LINKED', 409); return { payment: { id, status: 'PAYING' } }; },
  cancel(id) { return { payment: { id, status: 'CANCELLED' } }; },
  get(id) { return { id, status: 'PAID' }; },
  async startLink() { return { approveUrl: 'https://paypal.example/approve' }; },
  async finishLink() { return { linked: true }; },
};

test('status lists the demo contacts and whether PayPal is linked', async () => {
  await withServer(fakeService, async (base) => {
    const s = await (await fetch(`${base}/api/status`)).json();
    assert.equal(s.userName, 'Grace');
    assert.equal(s.paypalLinked, false);
    assert.deepEqual(s.contacts.map((c) => c.name), ['Joe the plumber', 'Sam the gardener']);
  });
});

test('payment routes call the service and pass errors back clearly', async () => {
  await withServer(fakeService, async (base) => {
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    assert.equal((await (await post('/api/requests', { text: 'Pay Joe 80' })).json()).payment.said, 'Pay Joe 80');
    assert.equal((await (await post('/api/requests/1/confirm')).json()).payment.status, 'PAYING');
    assert.equal((await (await post('/api/requests/1/cancel')).json()).payment.status, 'CANCELLED');
    assert.equal((await (await fetch(`${base}/api/requests/1`)).json()).status, 'PAID');
    const err = await post('/api/requests/99/confirm');
    assert.equal(err.status, 409);
    assert.equal((await err.json()).code, 'NOT_LINKED');
  });
});

test('Grace\'s page is served', async () => {
  await withServer(fakeService, async (base) => {
    const html = await (await fetch(`${base}/grace.html`)).text();
    assert.match(html, /Tap and speak/);
  });
});

test('PayPal return link finishes connecting and goes back to Grace\'s screen', async () => {
  await withServer(fakeService, async (base) => {
    const res = await fetch(`${base}/api/link/return?token=LINK1`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/grace.html?link=done');
  });
});
