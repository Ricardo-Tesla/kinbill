// Payment service: turns what Grace said into a safe payment.
// Every payment is charged to Kin-bill's own PayPal account first, then forwarded to the
// contact with a PayPal Payout. Risky payments are only authorized (held) until David decides.
// The AI only scores the risk; plain-code rules decide, and the AI never moves money.
// Every step is written to the activity log (audit_log).
//
// Main flow:
//   createRequest(text)  -> AI check + contacts + Grace's rules -> AWAITING_CONFIRMATION
//   confirm(id)          -> Grace said "yes":
//                             PAY_NOW    -> charge saved PayPal to Kin-bill, pay out to contact -> PAYING -> PAID
//                             ASK_HELPER -> hold the money in Kin-bill (authorize)             -> HELD
//   cancel(id)           -> Grace said "no" -> CANCELLED (nothing was charged)
//   approve(id)          -> David said yes to a HELD payment: take the held money, pay out -> PAYING -> PAID
//   reject(id)           -> David said no: cancel the hold -> REJECTED (no money moved)
//   expireDueHolds()     -> safety timer: holds nobody decided in time are cancelled -> EXPIRED
//   handleWebhookEvent() -> PayPal tells us what happened (payout delivered, hold voided, ...)
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
import { decide, loosenedSettings, describeRules, careLabel } from '../rules/engine.js';
import {
  getSettings, saveSettings, cleanSettings, findContactByName, isKnownContact, getContact, recordPaymentToContact,
  getVaultId, setAccountValue, insertPayment, getPayment, updatePayment, listPayments,
  addContact, findContactByEmail, addAudit, listAudit, listExpiredHolds, findPaymentBy, markWebhookEvent,
} from '../db.js';

// Basic shape check for the PayPal email David gives when approving someone new.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- PayPal references and errors ----------

/**
 * Builds the reference sent to PayPal with a payment request. It must never be reused:
 * - payouts: PayPal refuses a reference it has seen before (blocks double payouts for 30 days).
 * - orders: PayPal-Request-Id makes PayPal repeat its old answer instead of doing new work.
 * The payment number alone is not enough, because a fresh database (e.g. after a Render restart)
 * starts counting at 1 again. Adding the creation time keeps the reference unique, yet the same
 * when Kin-bill retries the very same payment, so a retry never charges twice.
 * @param {string} kind  'pay', 'hold' or 'payout'
 * @param {object} p     payment row (uses id and created_at)
 * @returns {string} e.g. "kinbill-pay-12-<creation time in base 36>"
 */
export function paymentRef(kind, p) {
  return `kinbill-${kind}-${p.id}-${Date.parse(p.created_at).toString(36)}`;
}
// Reference for the payout that forwards a payment to its contact.
export const payoutReference = (p) => paymentRef('payout', p);

/**
 * An error whose message is safe to show to Grace or David.
 * app.js turns it into a JSON response with this code and HTTP status.
 * @param {string} message  plain-English explanation
 * @param {string} code     short machine-readable code, e.g. 'NOT_FOUND'
 * @param {number} status   HTTP status (default 400)
 */
export class PaymentError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.httpStatus = status;
  }
}

// ---------- The service ----------

/**
 * Creates the payment service used by the API routes.
 * PayPal, the AI check and the logger can be swapped for fakes in tests.
 * @param {object} options
 * @param {object} options.db                  open database from db.js
 * @param {object} [options.paypal]            PayPal helpers (default: paypal/orders.js)
 * @param {Function} [options.analyze]         AI risk check (default: ai/riskAgent.js)
 * @param {number} [options.holdTimeoutSeconds] how long a hold waits for David (default 48 hours)
 * @param {string} [options.publicUrl]         where PayPal sends Grace back after linking
 * @param {string} [options.userName]          the person paying (Grace)
 * @param {string} [options.helperName]        the trusted contact (David)
 * @returns {object} the service functions, plus `events` for live screen updates
 */
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
  const background = new Set(); // payout checks still running (see idle())
  const events = new EventEmitter(); // 'change' -> David's screen updates live

  // ---------- Small helpers ----------

  /**
   * Saves changes to a payment and tells live screens about it.
   * Every status change goes through here so no update is missed.
   * @returns {object|null} the updated payment row
   */
  function save(id, changes) {
    const p = updatePayment(db, id, changes);
    events.emit('change', { id, status: p?.status });
    return p;
  }

  // Writes one line to the activity log. A logging failure must never stop a payment step.
  function audit(paymentId, actor, action, detail = '') {
    try { addAudit(db, { paymentId, actor, action, detail }); } catch (err) { log.error?.('audit failed:', err.message); }
  }

  /**
   * Turns a database row into the shape the screens use, with wording for Grace and for David.
   * @param {object|null} p  payment row
   * @returns {object|null} the payment for the API, or null if there is none
   */
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

  // Seconds as spoken words: 172800 -> "48 hours", 120 -> "2 minutes".
  function duration(seconds) {
    if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
    if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
    return `${seconds} seconds`;
  }

  // An amount as spoken words: 80 -> "80 dollars", 12.5 -> "12.50 dollars".
  function money(amount) {
    return Number.isInteger(amount) ? `${amount} dollars` : `${amount.toFixed(2)} dollars`;
  }

  // ---------- Grace asks for a payment ----------

  /**
   * Step 1: understands and checks what Grace said. Nothing is charged yet.
   * The AI reads the request and scores the risk; the rules engine (plain code) decides.
   * @param {string} text  what Grace said or typed
   * @returns {Promise<object>} { payment, spoken } to read back, or { needsRetry, spoken }
   */
  async function createRequest(text) {
    const said = String(text || '').trim();
    if (!said) throw new PaymentError('Please say or type who to pay and how much.', 'EMPTY');

    const ai = await analyze(said, { userName, helperName });
    const amount = ai.intent?.amount;
    // Without a clear amount there is nothing safe to check, so ask Grace again.
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
    // The AI uses "unknown" when it cannot tell who should be paid.
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
    // A new payment does not go through save(), so tell live screens here.
    events.emit('change', { id: payment.id, status: payment.status });
    audit(payment.id, userName.toLowerCase(), 'ASKED', `"${said}"`);
    audit(payment.id, 'ai', 'CHECKED', `${ai.source}: ${ai.intent.payee_name}, $${amount}, risk ${ai.risk_score}/100${ai.flagged_triggers?.length ? ` (${ai.flagged_triggers.join(', ')})` : ''}${ai.aiError ? `; AI unavailable: ${ai.aiError}` : ''}`);
    audit(payment.id, 'kinbill', decision === 'PAY_NOW' ? 'RULES_PAY_NOW' : 'RULES_ASK_HELPER',
      decision === 'PAY_NOW' ? `Within ${userName}'s rules: can be paid straight away` : reasons.join(' '));

    const name = contact?.name || (unclearName ? 'someone who is not in your contacts' : ai.intent.payee_name);
    return { payment: view(payment), spoken: `You want to pay ${name} ${money(amount)}. Is that right?` };
  }

  /**
   * Step 2: Grace said yes. Pays now or holds the money for David, as the rules decided.
   * @param {number} id  payment id
   * @returns {Promise<object>} { payment, spoken }
   */
  async function confirm(id) {
    const p = getPayment(db, id);
    if (!p) throw new PaymentError('Payment not found.', 'NOT_FOUND', 404);
    if (p.status !== 'AWAITING_CONFIRMATION') throw new PaymentError('This payment was already handled.', 'ALREADY_HANDLED', 409);
    const vaultId = getVaultId(db);
    if (!vaultId) throw new PaymentError(`${userName}'s PayPal is not connected yet.`, 'NOT_LINKED', 409);

    const contact = p.contact_id ? getContact(db, p.contact_id) : null;
    const name = contact?.name || p.payee_name;

    // Pay straight away only with a matched contact; anything else is held, whatever the decision says.
    if (p.decision === 'PAY_NOW' && contact) return payNow(p, contact, vaultId, name);
    return holdForHelper(p, vaultId, name);
  }

  /**
   * Low-risk path: charges Grace's saved PayPal to Kin-bill, then pays the contact with a Payout.
   * If the charge fails nothing was taken (FAILED); if only the payout fails the money sits
   * in Kin-bill's account (PAYOUT_FAILED) and needs attention.
   * @returns {Promise<object>} { payment, spoken }
   */
  async function payNow(p, contact, vaultId, name) {
    let capture;
    try {
      // Charge Grace's saved PayPal to Kin-bill. requestId makes a retry never charge twice.
      const { order } = await paypal.createOrder({
        intent: 'CAPTURE', amount: p.amount, vaultId, requestId: paymentRef('pay', p),
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
      // Forward the money from Kin-bill's account to the contact.
      const payout = await paypal.sendPayout({
        receiverEmail: contact.email, amount: p.amount, referenceId: payoutReference(p),
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

  /**
   * Risky path: authorizes (holds) the money in Kin-bill's own account and waits for David.
   * The hold has no payee, because PayPal only lets Kin-bill capture or void its own holds.
   * @returns {Promise<object>} { payment, spoken } explaining the pause to Grace
   */
  async function holdForHelper(p, vaultId, name) {
    try {
      // Hold the money in Kin-bill's own account; nothing reaches anyone yet.
      const { order } = await paypal.createOrder({
        intent: 'AUTHORIZE', amount: p.amount, vaultId, requestId: paymentRef('hold', p),
        description: `Kin-bill hold for review: ${name}`.slice(0, 120),
      });
      const { authorization } = await paypal.settleVaultedOrder(order);
      if (!authorization?.id) throw new Error('no authorization returned');
      // The safety timer voids the hold at this time if David has not decided.
      const expires = new Date(Date.now() + holdTimeoutSeconds * 1000).toISOString();
      save(p.id, { status: 'HELD', order_id: order.id, authorization_id: authorization.id, hold_expires_at: expires });
      audit(p.id, 'kinbill', 'HELD', `$${p.amount} held in Kin-bill (authorization ${authorization.id}); waiting for ${helperName}, auto-cancel after ${duration(holdTimeoutSeconds)}`);
    } catch (err) {
      log.error?.(`Payment ${p.id}: hold failed:`, err.message);
      save(p.id, { status: 'FAILED', error: err.message });
      audit(p.id, 'paypal', 'FAILED', `Nothing held or charged: ${err.message}`);
      return { payment: view(getPayment(db, p.id)), spoken: 'Sorry, something went wrong and no money was sent. Please try again later.' };
    }
    // Use the AI's own words only when the risk is real; otherwise a calm standard message.
    const opening = p.spoken_summary && p.risk_score >= 40
      ? p.spoken_summary
      : `I have paused this payment of ${money(p.amount)} to ${name}, and asked ${helperName} to check it first. No money has been sent.`;
    // Add the main reason, in gentle words, so Grace knows why.
    const why = p.grace_reasons?.[0];
    const spoken = why ? `${opening} The main reason: ${why}` : opening;
    return { payment: view(getPayment(db, p.id)), spoken };
  }

  // ---------- Following payouts ----------

  /**
   * Waits in the background for PayPal to finish the payout, then records the result.
   * Sandbox payouts take a minute or two, so Grace is not kept waiting for this.
   * @param {number} paymentId
   * @param {string} batchId    PayPal payout batch id
   * @param {number} contactId  contact to credit once the money arrives
   */
  function trackPayout(paymentId, batchId, contactId) {
    const job = paypal.waitForPayout(batchId, payoutWait)
      .then((status) => {
        markPaid(paymentId, contactId, status, 'payout check');
      })
      .catch((err) => log.error?.(`Payment ${paymentId}: payout check failed:`, err.message))
      .finally(() => background.delete(job));
    background.add(job);
  }

  /**
   * Records the final payout result: PAID on success, PAYOUT_FAILED if PayPal gave up.
   * Called by the payout check or a PayPal webhook, so it must be safe to call twice.
   * @param {number} paymentId
   * @param {number|null} contactId  contact whose "times paid" count goes up on success
   * @param {string} payoutStatus    PayPal status, e.g. SUCCESS, DENIED, RETURNED
   * @param {string} source          where the news came from, for the activity log
   */
  function markPaid(paymentId, contactId, payoutStatus, source) {
    const current = getPayment(db, paymentId);
    // Only a payment still on its way can change; this makes a second call do nothing.
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

  // ---------- David's decisions on held payments ----------

  // Loads a payment and makes sure it is still HELD, so a hold is never decided twice.
  function getHeld(id) {
    const p = getPayment(db, id);
    if (!p) throw new PaymentError('Payment not found.', 'NOT_FOUND', 404);
    if (p.status !== 'HELD') throw new PaymentError('This payment is not waiting for a decision any more.', 'NOT_HELD', 409);
    return p;
  }

  /**
   * David approves a held payment: captures the held money, then pays it out to the contact.
   * If the person is not in Grace's contacts, David must give their PayPal email,
   * and they are added to her contacts first.
   * @param {number} id  payment id
   * @param {object} [opts]
   * @param {string} [opts.email]  payee's PayPal email (needed only for someone new)
   * @param {string} [opts.by]     who decided, stored in decided_by
   * @returns {Promise<object>} { payment }
   */
  async function approve(id, { email, by = 'helper' } = {}) {
    const p = getHeld(id);
    let contact = p.contact_id ? getContact(db, p.contact_id) : null;
    if (!contact) {
      const clean = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(clean)) {
        throw new PaymentError(`"${p.payee_name}" is not in ${userName}'s contacts. Add their PayPal email to approve.`, 'EMAIL_REQUIRED');
      }
      const name = p.payee_name && p.payee_name.toLowerCase() !== 'unknown' ? p.payee_name : clean;
      // Reuse an existing contact with this email rather than adding a duplicate.
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
      // The payment stays HELD, so David can try again or the safety timer can void it.
      log.error?.(`Payment ${id}: approve capture failed:`, err.message);
      audit(id, 'paypal', 'CAPTURE_FAILED', err.message);
      throw new PaymentError(`PayPal could not take the held money: ${err.message}`, 'CAPTURE_FAILED', 502);
    }

    try {
      // The money is now in Kin-bill's account; forward it to the contact.
      const payout = await paypal.sendPayout({
        receiverEmail: contact.email, amount: p.amount, referenceId: payoutReference(p),
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

  /**
   * David rejects a held payment: voids the hold, so no money moves.
   * @param {number} id  payment id
   * @param {object} [opts]
   * @param {string} [opts.by]  who decided, stored in decided_by
   * @returns {Promise<object>} { payment }
   */
  async function reject(id, { by = 'helper' } = {}) {
    const p = getHeld(id);
    try {
      await paypal.voidAuthorization(p.authorization_id);
    } catch (err) {
      // Keep the payment HELD: it only counts as rejected once PayPal has released the money.
      log.error?.(`Payment ${id}: void failed:`, err.message);
      throw new PaymentError(`PayPal could not cancel the hold: ${err.message}`, 'VOID_FAILED', 502);
    }
    save(id, { status: 'REJECTED', decided_by: by, decided_at: new Date().toISOString() });
    audit(id, 'david', 'REJECTED', `${helperName} rejected; hold on $${p.amount} cancelled, no money moved`);
    return { payment: view(getPayment(db, id)) };
  }

  // ---------- Safety timer: holds nobody decided in time are cancelled ----------

  /**
   * Voids every hold whose time is up and marks it EXPIRED. No money moves.
   * A hold PayPal will not void yet stays HELD and is tried again on the next tick.
   * @param {Date} [now]  current time (tests pass their own)
   * @returns {Promise<number>} how many holds were expired
   */
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

  // After a restart, keeps checking payouts that were still on their way.
  function resumePayoutChecks() {
    for (const p of listPayments(db, { status: 'PAYING' })) {
      if (p.payout_batch_id) trackPayout(p.id, p.payout_batch_id, p.contact_id);
    }
  }

  /**
   * Resumes payout checks and runs the safety timer at a fixed interval.
   * @param {object} [opts]
   * @param {number} [opts.intervalMs]  time between checks (default 30 seconds)
   * @returns {Function} call it to stop the timer
   */
  function startTimers({ intervalMs = 30000 } = {}) {
    resumePayoutChecks();
    let running = false;
    const tick = async () => {
      // Skip this tick if the last one is still running, so two ticks never void the same hold.
      if (running) return;
      running = true;
      try { await expireDueHolds(); } catch (err) { log.error?.('safety timer:', err.message); } finally { running = false; }
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.(); // the timer alone must not keep Node running (e.g. at the end of tests)
    return () => clearInterval(timer);
  }

  // ---------- PayPal webhooks (verified in app.js before they get here) ----------

  /**
   * Applies a PayPal webhook event to the matching payment.
   * Payout events set the final status; hold and capture events are only logged as confirmation.
   * @param {object} event  verified PayPal webhook body
   * @returns {Promise<object>} { handled, paymentId } or { handled: false, reason }
   */
  async function handleWebhookEvent(event) {
    if (!event?.id || !event.event_type) return { handled: false, reason: 'not an event' };
    // PayPal may send the same event more than once; handle each event id only once.
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
        // Webhooks say SUCCEEDED where the payout status says SUCCESS; markPaid expects the latter.
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
    // Log unmatched events too, so nothing PayPal reports is silently lost.
    if (!p) audit(null, 'paypal', 'WEBHOOK', `${event.event_type} (not linked to a Kin-bill payment)`);
    return { handled: Boolean(p), paymentId: p?.id ?? null };
  }

  // ---------- Reading and cancelling payments ----------

  // The activity log: one payment's steps in order, or the latest entries for all payments.
  function activity({ paymentId } = {}) {
    return listAudit(db, { paymentId });
  }

  /**
   * What David's screen shows: payments waiting for him, and the recent history.
   * @returns {object} { held, history }; payments not yet confirmed by Grace are left out
   */
  function helperOverview() {
    return {
      held: listPayments(db, { status: 'HELD' }).map(view),
      history: listPayments(db, { limit: 200 }).filter((p) => p.status !== 'AWAITING_CONFIRMATION').map(view),
    };
  }

  /**
   * Step 2 (alternative): Grace said no. Nothing has been charged at this point.
   * @param {number} id  payment id
   * @returns {object} { payment, spoken }
   */
  function cancel(id) {
    const p = getPayment(db, id);
    if (!p) throw new PaymentError('Payment not found.', 'NOT_FOUND', 404);
    if (p.status !== 'AWAITING_CONFIRMATION') throw new PaymentError('This payment was already handled.', 'ALREADY_HANDLED', 409);
    save(id, { status: 'CANCELLED' });
    audit(id, userName.toLowerCase(), 'CANCELLED', `${userName} said no; nothing was charged`);
    return { payment: view(getPayment(db, id)), spoken: 'Okay, I have cancelled it. Nothing was sent.' };
  }

  // One payment in screen shape; throws NOT_FOUND if there is no such payment.
  function get(id) {
    const p = view(getPayment(db, id));
    if (!p) throw new PaymentError('Payment not found.', 'NOT_FOUND', 404);
    return p;
  }

  // ---------- Connecting Grace's PayPal (one time) ----------

  /**
   * Starts the one-time PayPal link: a 1 dollar authorization that also saves her PayPal (vault).
   * The check is released afterwards, so nothing is charged.
   * @returns {Promise<object>} { approveUrl } where Grace (or David) approves in PayPal
   */
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

  /**
   * Finishes the link after PayPal sends the browser back: stores the saved PayPal (vault id)
   * and releases the 1 dollar check.
   * @param {string} orderId  the order from startLink()
   * @returns {Promise<object>} { linked: true }
   */
  async function finishLink(orderId) {
    const { order, authorization } = await paypal.authorizeOrder(orderId);
    // The vault id is not always in the authorize response, so fetch the order if needed.
    const vaultId = paypal.extractVaultId(order) || paypal.extractVaultId(await paypal.getOrder(orderId));
    if (authorization?.id) await paypal.voidAuthorization(authorization.id).catch(() => {}); // release the $1; a failed release must not undo the link
    if (!vaultId) throw new PaymentError('PayPal did not return a saved link.', 'LINK_FAILED', 502);
    setAccountValue(db, 'vault_id', vaultId);
    return { linked: true };
  }

  // ---------- Grace's safety rules ----------
  // Grace may make them stricter; only the helper may loosen them (see rules/engine.js).

  // The current rules with their care level and a plain-English summary.
  function rulesView() {
    const settings = getSettings(db);
    return {
      settings,
      careLevel: careLabel(settings.riskThreshold),
      summary: describeRules(settings, { helperName, holdTime: duration(holdTimeoutSeconds) }),
    };
  }

  // Grace's current safety rules, for both screens.
  function getRules() {
    return rulesView();
  }

  // Describes what differs between two sets of rules, for the activity log ('' if nothing).
  function describeChange(before, after) {
    const parts = [];
    if (before.perPaymentLimit !== after.perPaymentLimit) parts.push(`limit $${before.perPaymentLimit} -> $${after.perPaymentLimit}`);
    if (before.riskThreshold !== after.riskThreshold) {
      parts.push(`scam check ${careLabel(before.riskThreshold)} (${before.riskThreshold}) -> ${careLabel(after.riskThreshold)} (${after.riskThreshold})`);
    }
    if (before.askForNewPayees !== after.askForNewPayees) parts.push(`ask about new people: ${before.askForNewPayees ? 'yes' : 'no'} -> ${after.askForNewPayees ? 'yes' : 'no'}`);
    return parts.join('; ');
  }

  /**
   * Changes Grace's safety rules. Grace may only make them stricter; David may change any rule.
   * A blocked attempt is logged so David sees it, in case someone is coaching Grace.
   * @param {object} changes  { perPaymentLimit?, riskThreshold?, askForNewPayees? }
   * @param {object} opts     { by: 'grace' | 'helper' }
   * @returns {object} the new rules view, plus { changed, spoken }
   */
  function updateRules(changes, { by = 'grace' } = {}) {
    let clean;
    try {
      clean = cleanSettings(changes);
    } catch (err) {
      throw new PaymentError(`That setting is not valid: ${err.message}.`, 'BAD_SETTING', 400);
    }
    if (!Object.keys(clean).length) throw new PaymentError('Nothing to change.', 'BAD_SETTING', 400);

    const before = getSettings(db);
    const actor = by === 'helper' ? 'david' : 'grace';
    const tried = describeChange(before, { ...before, ...clean });

    if (actor === 'grace') {
      const loosened = loosenedSettings(before, clean);
      if (loosened.length) {
        // Tell the helper: someone may be talking Grace into switching protection off.
        addAudit(db, { actor: 'grace', action: 'RULES_BLOCKED', detail: `${userName} tried to loosen her rules (${tried}). Only ${helperName} can do that.` });
        events.emit('change', { rules: true });
        throw new PaymentError(
          `Only ${helperName} can make your rules less strict. This keeps you safe if someone asks you to change them. Nothing was changed.`,
          'NEEDS_HELPER', 403,
        );
      }
    }

    const after = saveSettings(db, clean);
    const what = describeChange(before, after);
    // Saving the same values again is not a change, so it is not logged.
    if (what) {
      addAudit(db, { actor, action: 'RULES_CHANGED', detail: `${actor === 'david' ? helperName : userName} changed the rules: ${what}` });
      events.emit('change', { rules: true });
    }
    const view = rulesView();
    return {
      ...view,
      changed: Boolean(what),
      spoken: what ? `Done. Your rules are updated. ${view.summary[0]}` : 'Nothing changed. Your rules are the same.',
    };
  }

  // ---------- Testing support ----------

  // Waits until all background payout checks have finished (used by tests).
  async function idle() {
    while (background.size) await Promise.all([...background]);
  }

  // The service's public functions, used by app.js, index.js and the tests.
  return {
    createRequest, confirm, cancel, get, approve, reject, helperOverview, activity,
    expireDueHolds, startTimers, resumePayoutChecks, handleWebhookEvent,
    startLink, finishLink, idle, events, getRules, updateRules,
  };
}
