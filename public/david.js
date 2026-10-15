// David's helper screen: see payments waiting for him, with the reasons, and approve or reject them.
// The screen is locked behind a PIN, which is remembered only for this browser tab.
// Updates arrive live via Server-Sent Events, falling back to checking every 10 seconds.
// History and the activity log use AG Grid tables, with a plain fallback if AG Grid does not load.
// New payments and results are announced to screen readers through a live region.

// Short helper to find an element by id.
const $ = (id) => document.getElementById(id);
// Every element the script uses, looked up once.
const els = {
  hello: $('hello'), gate: $('pin-gate'), pinForm: $('pin-form'), pin: $('pin'), pinError: $('pin-error'),
  main: $('dashboard'), heldList: $('held-list'), nothing: $('nothing-waiting'), count: $('waiting-count'),
  liveState: $('live-state'), grid: $('history-grid'), live: $('live'), template: $('held-template'),
  activityGrid: $('activity-grid'),
};

// Plain words for each payment status, shown in the history table.
const STATUS_LABELS = {
  AWAITING_CONFIRMATION: 'Grace is confirming',
  PAYING: 'Paying...',
  PAID: 'Paid',
  HELD: 'Waiting for you',
  REJECTED: 'Rejected (no money moved)',
  CANCELLED: 'Cancelled by Grace',
  EXPIRED: 'Auto-cancelled (no answer)',
  FAILED: 'Failed (nothing sent)',
  PAYOUT_FAILED: 'Payout failed',
};

let pin = '';              // sent with every request; empty until David enters it
let gridApi = null;        // history table, created once and then only given new rows
let activityApi = null;    // activity log table, same idea

// Plain words for the "Who" and "What" columns of the activity log.
const WHO = { grace: 'Grace', david: 'David', ai: 'AI check', kinbill: 'Kin-bill', paypal: 'PayPal', timer: 'Safety timer' };
const WHAT = {
  ASKED: 'Asked to pay', CHECKED: 'Checked for scams', RULES_PAY_NOW: 'Rules: pay now', RULES_ASK_HELPER: 'Rules: ask David',
  CANCELLED: 'Cancelled', CHARGED: 'Charged', HELD: 'Held for David', PAYOUT_SENT: 'Sent on', DELIVERED: 'Delivered',
  APPROVED: 'Approved', REJECTED: 'Rejected', EXPIRED: 'Auto-cancelled', CONTACT_ADDED: 'Contact added',
  FAILED: 'Failed', PAYOUT_FAILED: 'Payout failed', CAPTURE_FAILED: 'Capture failed', EXPIRE_RETRY: 'Retrying cancel',
  CONFIRMED_VOIDED: 'PayPal confirmed cancel', CONFIRMED_CAPTURED: 'PayPal confirmed capture', WEBHOOK: 'PayPal message',
  RULES_CHANGED: 'Rules changed', RULES_BLOCKED: 'Tried to loosen rules',
};
let knownHeldIds = new Set();   // held payments already shown, to spot new arrivals
let heldLoaded = false;   // after the first load, new arrivals are animated and announced
let pollTimer = null;     // set only while polling instead of live updates

// ---------- Small helpers ----------

// Runs fn with sessionStorage, which can throw (private mode, blocked storage); returns null then.
// sessionStorage is used on purpose: the PIN is forgotten when the tab is closed.
function storage(fn) { try { return fn(window.sessionStorage); } catch { return null; } }
// Formats a number as dollars, e.g. $80.00.
const money = (n) => `$${Number(n).toFixed(2)}`;
// Short date and time in David's own locale, or '' when there is no time.
function when(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Describes how long until a held payment is cancelled automatically.
 * @param {string} iso  when the hold expires
 * @returns {string} a sentence for David, or '' when there is no expiry time
 */
function timeLeft(iso) {
  if (!iso) return '';
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'The hold time is up; it will be cancelled automatically.';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `If you do nothing, it is cancelled automatically in ${h ? `${h} h ` : ''}${m} min. No money moves until you approve.`;
}
// Puts text in the screen-reader live region.
function announce(text) {
  els.live.textContent = '';
  // Clearing first and waiting a moment makes screen readers announce a message even if it repeats.
  setTimeout(() => { els.live.textContent = text; }, 50);
}

/**
 * Calls the Kin-bill server with David's PIN: GET without a body, POST with one.
 * @param {string} path  API path, e.g. '/api/helper/overview'
 * @param {object} [body]  JSON body to POST
 * @returns {Promise<object>} the JSON reply; throws an Error with code and HTTP status on failure
 */
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-helper-pin': pin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { code: data.code, status: res.status });
  return data;
}

// ---------- PIN ----------

/**
 * Checks a PIN with the server and, if it is right, opens the dashboard.
 * @param {string} candidate  the PIN to try
 * @returns {Promise<boolean>} true if accepted, false if wrong; other errors (such as too many tries) are thrown
 */
async function tryPin(candidate) {
  pin = candidate;
  try {
    const who = await api('/api/helper/check');
    // Kept for this tab only, so a reload does not ask again but closing the tab forgets it.
    storage((s) => s.setItem('kinbill-helper-pin', candidate));
    els.hello.textContent = `Hello, ${who.helperName}. You are helping ${who.userName}.`;
    els.gate.classList.add('hidden');
    els.main.classList.remove('hidden');
    return true;
  } catch (err) {
    if (err.status === 401) return false;
    throw err;
  }
}

// PIN form: try the PIN, then open the dashboard or explain what went wrong.
els.pinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.pinError.textContent = '';
  try {
    if (await tryPin(els.pin.value.trim())) start();
    else els.pinError.textContent = 'That PIN is not right. Please try again.';
  } catch (err) {
    els.pinError.textContent = err.message;  // e.g. too many wrong PINs: wait 15 minutes
  }
});

// ---------- Waiting payments (cards) ----------

/**
 * Draws a card for each payment waiting for David, and announces any new ones.
 * @param {object[]} held  held payments from the server
 */
function renderHeld(held) {
  const cards = held.map(heldCard);
  // A payment that just arrived slides in (not on the first load).
  held.forEach((p, i) => { if (heldLoaded && !knownHeldIds.has(p.id)) cards[i].classList.add('enter'); });
  els.heldList.replaceChildren(...cards);
  els.nothing.classList.toggle('hidden', held.length > 0);
  const before = Number(els.count.textContent) || 0;
  els.count.textContent = held.length ? String(held.length) : '';
  if (held.length > before && heldLoaded) {
    // Reading offsetWidth forces a reflow, so the "bump" animation plays again.
    els.count.classList.remove('bump'); void els.count.offsetWidth; els.count.classList.add('bump');
  }
  // The tab title shows the waiting count, so David can notice it from another tab.
  document.title = held.length ? `(${held.length}) Kin-bill: helper` : 'Kin-bill: helper';

  // Announce new arrivals only; payments already there on the first load are not news.
  const newOnes = held.filter((p) => !knownHeldIds.has(p.id));
  if (heldLoaded && newOnes.length) {
    announce(`New payment waiting: ${newOnes[0].helperPayeeName || newOnes[0].payeeName}, ${money(newOnes[0].amount)}.`);
  }
  knownHeldIds = new Set(held.map((p) => p.id));
  heldLoaded = true;
}

/**
 * Builds the card for one held payment from the HTML template, with working Approve and Reject buttons.
 * @param {object} p  a held payment from the server
 * @returns {HTMLElement} the card
 */
function heldCard(p) {
  const node = els.template.content.firstElementChild.cloneNode(true);
  const q = (sel) => node.querySelector(sel);
  q('.held-amount').textContent = money(p.amount);
  const who = p.helperPayeeName || p.payeeName;
  q('.held-payee').textContent = `to ${who}${p.inContacts ? '' : ' (not in Grace\'s contacts)'}`;
  q('.held-said').textContent = `Grace said: "${p.said}"`;
  q('.held-ai').textContent = p.helperExplanation || '';
  const risk = q('.risk');
  q('.risk-score').textContent = p.riskScore ?? '?';
  risk.classList.add(p.riskScore >= 70 ? 'high' : p.riskScore >= 40 ? 'medium' : 'low');
  q('.held-reasons').replaceChildren(...(p.reasons || []).map((r) => Object.assign(document.createElement('li'), { textContent: r })));
  q('.held-meta').textContent = `Asked ${when(p.createdAt)}. Checked by: ${p.aiSource || 'unknown'}. ${timeLeft(p.holdExpiresAt)}`;

  // Kin-bill only pays people in Grace's contacts, so an unknown payee needs a PayPal email first.
  const emailBox = q('.contact-needed');
  const email = q('.email-input');
  emailBox.classList.toggle('hidden', p.inContacts);
  const approve = q('.approve');
  const reject = q('.reject');
  const error = q('.held-error');
  const approveText = p.inContacts ? `Approve and pay ${money(p.amount)}` : 'Add to contacts and pay';
  approve.textContent = approveText;
  // Screen-reader names start with the visible words (so voice control "click Approve" works)
  // and add who it is for, because there can be several cards.
  approve.setAttribute('aria-label', `${approveText} to ${who}`);
  reject.setAttribute('aria-label', `Reject, keep the money: ${money(p.amount)} to ${who}`);
  // Give the card an accessible name, such as "$40.00 to an unknown person".
  const headingId = `held-${p.id}`;
  q('.held-amount').id = headingId;
  q('.held-payee').id = `${headingId}-payee`;
  node.setAttribute('aria-labelledby', `${headingId} ${headingId}-payee`);
  // Link the error message to the email box so screen readers read them together.
  const errorId = `held-error-${p.id}`;
  error.id = errorId;
  email.setAttribute('aria-describedby', errorId);

  // Approve: check the email if one is needed, ask once more, then capture the hold and pay.
  approve.addEventListener('click', async () => {
    error.textContent = '';
    if (!p.inContacts && (!email.value.trim() || !email.checkValidity())) {
      error.textContent = email.value.trim()
        ? 'That does not look like an email address. Please check it.'
        : 'Please enter their PayPal email first, or reject the payment.';
      email.setAttribute('aria-invalid', 'true');
      email.focus();
      return;
    }
    email.removeAttribute('aria-invalid');
    // A second check, because this step moves money.
    if (!window.confirm(`Pay ${money(p.amount)} to ${who}? This sends the money.`)) return;
    // Disable both buttons so a double click cannot send two decisions.
    approve.disabled = reject.disabled = true;
    approve.textContent = 'Paying...';
    try {
      await api(`/api/helper/payments/${p.id}/approve`, { email: email.value.trim() });
      announce(`Approved. ${money(p.amount)} is on its way to ${who}.`);
      await refresh();
    } catch (err) {
      error.textContent = err.message;
      approve.disabled = reject.disabled = false;
      approve.textContent = approveText;
    }
  });

  // Reject: ask once more, then cancel (void) the hold so no money moves.
  reject.addEventListener('click', async () => {
    error.textContent = '';
    if (!window.confirm(`Reject this payment of ${money(p.amount)}? The hold is cancelled and no money moves.`)) return;
    approve.disabled = reject.disabled = true;
    reject.textContent = 'Cancelling...';
    try {
      await api(`/api/helper/payments/${p.id}/reject`, {});
      announce('Rejected. No money moved.');
      await refresh();
    } catch (err) {
      error.textContent = err.message;
      approve.disabled = reject.disabled = false;
      reject.textContent = 'Reject, keep the money';
    }
  });

  return node;
}

// ---------- History table (AG Grid, with a plain-table fallback) ----------

// AG Grid's advice for screen readers: keep rows and columns in the page in reading order,
// and render all columns (not only the visible ones). Taller rows are easier to read and click.
const GRID_A11Y = { ensureDomOrder: true, suppressColumnVirtualisation: true, rowHeight: 44, enableCellTextSelection: true, domLayout: 'autoHeight' };

/**
 * Builds AG Grid's Quartz theme in Kin-bill colours, with a light and a dark version.
 * theme.js sets data-ag-theme-mode on the page, so the tables switch with the rest of the screen.
 * AG Grid takes plain colour values here, so they mirror the colours in styles.css.
 * @returns {object|undefined} the theme, or undefined if AG Grid did not load
 */
function gridTheme() {
  const quartz = window.agGrid?.themeQuartz;
  if (!quartz) return undefined;
  const shared = { fontFamily: 'inherit', fontSize: 16, headerFontWeight: 700, wrapperBorderRadius: 14, spacing: 7 };
  return quartz
    .withParams({ ...shared, browserColorScheme: 'light', backgroundColor: '#FFFFFF', foregroundColor: '#001C64',
      headerBackgroundColor: '#0070BA', headerTextColor: '#FFFFFF', borderColor: '#CBD2D6', accentColor: '#0070BA',
      oddRowBackgroundColor: '#F8FAFC', chromeBackgroundColor: '#F5F7FA' })
    .withParams({ ...shared, browserColorScheme: 'dark', backgroundColor: '#0E1C47', foregroundColor: '#F3F6FC',
      headerBackgroundColor: '#0070BA', headerTextColor: '#FFFFFF', borderColor: '#273A70', accentColor: '#009CDE',
      oddRowBackgroundColor: '#112152', chromeBackgroundColor: '#0E1C47' }, 'dark');
}
const THEME = gridTheme();
// Cell style for the Status column (waiting, bad or ok). The words stay visible, so colour is never the only signal.
const STATUS_CLASS = (x) => (/Waiting|Paying|confirming/.test(x.value) ? 'st-wait'
  : /Rejected|Auto|Failed|failed|Cancelled/.test(x.value) ? 'st-bad' : 'st-ok');

/**
 * Turns payments from the server into rows for the history table, using plain words.
 * @param {object[]} history  past and current payments
 * @returns {object[]} one row per payment
 */
function historyRows(history) {
  return history.map((p) => ({
    when: when(p.createdAt),
    payee: p.helperPayeeName || p.payeeName,
    amount: Number(p.amount),
    status: STATUS_LABELS[p.status] || p.status,
    risk: p.riskScore,
    route: p.decision === 'PAY_NOW' ? 'Paid straight away' : 'Asked David',
    decidedBy: p.decidedBy === 'helper' ? 'David' : p.decidedBy === 'timer' ? 'Timer' : '',
    checkedBy: p.aiSource,
    said: p.said,
  }));
}

/**
 * Shows the payment history in an AG Grid table, or in a plain table if AG Grid did not load.
 * @param {object[]} history  past and current payments
 */
function renderHistory(history) {
  const rows = historyRows(history);
  if (window.agGrid?.createGrid) {
    // Create the grid once, then only replace its rows, so David's sorting, filters and page stay as they were.
    if (!gridApi) {
      gridApi = window.agGrid.createGrid(els.grid, {
        rowData: rows,
        columnDefs: [
          { field: 'when', headerName: 'When', width: 140 },
          { field: 'payee', headerName: 'To', flex: 1, minWidth: 150 },
          { field: 'amount', headerName: 'Amount', width: 110, valueFormatter: (x) => money(x.value) },
          { field: 'status', headerName: 'Status', flex: 1, minWidth: 170, cellClass: STATUS_CLASS },
          { field: 'risk', headerName: 'Risk', width: 90 },
          { field: 'route', headerName: 'Route', width: 160 },
          { field: 'decidedBy', headerName: 'Decided by', width: 120 },
          { field: 'checkedBy', headerName: 'Checked by', width: 120 },
          { field: 'said', headerName: 'What Grace said', flex: 2, minWidth: 260, tooltipField: 'said' },
        ],
        defaultColDef: { sortable: true, filter: true, resizable: true },
        ...GRID_A11Y,
        ...(THEME ? { theme: THEME } : {}),
        pagination: true,
        paginationPageSize: 20,
        paginationPageSizeSelector: [10, 20, 50],
        overlayNoRowsTemplate: 'No payments yet.',
      });
    } else {
      gridApi.setGridOption('rowData', rows);
    }
    return;
  }
  // Fallback if AG Grid could not load: a simple accessible table.
  const table = document.createElement('table');
  table.className = 'simple-table';
  table.innerHTML = '<thead><tr><th>When</th><th>To</th><th>Amount</th><th>Status</th><th>Risk</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const v of [r.when, r.payee, money(r.amount), r.status, r.risk ?? '']) {
      tr.appendChild(Object.assign(document.createElement('td'), { textContent: v }));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  els.grid.style.height = 'auto';
  els.grid.replaceChildren(table);
}

// ---------- Activity log (AG Grid) ----------

/**
 * Shows the audit log (who did what, and when) in an AG Grid table, or as plain text if AG Grid did not load.
 * @param {object[]} entries  audit log entries from the server
 */
function renderActivity(entries) {
  const rows = entries.map((a) => ({
    when: new Date(a.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    payment: a.payment_id ? `#${a.payment_id}` : '',
    who: WHO[a.actor] || a.actor,
    what: WHAT[a.action] || a.action,
    detail: a.detail,
  }));
  // Fallback if AG Grid could not load: one line of text per entry.
  if (!window.agGrid?.createGrid) {
    els.activityGrid.style.height = 'auto';
    els.activityGrid.textContent = rows.map((r) => `${r.when}  ${r.payment}  ${r.who}: ${r.what}. ${r.detail}`).join('\n');
    return;
  }
  // As with the history table: create once, then only replace the rows.
  if (activityApi) return activityApi.setGridOption('rowData', rows);
  activityApi = window.agGrid.createGrid(els.activityGrid, {
    rowData: rows,
    columnDefs: [
      { field: 'when', headerName: 'When', width: 170 },
      { field: 'payment', headerName: 'Payment', width: 110 },
      { field: 'who', headerName: 'Who', width: 130 },
      { field: 'what', headerName: 'What', width: 190, cellStyle: { fontWeight: 700 } },
      { field: 'detail', headerName: 'Details', flex: 1, minWidth: 300, tooltipField: 'detail' },
    ],
    defaultColDef: { sortable: true, filter: true, resizable: true },
    ...GRID_A11Y,
    ...(THEME ? { theme: THEME } : {}),
    pagination: true,
    paginationPageSize: 20,
    paginationPageSizeSelector: [20, 50, 100],
    overlayNoRowsTemplate: 'Nothing has happened yet.',
  });
}

// ---------- Loading ----------

/**
 * Loads held payments, history, the activity log and Grace's rules together, then redraws everything.
 */
async function refresh() {
  const [{ held, history }, activity, rules] = await Promise.all([
    api('/api/helper/overview'), api('/api/helper/activity'), api('/api/settings'),
  ]);
  renderHeld(held);
  renderHistory(history);
  renderActivity(activity);
  renderRules(rules, activity);
}

// ---------- Grace's safety rules ----------

const rulesForm = $('rules-form');
const rulesMessage = $('rules-message');
const rulesAlert = $('rules-alert');
let rulesShown = null;      // settings last put in the form, so it is only redrawn when they change
let lastBlockedId = null;  // last warning seen; null until the first load, so old warnings are not announced

/**
 * Fills the rules form with Grace's current rules, and shows a warning if she recently tried to loosen them.
 * @param {object} r  rules from the server (r.settings holds the values)
 * @param {object[]} [activity]  recent audit log entries, searched for blocked changes
 */
function renderRules(r, activity = []) {
  const s = r.settings;
  // Don't overwrite the form while David is typing in it.
  if (!rulesForm.contains(document.activeElement) && JSON.stringify(s) !== JSON.stringify(rulesShown)) {
    rulesForm.perPaymentLimit.value = s.perPaymentLimit;
    const select = rulesForm.riskThreshold;
    // The saved number may not be one of the list's options: add it, so the form shows the real value.
    if (![...select.options].some((o) => Number(o.value) === s.riskThreshold)) {
      select.add(new Option(`${s.riskThreshold}: custom`, String(s.riskThreshold)));
    }
    select.value = String(s.riskThreshold);
    rulesForm.askForNewPayees.checked = s.askForNewPayees;
    rulesShown = s;
  }
  // Warn David if Grace tried to loosen her rules in the last 24 hours (a scam warning sign).
  const blocked = activity.find((a) => a.action === 'RULES_BLOCKED' && Date.now() - new Date(a.at) < 24 * 3600e3);
  rulesAlert.classList.toggle('hidden', !blocked);
  if (blocked) {
    rulesAlert.textContent = `Warning: ${when(blocked.at)}: ${blocked.detail} Someone may be pressuring her. Consider calling her.`;
    if (lastBlockedId !== null && blocked.id !== lastBlockedId) announce('Warning: Grace tried to loosen her safety rules.');
    lastBlockedId = blocked.id;
  } else if (lastBlockedId === null) {
    lastBlockedId = 0; // first load had no warning, so any warning from now on is new and announced
  }
}

// Save button: David can change any rule, including loosening one (Grace can only tighten hers).
rulesForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  rulesMessage.className = 'rules-message';
  rulesMessage.textContent = '';
  const changes = {
    perPaymentLimit: Number(rulesForm.perPaymentLimit.value),
    riskThreshold: Number(rulesForm.riskThreshold.value),
    askForNewPayees: rulesForm.askForNewPayees.checked,
  };
  try {
    const r = await api('/api/helper/settings', changes);
    rulesShown = null; // make the next refresh redraw the form with the saved values
    rulesMessage.classList.add('ok');
    rulesMessage.textContent = r.changed ? 'Saved. Grace\'s rules are updated.' : 'Nothing changed.';
    queueRefresh();
  } catch (err) {
    rulesMessage.classList.add('bad');
    rulesMessage.textContent = err.message;
  }
});

// ---------- Live updates ----------

let refreshQueued = false;

/**
 * Asks for one refresh shortly, so a burst of changes leads to a single reload instead of many.
 */
function queueRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => { refreshQueued = false; refresh().catch(() => {}); }, 300);
}

/**
 * Listens for change events from the server (Server-Sent Events) and refreshes on each one.
 * Falls back to polling when the browser has no EventSource or the connection drops.
 */
function startLiveUpdates() {
  if (!('EventSource' in window)) return startPolling();
  // EventSource cannot send custom headers, so the PIN goes in the address instead.
  const es = new EventSource(`/api/helper/events?pin=${encodeURIComponent(pin)}`);
  es.addEventListener('open', () => {
    els.liveState.textContent = 'Live: new payments appear here automatically.';
    // Live updates work (again), so polling is no longer needed.
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  });
  es.addEventListener('change', queueRefresh);
  // EventSource reconnects on its own; poll in the meantime so nothing is missed.
  es.addEventListener('error', () => {
    els.liveState.textContent = 'Live updates paused; checking every 10 seconds.';
    startPolling();
  });
}

// Refreshes every 10 seconds; does nothing if polling is already running.
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => refresh().catch(() => {}), 10000);
}

// Keep the "cancelled automatically in ..." times fresh, but only once the dashboard is unlocked.
setInterval(() => { if (!els.main.classList.contains('hidden')) queueRefresh(); }, 60000);

// ---------- Start ----------

/**
 * Loads the dashboard for the first time, then starts live updates.
 */
async function start() {
  try {
    await refresh();
  } catch (err) {
    els.liveState.textContent = `Could not load payments: ${err.message}`;
  }
  startLiveUpdates();
}

// On page load, try the PIN saved for this tab. If there is none, or it is wrong, show the PIN form.
(async function init() {
  const saved = storage((s) => s.getItem('kinbill-helper-pin')) || '';
  if (await tryPin(saved).catch(() => false)) return start();
  els.gate.classList.remove('hidden');
  els.pin.focus(); // the PIN box is the only thing David can do here, so start there
})();
