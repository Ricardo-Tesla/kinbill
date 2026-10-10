// David's helper screen: see payments waiting for him, with the reasons, and approve or reject.
// Updates live (Server-Sent Events), falling back to checking every 10 seconds.

const $ = (id) => document.getElementById(id);
const els = {
  hello: $('hello'), gate: $('pin-gate'), pinForm: $('pin-form'), pin: $('pin'), pinError: $('pin-error'),
  main: $('main'), heldList: $('held-list'), nothing: $('nothing-waiting'), count: $('waiting-count'),
  liveState: $('live-state'), grid: $('history-grid'), live: $('live'), template: $('held-template'),
};

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

let pin = '';
let gridApi = null;
let knownHeldIds = new Set();
let pollTimer = null;

// ---------- small helpers ----------

function storage(fn) { try { return fn(window.sessionStorage); } catch { return null; } }
const money = (n) => `$${Number(n).toFixed(2)}`;
function when(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function timeLeft(iso) {
  if (!iso) return '';
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'The hold time is up; it will be cancelled automatically.';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `If you do nothing, it is cancelled automatically in ${h ? `${h} h ` : ''}${m} min. No money moves until you approve.`;
}
function announce(text) {
  els.live.textContent = '';
  setTimeout(() => { els.live.textContent = text; }, 50);
}

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

async function tryPin(candidate) {
  pin = candidate;
  try {
    const who = await api('/api/helper/check');
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

els.pinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.pinError.textContent = '';
  if (await tryPin(els.pin.value.trim())) start();
  else els.pinError.textContent = 'That PIN is not right. Please try again.';
});

// ---------- Waiting payments (cards) ----------

function renderHeld(held) {
  els.heldList.replaceChildren(...held.map(heldCard));
  els.nothing.classList.toggle('hidden', held.length > 0);
  els.count.textContent = held.length ? String(held.length) : '';
  document.title = held.length ? `(${held.length}) Kin-bill: helper` : 'Kin-bill: helper';

  const newOnes = held.filter((p) => !knownHeldIds.has(p.id));
  if (knownHeldIds.size && newOnes.length) {
    announce(`New payment waiting: ${newOnes[0].helperPayeeName || newOnes[0].payeeName}, ${money(newOnes[0].amount)}.`);
  }
  knownHeldIds = new Set(held.map((p) => p.id));
}

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
  risk.setAttribute('aria-label', `Scam risk ${p.riskScore} out of 100`);
  q('.held-reasons').replaceChildren(...(p.reasons || []).map((r) => Object.assign(document.createElement('li'), { textContent: r })));
  q('.held-meta').textContent = `Asked ${when(p.createdAt)}. Checked by: ${p.aiSource || 'unknown'}. ${timeLeft(p.holdExpiresAt)}`;

  const emailBox = q('.contact-needed');
  const email = q('.email-input');
  emailBox.classList.toggle('hidden', p.inContacts);
  const approve = q('.approve');
  const reject = q('.reject');
  const error = q('.held-error');
  approve.textContent = p.inContacts ? `Approve and pay ${money(p.amount)}` : 'Add to contacts and pay';
  approve.setAttribute('aria-label', `Approve paying ${who} ${money(p.amount)}`);
  reject.setAttribute('aria-label', `Reject paying ${who} ${money(p.amount)}`);

  approve.addEventListener('click', async () => {
    error.textContent = '';
    if (!p.inContacts && !email.value.trim()) {
      error.textContent = 'Please enter their PayPal email first, or reject the payment.';
      email.focus();
      return;
    }
    if (!window.confirm(`Pay ${money(p.amount)} to ${who}? This sends the money.`)) return;
    approve.disabled = reject.disabled = true;
    approve.textContent = 'Paying...';
    try {
      await api(`/api/helper/payments/${p.id}/approve`, { email: email.value.trim() });
      announce(`Approved. ${money(p.amount)} is on its way to ${who}.`);
      await refresh();
    } catch (err) {
      error.textContent = err.message;
      approve.disabled = reject.disabled = false;
      approve.textContent = p.inContacts ? `Approve and pay ${money(p.amount)}` : 'Add to contacts and pay';
    }
  });

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

function renderHistory(history) {
  const rows = historyRows(history);
  if (window.agGrid?.createGrid) {
    if (!gridApi) {
      gridApi = window.agGrid.createGrid(els.grid, {
        rowData: rows,
        columnDefs: [
          { field: 'when', headerName: 'When', width: 140 },
          { field: 'payee', headerName: 'To', flex: 1, minWidth: 150 },
          { field: 'amount', headerName: 'Amount', width: 110, valueFormatter: (x) => money(x.value) },
          { field: 'status', headerName: 'Status', flex: 1, minWidth: 170,
            cellStyle: (x) => ({ fontWeight: 700, color: /Waiting|Failed/.test(x.value) ? '#7a4100' : /Rejected|Auto/.test(x.value) ? '#8f1111' : '#0a5c25' }) },
          { field: 'risk', headerName: 'Risk', width: 90 },
          { field: 'route', headerName: 'Route', width: 160 },
          { field: 'decidedBy', headerName: 'Decided by', width: 120 },
          { field: 'checkedBy', headerName: 'Checked by', width: 120 },
          { field: 'said', headerName: 'What Grace said', flex: 2, minWidth: 260, tooltipField: 'said' },
        ],
        defaultColDef: { sortable: true, filter: true, resizable: true },
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

// ---------- Loading and live updates ----------

async function refresh() {
  const { held, history } = await api('/api/helper/overview');
  renderHeld(held);
  renderHistory(history);
}

let refreshQueued = false;
function queueRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => { refreshQueued = false; refresh().catch(() => {}); }, 300);
}

function startLiveUpdates() {
  if (!('EventSource' in window)) return startPolling();
  const es = new EventSource(`/api/helper/events?pin=${encodeURIComponent(pin)}`);
  es.addEventListener('open', () => {
    els.liveState.textContent = 'Live: new payments appear here automatically.';
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  });
  es.addEventListener('change', queueRefresh);
  es.addEventListener('error', () => {
    els.liveState.textContent = 'Live updates paused; checking every 10 seconds.';
    startPolling();
  });
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => refresh().catch(() => {}), 10000);
}

// Keep the "cancelled automatically in ..." times fresh.
setInterval(() => { if (!els.main.classList.contains('hidden')) queueRefresh(); }, 60000);

async function start() {
  try {
    await refresh();
  } catch (err) {
    els.liveState.textContent = `Could not load payments: ${err.message}`;
  }
  startLiveUpdates();
}

(async function init() {
  const saved = storage((s) => s.getItem('kinbill-helper-pin')) || '';
  if (await tryPin(saved)) return start();
  els.gate.classList.remove('hidden');
  els.pin.focus();
})();
