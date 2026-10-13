// Builds the Express app: web pages (public/) and the JSON API used by them.
// Kept separate from index.js so tests can use it without opening a port.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, isPayPalConfigured } from './config.js';
import { getAccessToken } from './paypal/client.js';
import { openDb, getVaultId, listContacts } from './db.js';
import { createPaymentService, PaymentError } from './payments/service.js';
import { verifyWebhook as verifyWithPayPal } from './paypal/webhooks.js';
import { rateLimit, createCounter } from './rateLimit.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// AG Grid (sponsor table library) is served from our own server, no CDN needed.
const AG_GRID_DIR = path.join(ROOT, 'node_modules', 'ag-grid-community', 'dist');
// Atkinson Hyperlegible fonts (Braille Institute, made for low vision), also served by us.
const FONT_DIR = path.join(ROOT, 'node_modules', '@fontsource-variable', 'atkinson-hyperlegible-next', 'files');
const MONO_FONT_DIR = path.join(ROOT, 'node_modules', '@fontsource', 'atkinson-hyperlegible-mono', 'files');

export function createApp({
  db = openDb(':memory:'),
  service = createPaymentService({ db }),
  helperPin = config.helperPin,
  webhookId = config.webhookId,
  verifyWebhook = verifyWithPayPal,
  limits = { requestsPerMinute: 20, pinFailuresPer15Min: 10 },
} = {}) {
  const app = express();
  app.set('trust proxy', 1);          // behind Render's proxy: req.ip is the visitor's address
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(PUBLIC_DIR));
  app.use('/vendor/ag-grid', express.static(AG_GRID_DIR));
  app.use('/vendor/fonts', express.static(FONT_DIR, { maxAge: '30d', immutable: true }));
  app.use('/vendor/fonts-mono', express.static(MONO_FONT_DIR, { maxAge: '30d', immutable: true }));

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

  // ---- Grace's safety rules: she can make them stricter, only David can loosen them ----

  app.get('/api/settings', handle(() => service.getRules()));
  app.post('/api/settings', handle((req) => service.updateRules(req.body || {}, { by: 'grace' })));

  // ---- Payments ----

  // New payment requests use the AI, so one visitor can make at most a few per minute.
  const requestLimit = rateLimit({ windowMs: 60e3, max: limits.requestsPerMinute,
    message: 'That was a lot of requests. Please wait a minute and try again.' });
  app.post('/api/requests', requestLimit, handle((req) => service.createRequest(req.body?.text)));
  app.post('/api/requests/:id/confirm', handle((req) => service.confirm(Number(req.params.id))));
  app.post('/api/requests/:id/cancel', handle((req) => service.cancel(Number(req.params.id))));
  app.get('/api/requests/:id', handle((req) => service.get(Number(req.params.id))));

  // ---- David's helper screen (PIN protected) ----

  // Wrong PINs are counted per visitor: after too many, that visitor has to wait (stops PIN guessing).
  const pinFailures = createCounter({ windowMs: 15 * 60e3, max: limits.pinFailuresPer15Min });
  const requirePin = (req, res, next) => {
    if (helperPin && pinFailures.blocked(req.ip)) {
      res.set('Retry-After', String(pinFailures.retryAfterSeconds(req.ip)));
      return res.status(429).json({ error: 'Too many wrong PINs. Please wait 15 minutes and try again.', code: 'RATE_LIMITED' });
    }
    const given = req.get('x-helper-pin') || req.query.pin || '';
    if (helperPin && given !== helperPin) {
      if (given) pinFailures.hit(req.ip);   // an empty PIN (first visit) does not count
      return res.status(401).json({ error: 'Wrong or missing helper PIN.', code: 'PIN_REQUIRED' });
    }
    next();
  };

  app.get('/api/helper/check', requirePin, (req, res) => res.json({ ok: true, helperName: config.helperName, userName: config.userName }));
  app.get('/api/helper/overview', requirePin, handle(() => service.helperOverview()));
  app.get('/api/helper/activity', requirePin, handle((req) => service.activity({ paymentId: Number(req.query.payment) || undefined })));
  app.post('/api/helper/payments/:id/approve', requirePin,
    handle((req) => service.approve(Number(req.params.id), { email: req.body?.email })));
  app.post('/api/helper/payments/:id/reject', requirePin,
    handle((req) => service.reject(Number(req.params.id))));
  app.post('/api/helper/settings', requirePin, handle((req) => service.updateRules(req.body || {}, { by: 'helper' })));

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

  // ---- PayPal webhooks: PayPal tells us when a payout lands, a hold is voided, etc. ----
  // Every event is verified with PayPal before we trust it.
  app.post('/api/paypal/webhook', async (req, res) => {
    if (!webhookId) return res.status(503).json({ error: 'PAYPAL_WEBHOOK_ID is not set.' });
    try {
      const ok = await verifyWebhook({ headers: req.headers, event: req.body, webhookId });
      if (!ok) return res.status(400).json({ error: 'Signature check failed.' });
      const result = await service.handleWebhookEvent(req.body);
      res.json({ received: true, ...result });
    } catch (err) {
      console.error('Webhook error:', err.message);
      res.status(500).json({ error: 'Could not process the event.' }); // PayPal will retry
    }
  });

  return app;
}
