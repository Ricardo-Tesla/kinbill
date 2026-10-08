// Starts the app on a random port and checks the health endpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

test('GET /api/health returns ok', async () => {
  const server = createApp().listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://localhost:${port}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.app, 'kinbill');
    assert.equal(typeof body.paypalConfigured, 'boolean');
  } finally {
    server.close();
  }
});
