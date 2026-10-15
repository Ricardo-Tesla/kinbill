// Database: Kin-bill's small store, using SQLite built into Node (no extra install).
// Stores Grace's settings, her contacts, the saved PayPal link, every payment,
// the activity log and the PayPal webhook events already handled.
// Kin-bill only ever pays people in the contacts table.
// The file is kinbill.db in the project folder (gitignored). Tests use ':memory:'.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS } from './rules/engine.js';

// ---------- Opening the database ----------

/**
 * Opens (or creates) the database and makes sure every table exists.
 * @param {string} [path]  file path, or ':memory:' for tests (default: DB_PATH or kinbill.db)
 * @returns {DatabaseSync} the open database
 */
export function openDb(path = process.env.DB_PATH || 'kinbill.db') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),   -- one row: Grace's settings
      data TEXT NOT NULL
    );
    -- Grace's contacts. Kin-bill only ever pays people on this list.
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,          -- their PayPal email
      times_paid INTEGER NOT NULL DEFAULT 0,
      last_paid_at TEXT
    );
    -- Small key/value store, e.g. the saved PayPal link (vault id).
    CREATE TABLE IF NOT EXISTS account (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    -- Every payment Grace asks for, and what happened to it.
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      said TEXT NOT NULL,             -- what Grace said
      payee_name TEXT NOT NULL,       -- name as understood
      contact_id INTEGER,             -- matched contact (null = not in contacts)
      amount REAL NOT NULL,
      risk_score INTEGER,
      triggers TEXT,                  -- JSON list
      ai_source TEXT,
      spoken_summary TEXT,            -- what the AI wants Grace to hear
      helper_explanation TEXT,        -- what David reads
      decision TEXT NOT NULL,         -- PAY_NOW | ASK_HELPER
      reasons TEXT,                   -- JSON list of plain-English reasons (for David)
      grace_reasons TEXT,             -- JSON list of gentle reasons (for Grace)
      status TEXT NOT NULL,           -- see payments/service.js
      order_id TEXT,
      authorization_id TEXT,
      capture_id TEXT,
      payout_batch_id TEXT,
      hold_expires_at TEXT,
      decided_by TEXT,                -- who approved/rejected a held payment (helper | timer)
      decided_at TEXT,
      error TEXT
    );
    -- Everything that happens to a payment, in order: who did what, and when.
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      payment_id INTEGER,
      actor TEXT NOT NULL,      -- grace | david | ai | kinbill | paypal | timer
      action TEXT NOT NULL,     -- short code, e.g. HELD, APPROVED
      detail TEXT
    );
    -- PayPal webhook events already handled (PayPal may send the same event twice).
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL,
      event_type TEXT
    );
  `);
  migrate(db);
  return db;
}

// Adds the columns newer versions of Kin-bill need to an older kinbill.db.
// CREATE TABLE IF NOT EXISTS never changes a table that already exists, hence this step.
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has('payments', 'grace_reasons')) db.exec('ALTER TABLE payments ADD COLUMN grace_reasons TEXT');
  if (!has('payments', 'decided_by')) db.exec('ALTER TABLE payments ADD COLUMN decided_by TEXT');
  if (!has('payments', 'decided_at')) db.exec('ALTER TABLE payments ADD COLUMN decided_at TEXT');
}

// ---------- Settings ----------

/**
 * Reads Grace's settings, using the defaults for anything not saved yet.
 * @returns {object} { perPaymentLimit, riskThreshold, askForNewPayees }
 */
export function getSettings(db) {
  const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
  return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.data) : {}) };
}

/**
 * Keeps only known settings and checks their values.
 * Throws a clear error if a value is wrong.
 * @param {object} changes  settings sent by a screen
 * @returns {object} the valid settings, with numbers and booleans in the right type
 */
export function cleanSettings(changes = {}) {
  const allowed = Object.keys(DEFAULT_SETTINGS);
  const clean = Object.fromEntries(Object.entries(changes).filter(([k]) => allowed.includes(k)));
  if ('perPaymentLimit' in clean) {
    clean.perPaymentLimit = Math.round(positiveNumber(clean.perPaymentLimit, 'perPaymentLimit') * 100) / 100;
    if (clean.perPaymentLimit > 10000) throw new Error('perPaymentLimit must be 10000 or less');
  }
  if ('riskThreshold' in clean) {
    clean.riskThreshold = positiveNumber(clean.riskThreshold, 'riskThreshold');
    if (clean.riskThreshold > 100) throw new Error('riskThreshold must be between 1 and 100');
  }
  // Form values may arrive as the text 'true'; anything else means no.
  if ('askForNewPayees' in clean) clean.askForNewPayees = clean.askForNewPayees === true || clean.askForNewPayees === 'true';
  return clean;
}

/**
 * Checks the changes and merges them into the saved settings.
 * It does not check who may loosen the rules; the payment service does that first.
 * @returns {object} the full settings after saving
 */
export function saveSettings(db, changes) {
  const clean = cleanSettings(changes);
  const next = { ...getSettings(db), ...clean };
  db.prepare('INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
    .run(JSON.stringify(next));
  return next;
}

// ---------- Contacts ----------

/**
 * Adds a person to Grace's contacts.
 * The email is stored in lower case so later lookups by email always match.
 * @param {object} contact  { name, email, timesPaid? }
 * @returns {object} the new contact row
 */
export function addContact(db, { name, email, timesPaid = 0 }) {
  if (!name || !email) throw new Error('name and email are required');
  const r = db.prepare('INSERT INTO contacts (name, email, times_paid) VALUES (?, ?, ?)').run(name, email.toLowerCase(), timesPaid);
  return getContact(db, Number(r.lastInsertRowid));
}

// One contact by id, or null.
export function getContact(db, id) {
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) || null;
}

// All contacts, sorted by name.
export function listContacts(db) {
  return db.prepare('SELECT * FROM contacts ORDER BY name').all();
}

/**
 * Matches a spoken name ("Joe", "the plumber", "Sam") to a contact ("Joe the plumber").
 * Tries an exact match, then the same first name, then any shared word.
 * @param {string} spokenName  the payee name as the AI understood it
 * @returns {object|null} the matching contact, or null if nobody matches
 */
export function findContactByName(db, spokenName) {
  if (!spokenName) return null;
  const n = spokenName.trim().toLowerCase();
  const contacts = listContacts(db);
  // Filler words that would match almost any contact, so they are ignored.
  const STOP = new Set(['the', 'my', 'our', 'a', 'an', 'mr', 'mrs', 'ms']);
  const words = (s) => s.toLowerCase().split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
  const spoken = words(n);
  return contacts.find((c) => c.name.toLowerCase() === n)                          // exact
    || contacts.find((c) => words(c.name)[0] === spoken[0])                        // same first name
    || contacts.find((c) => spoken.some((w) => words(c.name).includes(w)))         // "the plumber"
    || null;
}

// A contact counts as known only after Kin-bill has paid them at least once.
export function isKnownContact(contact) {
  return Boolean(contact && contact.times_paid > 0);
}

// Counts a payment to a contact. Call only after the money has actually reached them.
export function recordPaymentToContact(db, contactId) {
  db.prepare('UPDATE contacts SET times_paid = times_paid + 1, last_paid_at = ? WHERE id = ?')
    .run(new Date().toISOString(), contactId);
}

// Adds the demo contacts once, when there are no contacts yet.
// Both use the same sandbox payee email; Sam has never been paid, so he counts as new.
export function seedDemoContacts(db, joeEmail) {
  if (!joeEmail || listContacts(db).length) return;
  addContact(db, { name: 'Joe the plumber', email: joeEmail, timesPaid: 1 });  // paid before
  addContact(db, { name: 'Sam the gardener', email: joeEmail, timesPaid: 0 }); // never paid
}

// ---------- Saved PayPal link (vault id) ----------

// Reads one value from the account key/value store, or null.
export function getAccountValue(db, key) {
  return db.prepare('SELECT value FROM account WHERE key = ?').get(key)?.value ?? null;
}

// Saves one value in the account key/value store, replacing any old value.
export function setAccountValue(db, key, value) {
  db.prepare('INSERT INTO account (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

// Grace's saved PayPal link (vault id), or null if she has not linked her PayPal yet.
export function getVaultId(db) {
  return getAccountValue(db, 'vault_id');
}

/**
 * Reuses a PayPal link saved by the feature-3 test script in .kinbill-vault.json.
 * An existing link in the database is never replaced.
 * @returns {boolean} true if a link was imported
 */
export function importLegacyVault(db, file = '.kinbill-vault.json') {
  if (getVaultId(db)) return false;
  try {
    const { vaultId } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (vaultId) { setAccountValue(db, 'vault_id', vaultId); return true; }
  } catch { /* no file: nothing to import */ }
  return false;
}

/**
 * Restores Grace's saved PayPal link from KINBILL_VAULT_ID.
 * Used on the hosted demo, where the database file is not kept between restarts.
 * @returns {boolean} true if a link was imported
 */
export function importVaultFromEnv(db, vaultId) {
  if (!vaultId || getVaultId(db)) return false;
  setAccountValue(db, 'vault_id', vaultId);
  return true;
}

// ---------- Demo history (KINBILL_DEMO=1) ----------
// Example payments, so the judges see full tables straight away.

/**
 * Adds three example payments (paid, rejected, expired) with their activity log.
 * Runs only on an empty database, so examples are never mixed with real payments.
 * @param {object} [names]  { userName, helperName } used in the example wording
 * @returns {boolean} true if the examples were added
 */
export function seedDemoHistory(db, { userName = 'Grace', helperName = 'David' } = {}) {
  if (db.prepare('SELECT COUNT(*) AS n FROM payments').get().n > 0) return false;
  const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const examples = [
    { at: 50, said: 'Pay my plumber Joe 80 dollars for fixing the sink', payee_name: 'Joe the plumber', amount: 80, risk_score: 5,
      decision: 'PAY_NOW', status: 'PAID', reasons: [], log: [['grace', 'ASKED', 'Pay Joe the plumber $80'], ['ai', 'CHECKED', 'Risk 5/100: a known contact, normal amount'],
        ['kinbill', 'RULES_PAY_NOW', 'Known contact, under the limit, low risk'], ['paypal', 'DELIVERED', 'Joe the plumber received $80']] },
    { at: 26, said: 'A man from PayPal called, my account is locked and I must send 600 dollars today to unlock it', payee_name: 'PayPal security',
      amount: 600, risk_score: 95, decision: 'ASK_HELPER', status: 'REJECTED', decided_by: 'helper',
      reasons: ['someone who may be pretending to be a company, official or family member', 'pressure to pay quickly', 'not in Grace\'s contacts'],
      log: [['grace', 'ASKED', 'Pay "PayPal security" $600'], ['ai', 'CHECKED', 'Risk 95/100: impersonation and urgency'],
        ['kinbill', 'HELD', `$600 held; waiting for ${helperName}`], ['david', 'REJECTED', `${helperName} rejected it; the hold was cancelled, no money moved`]] },
    { at: 5, said: 'Pay the corner pharmacy 25 dollars', payee_name: 'Corner pharmacy', amount: 25, risk_score: 30, decision: 'ASK_HELPER',
      status: 'EXPIRED', decided_by: 'timer', reasons: [`not in ${userName}'s contacts`],
      log: [['grace', 'ASKED', 'Pay Corner pharmacy $25'], ['kinbill', 'HELD', `$25 held; waiting for ${helperName}`],
        ['timer', 'EXPIRED', 'Nobody decided in time, so the hold was cancelled; no money moved']] },
  ];
  for (const e of examples) {
    const p = insertPayment(db, { ...e, ai_source: 'demo', triggers: [] });
    // insertPayment stamps the current time, so move each example back to its own time.
    const when = hoursAgo(e.at);
    db.prepare('UPDATE payments SET created_at = ?, updated_at = ?, decided_by = ?, decided_at = ? WHERE id = ?')
      .run(when, when, e.decided_by ?? null, e.decided_by ? when : null, p.id);
    // Log lines one minute apart, so they read in order; each is marked "(example)".
    e.log.forEach(([actor, action, detail], i) => {
      db.prepare('INSERT INTO audit_log (at, payment_id, actor, action, detail) VALUES (?, ?, ?, ?, ?)')
        .run(new Date(Date.parse(when) + i * 60e3).toISOString(), p.id, actor, action, `${detail} (example)`);
    });
  }
  return true;
}

// ---------- Payments ----------

// Columns stored as JSON text and returned as arrays.
const JSON_FIELDS = ['triggers', 'reasons', 'grace_reasons'];

/**
 * Stores a new payment request.
 * @param {object} p  payment fields (said, payee_name, amount, decision, status, ...)
 * @returns {object} the new payment row
 */
export function insertPayment(db, p) {
  const now = new Date().toISOString();
  const r = db.prepare(`
    INSERT INTO payments (created_at, updated_at, said, payee_name, contact_id, amount, risk_score, triggers,
      ai_source, spoken_summary, helper_explanation, decision, reasons, grace_reasons, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(now, now, p.said, p.payee_name, p.contact_id ?? null, p.amount, p.risk_score ?? null,
    JSON.stringify(p.triggers || []), p.ai_source ?? null, p.spoken_summary ?? null, p.helper_explanation ?? null,
    p.decision, JSON.stringify(p.reasons || []), JSON.stringify(p.grace_reasons || []), p.status);
  return getPayment(db, Number(r.lastInsertRowid));
}

// One payment with its JSON columns turned back into arrays, or null.
export function getPayment(db, id) {
  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!row) return null;
  for (const f of JSON_FIELDS) row[f] = row[f] ? JSON.parse(row[f]) : [];
  return { ...row }; // a plain object: node:sqlite rows have no prototype
}

/**
 * Updates a payment's PayPal ids, status and outcome. Other fields are ignored.
 * @param {number} id
 * @param {object} changes  column -> new value
 * @returns {object|null} the updated payment row
 */
export function updatePayment(db, id, changes) {
  // Column names go into the SQL text, so only names from this list are allowed.
  const allowed = ['status', 'order_id', 'authorization_id', 'capture_id', 'payout_batch_id', 'hold_expires_at',
    'decided_by', 'decided_at', 'contact_id', 'error'];
  const keys = Object.keys(changes).filter((k) => allowed.includes(k));
  if (!keys.length) return getPayment(db, id);
  db.prepare(`UPDATE payments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => changes[k]), new Date().toISOString(), id);
  return getPayment(db, id);
}

/**
 * Lists payments, newest first.
 * @param {object} [opts]
 * @param {string} [opts.status]  only payments with this status
 * @param {number} [opts.limit]   at most this many (default 200)
 * @returns {object[]} payment rows
 */
export function listPayments(db, { status, limit = 200 } = {}) {
  const rows = status
    ? db.prepare('SELECT id FROM payments WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT id FROM payments ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => getPayment(db, r.id));
}

// The contact with this PayPal email (any letter case), or null.
export function findContactByEmail(db, email) {
  return db.prepare('SELECT * FROM contacts WHERE email = ?').get(String(email).toLowerCase()) || null;
}

/**
 * Finds the latest payment with one of PayPal's ids (used by webhooks and restarts).
 * @param {string} field  'authorization_id', 'capture_id', 'payout_batch_id' or 'order_id'
 * @param {string} value  the PayPal id
 * @returns {object|null} the payment, or null if none matches
 */
export function findPaymentBy(db, field, value) {
  // The field name goes into the SQL text, so only these columns are allowed.
  const allowed = ['authorization_id', 'capture_id', 'payout_batch_id', 'order_id'];
  if (!allowed.includes(field) || !value) return null;
  const row = db.prepare(`SELECT id FROM payments WHERE ${field} = ? ORDER BY id DESC LIMIT 1`).get(value);
  return row ? getPayment(db, row.id) : null;
}

// Held payments whose time is up. ISO time strings sort in time order, so comparing them as text works.
export function listExpiredHolds(db, now = new Date()) {
  return db.prepare("SELECT id FROM payments WHERE status = 'HELD' AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?")
    .all(now.toISOString()).map((r) => getPayment(db, r.id));
}

// ---------- Activity log ----------

/**
 * Adds one line to the activity log.
 * @param {object} entry
 * @param {number|null} [entry.paymentId]  payment it belongs to (null for rule changes and stray webhooks)
 * @param {string} entry.actor   grace | david | ai | kinbill | paypal | timer
 * @param {string} entry.action  short code, e.g. HELD, APPROVED
 * @param {string} [entry.detail]  plain-English details
 */
export function addAudit(db, { paymentId = null, actor, action, detail = '' }) {
  db.prepare('INSERT INTO audit_log (at, payment_id, actor, action, detail) VALUES (?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), paymentId, actor, action, detail);
}

// One payment's log in the order it happened, or the latest entries for everything (newest first).
export function listAudit(db, { paymentId, limit = 300 } = {}) {
  return paymentId
    ? db.prepare('SELECT * FROM audit_log WHERE payment_id = ? ORDER BY id ASC').all(paymentId).map((r) => ({ ...r }))
    : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ ...r }));
}

// Records a PayPal webhook event. Returns true the first time an event id is seen, false for repeats.
export function markWebhookEvent(db, id, type) {
  const r = db.prepare('INSERT OR IGNORE INTO webhook_events (id, received_at, event_type) VALUES (?, ?, ?)')
    .run(id, new Date().toISOString(), type);
  return r.changes > 0;
}

// ---------- Helpers ----------

// Converts a value to a number and throws a clear error unless it is above zero.
function positiveNumber(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}
