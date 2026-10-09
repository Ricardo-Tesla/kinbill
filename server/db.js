// Kin-bill's small database (SQLite, built into Node; no extra install).
// Stores Grace's settings and the people she has paid before.
// The file is kinbill.db in the project folder (gitignored). Tests use ':memory:'.

import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS } from './rules/engine.js';

export function openDb(path = process.env.DB_PATH || 'kinbill.db') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),   -- one row: Grace's settings
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payees (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      times_paid INTEGER NOT NULL DEFAULT 0,
      last_paid_at TEXT
    );
  `);
  return db;
}

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

export function isKnownPayee(db, email) {
  if (!email) return false;
  const row = db.prepare('SELECT times_paid FROM payees WHERE email = ?').get(email.toLowerCase());
  return Boolean(row && row.times_paid > 0);
}

// Call after a payment actually reaches the payee.
export function recordPayment(db, { email, name }) {
  db.prepare(`
    INSERT INTO payees (email, name, times_paid, last_paid_at) VALUES (?, ?, 1, ?)
    ON CONFLICT(email) DO UPDATE SET times_paid = times_paid + 1, last_paid_at = excluded.last_paid_at, name = excluded.name
  `).run(email.toLowerCase(), name || email, new Date().toISOString());
}

export function listPayees(db) {
  return db.prepare('SELECT email, name, times_paid, last_paid_at FROM payees ORDER BY name').all();
}

function positiveNumber(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}
