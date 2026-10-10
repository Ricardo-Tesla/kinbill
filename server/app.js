// Builds the Express app: web pages (public/) and the JSON API used by them.
// Kept separate from index.js so tests can use it without opening a port.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, isPayPalConfigured } from './config.js';
import { getAccessToken } from './paypal/client.js';
import { openDb, getVaultId, listContacts } from './db.js';
import { createPaymentService, PaymentError } from './payments/service.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// AG Grid (sponsor table library) is served from our own server, no CDN needed.
const AG_GRID_DIR = path.join(ROOT, 'node_modules', 'ag-grid-community', 'dist');

export function createApp({
  db = openDb(':memory:'),
  service = createPaymentService({ db }),
  helperPin = config.helperPin,
} = {}) {
  const app = express();
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(PUBLIC_DIR));
  app.use('/vendor/ag-grid', express.static(AG_GRID_DIR));

  // Wraps async routes so errors become clear JSON answers.
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      const status = err instanceof PaymentError ? err.httpStatus : 500;
      if (status === 500) console.error(err);
      res.status(status).json({ error: err.message, code: err.code || 'SERVER_ERROR' });
    }
  };

  // ---- Health ----

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', app: 'kinbill', paypalConfigured: isPayPalConfigured() });
  });

  app.get('/api/health/paypal', async (req, res) => {
    try {
      await getAccessToken({ forceRefresh: true });
      res.json({ paypal: 'connected' });
    } catch (err) {
      res.status(502).json({ paypal: 'error', message: err.message });
    }
  });

  // ---- What Grace's screen needs to know on load ----

  app.get('/api/status', (req, res) => {
    res.json({
      userName: config.userName,
      helperName: config.helperName,
      paypalLinked: Boolean(getVaultId(db)),
      aiProvider: (process.env.AI_PROVIDER || 'gemini').toLowerCase(),
      contacts: listContacts(db).map((c) => ({ name: c.name, paidBefore: c.times_paid > 0 })),
    });
  });

  // ---- Connect Grace's PayPal (one time) ----

  app.post('/api/link/start', handle(() => service.startLink()));

  // PayPal sends Grace back here after she approves.
  app.get('/api/link/return', async (req, res) => {
    try {
      await service.finishLink(String(req.query.token || ''));
      res.redirect('/grace.html?link=done');
    } catch (err) {
      console.error('Link failed:', err.message);
      res.redirect('/grace.html?link=failed');
    }
  });

  // ---- Payments ----

  app.post('/api/requests', handle((req) => service.createRequest(req.body?.text)));
  app.post('/api/requests/:id/confirm', handle((req) => service.confirm(Number(req.params.id))));
  app.post('/api/requests/:id/cancel', handle((req) => service.cancel(Number(req.params.id))));
  app.get('/api/requests/:id', handle((req) => service.get(Number(req.params.id))));

  // ---- David's helper screen (PIN protected) ----

  const requirePin = (req, res, next) => {
    const given = req.get('x-helper-pin') || req.query.pin || '';
    if (helperPin && given !== helperPin) {
      return res.status(401).json({ error: 'Wrong or missing helper PIN.', code: 'PIN_REQUIRED' });
    }
    next();
  };

  app.get('/api/helper/check', requirePin, (req, res) => res.json({ ok: true, helperName: config.helperName, userName: config.userName }));
  app.get('/api/helper/overview', requirePin, handle(() => service.helperOverview()));
  app.post('/api/helper/payments/:id/approve', requirePin,
    handle((req) => service.approve(Number(req.params.id), { email: req.body?.email })));
  app.post('/api/helper/payments/:id/reject', requirePin,
    handle((req) => service.reject(Number(req.params.id))));

  // Live updates: David's screen keeps this open and refreshes when a payment changes.
  app.get('/api/helper/events', requirePin, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();
    res.write('retry: 5000\n\n');
    const onChange = (e) => res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    service.events?.on('change', onChange);
    req.on('close', () => { clearInterval(ping); service.events?.off('change', onChange); });
  });

  return app;
}
