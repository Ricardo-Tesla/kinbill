// App: builds the Express app, serving the web pages (public/) and the JSON API they use.
// Kept separate from index.js so tests can use it without opening a port.
// Safety: David's routes need his PIN, wrong PINs and AI requests are rate limited,
// and PayPal webhooks are verified with PayPal before they are trusted.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, isPayPalConfigured } from './config.js';
import { getAccessToken } from './paypal/client.js';
import { openDb, getVaultId, listContacts } from './db.js';
import { createPaymentService, PaymentError } from './payments/service.js';
import { verifyWebhook as verifyWithPayPal } from './paypal/webhooks.js';
import { rateLimit, createCounter } from './rateLimit.js';

// Project root, found from this file's location so it works from any working directory.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// AG Grid (sponsor table library) is served from our own server, no CDN needed.
const AG_GRID_DIR = path.join(ROOT, 'node_modules', 'ag-grid-community', 'dist');
// Atkinson Hyperlegible fonts (Braille Institute, made for low vision), also served by us.
const FONT_DIR = path.join(ROOT, 'node_modules', '@fontsource-variable', 'atkinson-hyperlegible-next', 'files');
const MONO_FONT_DIR = path.join(ROOT, 'node_modules', '@fontsource', 'atkinson-hyperlegible-mono', 'files');

/**
 * Builds the Express app with all its routes.
 * Every dependency can be replaced, so tests can pass an in-memory database or fakes.
 * @param {object} [deps]
 * @param {object} [deps.db]               SQLite database (default: a new in-memory one)
 * @param {object} [deps.service]          payment service (default: one built on `db`)
 * @param {string} [deps.helperPin]        PIN David must give; empty means no PIN
 * @param {string} [deps.webhookId]        PayPal webhook id, needed to verify events
 * @param {Function} [deps.verifyWebhook]  checks a webhook event's signature with PayPal
 * @param {object} [deps.limits]           AI requests per minute and wrong PINs per 15 minutes
 * @returns {object} the Express app, ready for listen() or for tests
 */
export function createApp({
  db = openDb(':memory:'),
  service = createPaymentService({ db }),
  helperPin = config.helperPin,
  webhookId = config.webhookId,
  verifyWebhook = verifyWithPayPal,
  limits = { requestsPerMinute: 20, pinFailuresPer15Min: 10 },
} = {}) {
  const app = express();
  app.set('trust proxy', 1);          // behind Render's proxy: req.ip is the visitor's address (the rate limits rely on it)
  app.disable('x-powered-by');        // don't advertise the server software
  app.use(express.json({ limit: '20kb' })); // requests are short sentences; refuse large bodies
  app.use(express.static(PUBLIC_DIR));
  app.use('/vendor/ag-grid', express.static(AG_GRID_DIR));
  app.use('/vendor/fonts', express.static(FONT_DIR, { maxAge: '30d', immutable: true }));
  app.use('/vendor/fonts-mono', express.static(MONO_FONT_DIR, { maxAge: '30d', immutable: true }));

  // Wraps async routes: the result is sent as JSON, and errors become { error, code }.
  // A PaymentError carries its own HTTP status; anything else is a logged 500.
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      const status = err instanceof PaymentError ? err.httpStatus : 500;
      if (status === 500) console.error(err);
      res.status(status).json({ error: err.message, code: err.code || 'SERVER_ERROR' });
    }
  };

  // ---------- Health ----------

  // Called by Render's health check. Returns ok and whether PayPal credentials are set.
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', app: 'kinbill', paypalConfigured: isPayPalConfigured() });
  });

  // Opened by hand to check setup. Gets a fresh PayPal token, so it proves the credentials
  // work right now; returns 502 if PayPal refuses them.
  app.get('/api/health/paypal', async (req, res) => {
    try {
      await getAccessToken({ forceRefresh: true });
      res.json({ paypal: 'connected' });
    } catch (err) {
      res.status(502).json({ paypal: 'error', message: err.message });
    }
  });

  // ---------- What Grace's screen needs to know on load ----------

  // Called by Grace's screen when it opens. Returns the names, whether her PayPal is linked,
  // the AI provider and her contacts.
  app.get('/api/status', (req, res) => {
    res.json({
      userName: config.userName,
      helperName: config.helperName,
      paypalLinked: Boolean(getVaultId(db)),
      aiProvider: (process.env.AI_PROVIDER || 'gemini').toLowerCase(),
      // Names only: contacts' emails never go to the browser.
      contacts: listContacts(db).map((c) => ({ name: c.name, paidBefore: c.times_paid > 0 })),
    });
  });

  // ---------- Connect Grace's PayPal (one time) ----------

  // Called by the "Connect PayPal" button on Grace's screen. Returns the PayPal page
  // (approveUrl) where she approves saving her PayPal for later payments.
  app.post('/api/link/start', handle(() => service.startLink()));

  // PayPal sends Grace back here after she approves. Saves the link, then sends her
  // back to her screen with link=done or link=failed.
  app.get('/api/link/return', async (req, res) => {
    try {
      await service.finishLink(String(req.query.token || ''));
      res.redirect('/grace.html?link=done');
    } catch (err) {
      console.error('Link failed:', err.message);
      res.redirect('/grace.html?link=failed');
    }
  });

  // ---------- Grace's safety rules ----------

  // GET is called by both screens and returns the rules, the care level and a plain-words summary.
  // POST is called by Grace's rules screen. She can only make the rules stricter: loosening
  // is refused and logged (only David can loosen them, through /api/helper/settings).
  app.get('/api/settings', handle(() => service.getRules()));
  app.post('/api/settings', handle((req) => service.updateRules(req.body || {}, { by: 'grace' })));

  // ---------- Payments ----------

  // Called by Grace's screen: create a request from her words (AI check and rules),
  // confirm or cancel it after the read-back, then poll it until the payment settles.
  // New payment requests use the AI, so one visitor can make at most a few per minute.
  const requestLimit = rateLimit({ windowMs: 60e3, max: limits.requestsPerMinute,
    message: 'That was a lot of requests. Please wait a minute and try again.' });
  app.post('/api/requests', requestLimit, handle((req) => service.createRequest(req.body?.text)));
  app.post('/api/requests/:id/confirm', handle((req) => service.confirm(Number(req.params.id))));
  app.post('/api/requests/:id/cancel', handle((req) => service.cancel(Number(req.params.id))));
  app.get('/api/requests/:id', handle((req) => service.get(Number(req.params.id))));

  // ---------- David's helper screen (PIN protected) ----------

  // Wrong PINs are counted per visitor: after too many, that visitor has to wait (stops PIN guessing).
  const pinFailures = createCounter({ windowMs: 15 * 60e3, max: limits.pinFailuresPer15Min });
  // Middleware for every helper route: blocked visitors are refused first, even with the right PIN.
  const requirePin = (req, res, next) => {
    if (helperPin && pinFailures.blocked(req.ip)) {
      res.set('Retry-After', String(pinFailures.retryAfterSeconds(req.ip)));
      return res.status(429).json({ error: 'Too many wrong PINs. Please wait 15 minutes and try again.', code: 'RATE_LIMITED' });
    }
    // The ?pin= form is for the live event stream, because EventSource cannot send headers.
    const given = req.get('x-helper-pin') || req.query.pin || '';
    if (helperPin && given !== helperPin) {
      if (given) pinFailures.hit(req.ip);   // an empty PIN (first visit) does not count
      return res.status(401).json({ error: 'Wrong or missing helper PIN.', code: 'PIN_REQUIRED' });
    }
    next();
  };

  // Called by David's screen. check tests the PIN; overview lists held payments and history;
  // activity returns the audit log; approve and reject decide a held payment
  // (approve may include the payee's PayPal email if they are not a contact yet);
  // settings lets David change any rule, including loosening one.
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
    res.write('retry: 5000\n\n'); // the browser reconnects after 5 s if the stream drops
    const onChange = (e) => res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
    // A comment line every 25 s stops proxies from closing an idle stream.
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    service.events?.on('change', onChange);
    // Clean up when David's page closes, so timers and listeners don't pile up.
    req.on('close', () => { clearInterval(ping); service.events?.off('change', onChange); });
  });

  // ---------- PayPal webhooks ----------

  // Called by PayPal when a payout lands, a hold is voided, etc. Returns { received: true }.
  // Every event is verified with PayPal before we trust it, so a forged call cannot change a payment.
  app.post('/api/paypal/webhook', async (req, res) => {
    // Without a webhook id the signature cannot be checked, so refuse every event.
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
