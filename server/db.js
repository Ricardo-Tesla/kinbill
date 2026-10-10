// Kin-bill's small database (SQLite, built into Node; no extra install).
// Stores Grace's settings, her contacts, the saved PayPal link and every payment.
// The file is kinbill.db in the project folder (gitignored). Tests use ':memory:'.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS } from './rules/engine.js';

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
  `);
  migrate(db);
  return db;
}

// Adds columns that newer versions of Kin-bill need to an existing kinbill.db.
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has('payments', 'grace_reasons')) db.exec('ALTER TABLE payments ADD COLUMN grace_reasons TEXT');
  if (!has('payments', 'decided_by')) db.exec('ALTER TABLE payments ADD COLUMN decided_by TEXT');
  if (!has('payments', 'decided_at')) db.exec('ALTER TABLE payments ADD COLUMN decided_at TEXT');
}

// ---- Settings ----

export function getSettings(db) {
  const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
  return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.data) : {}) };
}

export function saveSettings(db, changes) {
  const allowed = Object.keys(DEFAULT_SETTINGS);
  const clean = Object.fromEntries(Object.entries(changes).filter(([k]) => allowed.includes(k)));
  if ('perPaymentLimit' in clean) clean.perPaymentLimit = positiveNumber(clean.perPaymentLimit, 'perPaymentLimit');
  if ('riskThreshold' in clean) {
    clean.riskThreshold = positiveNumber(clean.riskThreshold, 'riskThreshold');
    if (clean.riskThreshold > 100) throw new Error('riskThreshold must be between 1 and 100');
  }
  if ('askForNewPayees' in clean) clean.askForNewPayees = Boolean(clean.askForNewPayees);

  const next = { ...getSettings(db), ...clean };
  db.prepare('INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
    .run(JSON.stringify(next));
  return next;
}

// ---- Contacts ----

export function addContact(db, { name, email, timesPaid = 0 }) {
  if (!name || !email) throw new Error('name and email are required');
  const r = db.prepare('INSERT INTO contacts (name, email, times_paid) VALUES (?, ?, ?)').run(name, email.toLowerCase(), timesPaid);
  return getContact(db, Number(r.lastInsertRowid));
}

export function getContact(db, id) {
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) || null;
}

export function listContacts(db) {
  return db.prepare('SELECT * FROM contacts ORDER BY name').all();
}

// Match a spoken name ("Joe", "the plumber", "Sam") to a contact ("Joe the plumber").
export function findContactByName(db, spokenName) {
  if (!spokenName) return null;
  const n = spokenName.trim().toLowerCase();
  const contacts = listContacts(db);
  const STOP = new Set(['the', 'my', 'our', 'a', 'an', 'mr', 'mrs', 'ms']);
  const words = (s) => s.toLowerCase().split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
  const spoken = words(n);
  return contacts.find((c) => c.name.toLowerCase() === n)                          // exact
    || contacts.find((c) => words(c.name)[0] === spoken[0])                        // same first name
    || contacts.find((c) => spoken.some((w) => words(c.name).includes(w)))         // "the plumber"
    || null;
}

export function isKnownContact(contact) {
  return Boolean(contact && contact.times_paid > 0);
}

// Call after money actually reaches the contact.
export function recordPaymentToContact(db, contactId) {
  db.prepare('UPDATE contacts SET times_paid = times_paid + 1, last_paid_at = ? WHERE id = ?')
    .run(new Date().toISOString(), contactId);
}

// Demo contacts, added once when the database is empty.
export function seedDemoContacts(db, joeEmail) {
  if (!joeEmail || listContacts(db).length) return;
  addContact(db, { name: 'Joe the plumber', email: joeEmail, timesPaid: 1 });  // paid before
  addContact(db, { name: 'Sam the gardener', email: joeEmail, timesPaid: 0 }); // never paid
}

// ---- Saved PayPal link (vault id) ----

export function getAccountValue(db, key) {
  return db.prepare('SELECT value FROM account WHERE key = ?').get(key)?.value ?? null;
}

export function setAccountValue(db, key, value) {
  db.prepare('INSERT INTO account (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function getVaultId(db) {
  return getAccountValue(db, 'vault_id');
}

// If the feature-3 test script saved a link in .kinbill-vault.json, reuse it.
export function importLegacyVault(db, file = '.kinbill-vault.json') {
  if (getVaultId(db)) return false;
  try {
    const { vaultId } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (vaultId) { setAccountValue(db, 'vault_id', vaultId); return true; }
  } catch { /* no file: nothing to import */ }
  return false;
}

// ---- Payments ----

const JSON_FIELDS = ['triggers', 'reasons', 'grace_reasons'];

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

export function getPayment(db, id) {
  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!row) return null;
  for (const f of JSON_FIELDS) row[f] = row[f] ? JSON.parse(row[f]) : [];
  return { ...row };
}

export function updatePayment(db, id, changes) {
  const allowed = ['status', 'order_id', 'authorization_id', 'capture_id', 'payout_batch_id', 'hold_expires_at',
    'decided_by', 'decided_at', 'contact_id', 'error'];
  const keys = Object.keys(changes).filter((k) => allowed.includes(k));
  if (!keys.length) return getPayment(db, id);
  db.prepare(`UPDATE payments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => changes[k]), new Date().toISOString(), id);
  return getPayment(db, id);
}

export function listPayments(db, { status, limit = 200 } = {}) {
  const rows = status
    ? db.prepare('SELECT id FROM payments WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT id FROM payments ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => getPayment(db, r.id));
}

export function findContactByEmail(db, email) {
  return db.prepare('SELECT * FROM contacts WHERE email = ?').get(String(email).toLowerCase()) || null;
}

function positiveNumber(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}
