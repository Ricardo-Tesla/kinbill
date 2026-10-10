// The heart of Kin-bill: turns what Grace said into a safe payment.
//
//   createRequest(text)  -> AI check + contacts + Grace's rules -> AWAITING_CONFIRMATION
//   confirm(id)          -> Grace said "yes":
//                             PAY_NOW    -> charge saved PayPal to Kin-bill, pay out to contact -> PAYING -> PAID
//                             ASK_HELPER -> hold the money in Kin-bill (authorize)             -> HELD
//   cancel(id)           -> Grace said "no" -> CANCELLED (nothing was charged)
//   approve(id)          -> David said yes to a HELD payment: take the held money, pay out -> PAYING -> PAID
//   reject(id)           -> David said no: cancel the hold -> REJECTED (no money moved)
//   expireDueHolds()     -> safety timer: holds nobody decided in time are cancelled -> EXPIRED
//   handleWebhookEvent() -> PayPal tells us what happened (payout delivered, hold voided, ...)
// Every step is written to the activity log (audit_log).
//
// Payment statuses:
//   AWAITING_CONFIRMATION  read back to Grace, waiting for yes/no
//   CANCELLED              Grace said no
//   PAYING                 charged, payout to the contact on its way
//   PAID                   the contact received the money
//   HELD                   money held, waiting for David
//   REJECTED               David said no: the hold was cancelled, no money moved
//   EXPIRED                nobody decided in time: the safety timer cancelled the hold, no money moved
//   FAILED                 nothing was charged (PayPal error)
//   PAYOUT_FAILED          charged to Kin-bill but the payout failed (needs attention)

import { EventEmitter } from 'node:events';
import * as paypalOrders from '../paypal/orders.js';
import { analyzePaymentRequest } from '../ai/riskAgent.js';
import { decide } from '../rules/engine.js';
import {
  getSettings, findContactByName, isKnownContact, getContact, recordPaymentToContact,
  getVaultId, setAccountValue, insertPayment, getPayment, updatePayment, listPayments,
  addContact, findContactByEmail, addAudit, listAudit, listExpiredHolds, findPaymentBy, markWebhookEvent,
} from '../db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class PaymentError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.httpStatus = status;
  }
}

export function createPaymentService({
  db,
  paypal = paypalOrders,
  analyze = analyzePaymentRequest,
  holdTimeoutSeconds = 172800,
  publicUrl = 'http://localhost:3000',
  userName = 'Grace',
  helperName = 'David',
  payoutWait = {},          // options for paypal.waitForPayout (tests make it instant)
  log = console,
}) {
  const background = new Set(); // payouts we are still waiting on
  const events = new EventEmitter(); // 'change' -> David's screen updates live

  // Every status change goes through here, so screens can be told about it.
  function save(id, changes) {
    const p = updatePayment(db, id, changes);
    events.emit('change', { id, status: p?.status });
    return p;
  }

  // Writes one line to the activity log.
  function audit(paymentId, actor, action, detail = '') {
    try { addAudit(db, { paymentId, actor, action, detail }); } catch (err) { log.error?.('audit failed:', err.message); }
  }

  function view(p) {
    if (!p) return null;
    const contact = p.contact_id ? getContact(db, p.contact_id) : null;
    return {
      id: p.id,
      status: p.status,
      said: p.said,
      payeeName: contact?.name || (p.payee_name.toLowerCase() === 'unknown' ? 'someone not in your contacts' : p.payee_name),
      // The same person, worded for David: "Unknown person" instead of Grace's "someone not in your contacts".
      helperPayeeName: contact?.name || (p.payee_name.toLowerCase() === 'unknown' ? 'an unknown person' : p.payee_name),
      inContacts: Boolean(contact),
      amount: p.amount,
      riskScore: p.risk_score,
      triggers: p.triggers,
      decision: p.decision,
      reasons: p.reasons,              // for David
      graceReasons: p.grace_reasons,   // for Grace
      spokenSummary: p.spoken_summary,
      helperExplanation: p.helper_explanation,
      aiSource: p.ai_source,
      holdExpiresAt: p.hold_expires_at,
      decidedBy: p.decided_by,
      decidedAt: p.decided_at,
      error: p.error,
      createdAt: p.created_at,
    };
  }

  // 172800 -> "48 hours", 120 -> "2 minutes"
  function duration(seconds) {
    if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
    if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
    return `${seconds} seconds`;
  }

  function money(amount) {
    return Number.isInteger(amount) ? `${amount} dollars` : `${amount.toFixed(2)} dollars`;
  }

  // Step 1: understand and check what Grace said. Nothing is charged yet.
  async function createRequest(text) {
    const said = String(text || '').trim();
    if (!said) throw new PaymentError('Please say or type who to pay and how much.', 'EMPTY');

    const ai = await analyze(said, { userName, helperName });
    const amount = ai.intent?.amount;
    if (!amount) {
      return {
        needsRetry: true,
        spoken: 'Sorry, I did not catch how much. Please try again, for example: pay Joe 80 dollars.',
      };
    }

    const contact = findContactByName(db, ai.intent.payee_name);
    const rules = decide({
      amount,
      riskScore: ai.risk_score,
      triggers: ai.flagged_triggers,
      knownPayee: isKnownContact(contact),
      settings: getSettings(db),
      payeeName: contact?.name || ai.intent.payee_name,
    });

    let { decision, reasons, graceReasons } = rules;
    const unclearName = !ai.intent.payee_name || ai.intent.payee_name.toLowerCase() === 'unknown';
    if (!contact) {
      // Kin-bill never pays someone who is not in Grace's contacts.
      decision = 'ASK_HELPER';
      reasons = [unclearName
        ? `It is not clear who would receive the money, and they are not in ${userName}'s contacts.`
        : `"${ai.intent.payee_name}" is not in ${userName}'s contacts.`, ...reasons];
      graceReasons = [unclearName
        ? 'I am not sure who would receive the money.'
        : `${ai.intent.payee_name} is not in your contacts.`, ...graceReasons];
    }

    const payment = insertPayment(db, {
      said,
      payee_name: ai.intent.payee_name,
      contact_id: contact?.id,
      amount,
      risk_score: ai.risk_score,
      triggers: ai.flagged_triggers,
      ai_source: ai.source,
      spoken_summary: ai.spoken_summary,
      helper_explanation: ai.helper_explanation,
      decision,
      reasons,
      grace_reasons: graceReasons,
      status: 'AWAITING_CONFIRMATION',
    });
    events.emit('change', { id: payment.id, status: payment.status });
    audit(payment.id, userName.toLowerCase(), 'ASKED', `"${said}"`);
    audit(payment.id, 'ai', 'CHECKED', `${ai.source}: ${ai.intent.payee_name}, $${amount}, risk ${ai.risk_score}/100${ai.flagged_triggers?.length ? ` (${ai.flagged_triggers.join(', ')})` : ''}${ai.aiError ? `; AI unavailable: ${ai.aiError}` : ''}`);
    audit(payment.id, 'kinbill', decision === 'PAY_NOW' ? 'RULES_PAY_NOW' : 'RULES_ASK_HELPER',
      decision === 'PAY_NOW' ? `Within ${userName}'s rules: can be paid straight away` : reasons.join(' '));

    const name = contact?.name || (unclearName ? 'someone who is not in your contacts' : ai.intent.payee_name);
    return { payment: view(payment), spoken: `You want to pay ${name} ${money(amount)}. Is that right?` };
  }

  // Step 2: Grace said yes.
  async function confirm(id) {
    const p = getPayment(db, id);
    if (!p) throw new PaymentError('Payment not found.', 'NOT_FOUND', 404);
    if (p.status !== 'AWAITING_CONFIRMATION') throw new PaymentError('This payment was already handled.', 'ALREADY_HANDLED', 409);
    const vaultId = getVaultId(db);
    if (!vaultId) throw new PaymentError(`${userName}'s PayPal is not connected yet.`, 'NOT_LINKED', 409);

    const contact = p.contact_id ? getContact(db, p.contact_id) : null;
    const name = contact?.name || p.payee_name;

    if (p.decision === 'PAY_NOW' && contact) return payNow(p, contact, vaultId, name);
    return holdForHelper(p, vaultId, name);
  }

  async function payNow(p, contact, vaultId, name) {
    let capture;
    try {
      // Charge Grace's saved PayPal to Kin-bill. requestId makes a retry never charge twice.
      const { order } = await paypal.createOrder({
        intent: 'CAPTURE', amount: p.amount, vaultId, requestId: `kinbill-pay-${p.id}`,
        description: `Kin-bill: ${name}`.slice(0, 120),
      });
      ({ capture } = await paypal.settleVaultedOrder(order));
      if (capture?.status !== 'COMPLETED') throw new Error(`capture status ${capture?.status}`);
      save(p.id, { order_id: order.id, capture_id: capture.id });
      audit(p.id, 'paypal', 'CHARGED', `$${p.amount} charged to Kin-bill (order ${order.id}, capture ${capture.id})`);
    } catch (err) {
      log.error?.(`Payment ${p.id}: charge failed:`, err.message);
      save(p.id, { status: 'FAILED', error: err.message });
      audit(p.id, 'paypal', 'FAILED', `Nothing charged: ${err.message}`);
      return { payment: view(getPayment(db, p.id)), spoken: 'Sorry, something went wrong and no money was sent. Please try again later.' };
    }

    try {
      // Forward the money to the contact.
      const payout = await paypal.sendPayout({
        receiverEmail: contact.email, amount: p.amount, referenceId: `kinbill-payout-${p.id}`,
        note: `From ${userName}, sent with Kin-bill`,
      });
      save(p.id, { status: 'PAYING', payout_batch_id: payout.batchId });
      audit(p.id, 'kinbill', 'PAYOUT_SENT', `$${p.amount} sent on to ${contact.name} (batch ${payout.batchId})`);
      trackPayout(p.id, payout.batchId, contact.id);
    } catch (err) {
      log.error?.(`Payment ${p.id}: payout failed:`, err.message);
      save(p.id, { status: 'PAYOUT_FAILED', error: err.message });
      audit(p.id, 'paypal', 'PAYOUT_FAILED', err.message);
      return { payment: view(getPayment(db, p.id)), spoken: `The money was taken but could not reach ${name} yet. ${helperName} will be asked to help.` };
    }

    return { payment: view(getPayment(db, p.id)), spoken: `Done. ${money(p.amount)} is on its way to ${name}.` };
  }

  async function holdForHelper(p, vaultId, name) {
    try {
      // Hold the money in Kin-bill's own account; nothing reaches anyone yet.
      const { order } = await paypal.createOrder({
        intent: 'AUTHORIZE', amount: p.amount, vaultId, requestId: `kinbill-hold-${p.id}`,
        description: `Kin-bill hold for review: ${name}`.slice(0, 120),
      });
      const { authorization } = await paypal.settleVaultedOrder(order);
      if (!authorization?.id) throw new Error('no authorization returned');
      const expires = new Date(Date.now() + holdTimeoutSeconds * 1000).toISOString();
      save(p.id, { status: 'HELD', order_id: order.id, authorization_id: authorization.id, hold_expires_at: expires });
      audit(p.id, 'kinbill', 'HELD', `$${p.amount} held in Kin-bill (authorization ${authorization.id}); waiting for ${helperName}, auto-cancel after ${duration(holdTimeoutSeconds)}`);
    } catch (err) {
      log.error?.(`Payment ${p.id}: hold failed:`, err.message);
      save(p.id, { status: 'FAILED', error: err.message });
      audit(p.id, 'paypal', 'FAILED', `Nothing held or charged: ${err.message}`);
      return { payment: view(getPayment(db, p.id)), spoken: 'Sorry, something went wrong and no money was sent. Please try again later.' };
    }
    const opening = p.spoken_summary && p.risk_score >= 40
      ? p.spoken_summary
      : `I have paused this payment of ${money(p.amount)} to ${name}, and asked ${helperName} to check it first. No money has been sent.`;
    // Add the main reason, in gentle words, so Grace knows why.
    const why = p.grace_reasons?.[0];
    const spoken = why ? `${opening} The main reason: ${why}` : opening;
    return { payment: view(getPayment(db, p.id)), spoken };
  }

  // Waits (in the background) for PayPal to deliver the payout, then marks it PAID.
  function trackPayout(paymentId, batchId, contactId) {
    const job = paypal.waitForPayout(batchId, payoutWait)
      .then((status) => {
        markPaid(paymentId, contactId, status, 'payout check');
      })
      .catch((err) => log.error?.(`Payment ${paymentId}: payout check failed:`, err.message))
      .finally(() => background.delete(job));
    background.add(job);
  }

  // Called by the payout check or a PayPal webhook; safe to call twice.
  function markPaid(paymentId, contactId, payoutStatus, source) {
    const current = getPayment(db, paymentId);
    if (!current || current.status !== 'PAYING') return;
    if (payoutStatus === 'SUCCESS') {
      save(paymentId, { status: 'PAID' });
      if (contactId) recordPaymentToContact(db, contactId);
      audit(paymentId, 'paypal', 'DELIVERED', `Payout delivered (${source})`);
    } else if (['DENIED', 'CANCELED', 'FAILED', 'RETURNED', 'BLOCKED'].includes(payoutStatus)) {
      save(paymentId, { status: 'PAYOUT_FAILED', error: `payout ${payoutStatus}` });
      audit(paymentId, 'paypal', 'PAYOUT_FAILED', `Payout ${payoutStatus} (${source})`);
    } // still PROCESSING: stays PAYING
  }

  // ---- David's decisions on HELD payments ----

  function getHeld(id) {
    const p = getPayment(db, id);
    if (!p) throw new PaymentError('Payment not found.', 'NOT_FOUND', 404);
    if (p.status !== 'HELD') throw new PaymentError('This payment is not waiting for a decision any more.', 'NOT_HELD', 409);
    return p;
  }

  // David approves. If the person is not in Grace's contacts, David must give their PayPal email,
  // and they are added to her contacts first.
  async function approve(id, { email, by = 'helper' } = {}) {
    const p = getHeld(id);
    let contact = p.contact_id ? getContact(db, p.contact_id) : null;
    if (!contact) {
      const clean = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(clean)) {
        throw new PaymentError(`"${p.payee_name}" is not in ${userName}'s contacts. Add their PayPal email to approve.`, 'EMAIL_REQUIRED');
      }
      const name = p.payee_name && p.payee_name.toLowerCase() !== 'unknown' ? p.payee_name : clean;
      contact = findContactByEmail(db, clean) || addContact(db, { name, email: clean });
      save(id, { contact_id: contact.id });
      audit(id, 'david', 'CONTACT_ADDED', `${contact.name} <${contact.email}> added to ${userName}'s contacts`);
    }

    try {
      // Take the money that was held in Kin-bill's account.
      const capture = await paypal.captureAuthorization(p.authorization_id);
      if (capture?.status !== 'COMPLETED') throw new Error(`capture status ${capture?.status}`);
      save(id, { capture_id: capture.id, decided_by: by, decided_at: new Date().toISOString() });
      audit(id, 'david', 'APPROVED', `${helperName} approved; held $${p.amount} taken (capture ${capture.id})`);
    } catch (err) {
      log.error?.(`Payment ${id}: approve capture failed:`, err.message);
      audit(id, 'paypal', 'CAPTURE_FAILED', err.message);
      throw new PaymentError(`PayPal could not take the held money: ${err.message}`, 'CAPTURE_FAILED', 502);
    }

    try {
      const payout = await paypal.sendPayout({
        receiverEmail: contact.email, amount: p.amount, referenceId: `kinbill-payout-${p.id}`,
        note: `From ${userName}, approved by ${helperName}, sent with Kin-bill`,
      });
      save(id, { status: 'PAYING', payout_batch_id: payout.batchId });
      audit(id, 'kinbill', 'PAYOUT_SENT', `$${p.amount} sent on to ${contact.name} (batch ${payout.batchId})`);
      trackPayout(id, payout.batchId, contact.id);
    } catch (err) {
      log.error?.(`Payment ${id}: payout failed:`, err.message);
      save(id, { status: 'PAYOUT_FAILED', error: err.message });
      audit(id, 'paypal', 'PAYOUT_FAILED', err.message);
    }
    return { payment: view(getPayment(db, id)) };
  }

  // David rejects: release the hold. No money moves.
  async function reject(id, { by = 'helper' } = {}) {
    const p = getHeld(id);
    try {
      await paypal.voidAuthorization(p.authorization_id);
    } catch (err) {
      log.error?.(`Payment ${id}: void failed:`, err.message);
      throw new PaymentError(`PayPal could not cancel the hold: ${err.message}`, 'VOID_FAILED', 502);
    }
    save(id, { status: 'REJECTED', decided_by: by, decided_at: new Date().toISOString() });
    audit(id, 'david', 'REJECTED', `${helperName} rejected; hold on $${p.amount} cancelled, no money moved`);
    return { payment: view(getPayment(db, id)) };
  }

  // ---- Safety timer: holds nobody decided in time are cancelled ----

  async function expireDueHolds(now = new Date()) {
    let expired = 0;
    for (const p of listExpiredHolds(db, now)) {
      try {
        await paypal.voidAuthorization(p.authorization_id);
      } catch (err) {
        // 422 = PayPal says the hold is already gone (voided or expired): treat as cancelled.
        if (err.status !== 422) {
          log.error?.(`Payment ${p.id}: auto-cancel failed, will retry:`, err.message);
          audit(p.id, 'timer', 'EXPIRE_RETRY', `Could not cancel yet: ${err.message}`);
          continue;
        }
      }
      if (getPayment(db, p.id)?.status !== 'HELD') continue; // David decided meanwhile
      save(p.id, { status: 'EXPIRED', decided_by: 'timer', decided_at: new Date().toISOString() });
      audit(p.id, 'timer', 'EXPIRED', `Nobody decided within ${duration(holdTimeoutSeconds)}; hold on $${p.amount} cancelled, no money moved`);
      expired++;
    }
    return expired;
  }

  // After a restart, keep checking payouts that were still on their way.
  function resumePayoutChecks() {
    for (const p of listPayments(db, { status: 'PAYING' })) {
      if (p.payout_batch_id) trackPayout(p.id, p.payout_batch_id, p.contact_id);
    }
  }

  // Runs the safety timer every few seconds. Returns a function that stops it.
  function startTimers({ intervalMs = 30000 } = {}) {
    resumePayoutChecks();
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try { await expireDueHolds(); } catch (err) { log.error?.('safety timer:', err.message); } finally { running = false; }
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // ---- PayPal webhooks (verified in app.js before they get here) ----

  async function handleWebhookEvent(event) {
    if (!event?.id || !event.event_type) return { handled: false, reason: 'not an event' };
    if (!markWebhookEvent(db, event.id, event.event_type)) return { handled: false, reason: 'duplicate' };
    const r = event.resource || {};
    let p = null;
    switch (event.event_type) {
      case 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED':
      case 'PAYMENT.PAYOUTS-ITEM.FAILED':
      case 'PAYMENT.PAYOUTS-ITEM.RETURNED':
      case 'PAYMENT.PAYOUTS-ITEM.BLOCKED':
      case 'PAYMENT.PAYOUTS-ITEM.DENIED': {
        p = findPaymentBy(db, 'payout_batch_id', r.payout_batch_id);
        if (p) markPaid(p.id, p.contact_id, event.event_type.split('.').pop() === 'SUCCEEDED' ? 'SUCCESS' : event.event_type.split('.').pop(), 'PayPal webhook');
        break;
      }
      case 'PAYMENT.AUTHORIZATION.VOIDED':
        p = findPaymentBy(db, 'authorization_id', r.id);
        if (p) audit(p.id, 'paypal', 'CONFIRMED_VOIDED', 'PayPal confirmed the hold was cancelled');
        break;
      case 'PAYMENT.CAPTURE.COMPLETED':
        p = findPaymentBy(db, 'capture_id', r.id);
        if (p) audit(p.id, 'paypal', 'CONFIRMED_CAPTURED', `PayPal confirmed $${r.amount?.value ?? p.amount} captured`);
        break;
      default:
        break;
    }
    if (!p) audit(null, 'paypal', 'WEBHOOK', `${event.event_type} (not linked to a Kin-bill payment)`);
    return { handled: Boolean(p), paymentId: p?.id ?? null };
  }

  function activity({ paymentId } = {}) {
    return listAudit(db, { paymentId });
  }

  // What David's screen shows: payments waiting for him, and the recent history.
  function helperOverview() {
    return {
      held: listPayments(db, { status: 'HELD' }).map(view),
      history: listPayments(db, { limit: 200 }).filter((p) => p.status !== 'AWAITING_CONFIRMATION').map(view),
    };
  }

  // Step 2 (alternative): Grace said no.
  function cancel(id) {
    const p = getPayment(db, id);
    if (!p) throw new PaymentError('Payment not found.', 'NOT_FOUND', 404);
    if (p.status !== 'AWAITING_CONFIRMATION') throw new PaymentError('This payment was already handled.', 'ALREADY_HANDLED', 409);
    save(id, { status: 'CANCELLED' });
    audit(id, userName.toLowerCase(), 'CANCELLED', `${userName} said no; nothing was charged`);
    return { payment: view(getPayment(db, id)), spoken: 'Okay, I have cancelled it. Nothing was sent.' };
  }

  function get(id) {
    const p = view(getPayment(db, id));
    if (!p) throw new PaymentError('Payment not found.', 'NOT_FOUND', 404);
    return p;
  }

  // ---- Connecting Grace's PayPal (one time) ----

  async function startLink() {
    const { order, approveUrl } = await paypal.createOrder({
      intent: 'AUTHORIZE', amount: 1, saveToVault: true,
      description: 'Connect PayPal to Kin-bill (1 dollar check, released, not charged)',
      returnUrl: `${publicUrl}/api/link/return`,
      cancelUrl: `${publicUrl}/grace.html?link=cancelled`,
    });
    setAccountValue(db, 'link_order_id', order.id);
    return { approveUrl };
  }

  async function finishLink(orderId) {
    const { order, authorization } = await paypal.authorizeOrder(orderId);
    const vaultId = paypal.extractVaultId(order) || paypal.extractVaultId(await paypal.getOrder(orderId));
    if (authorization?.id) await paypal.voidAuthorization(authorization.id).catch(() => {}); // release the $1
    if (!vaultId) throw new PaymentError('PayPal did not return a saved link.', 'LINK_FAILED', 502);
    setAccountValue(db, 'vault_id', vaultId);
    return { linked: true };
  }

  // Tests use this to wait for background payout checks.
  async function idle() {
    while (background.size) await Promise.all([...background]);
  }

  return {
    createRequest, confirm, cancel, get, approve, reject, helperOverview, activity,
    expireDueHolds, startTimers, resumePayoutChecks, handleWebhookEvent,
    startLink, finishLink, idle, events,
  };
}
