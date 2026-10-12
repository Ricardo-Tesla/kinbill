// Grace's screen: speak (or type) -> hear it read back -> say yes/no -> hear the result.
// Uses the browser's built-in speech features (best in Chrome or Edge). No extra keys needed.

const $ = (id) => document.getElementById(id);
const els = {
  hello: $('hello'), banner: $('link-banner'), linkButton: $('link-button'),
  ask: $('ask'), prompt: $('prompt'), speak: $('speak'), speakLabel: $('speak-label'),
  typedForm: $('typed-form'), typed: $('typed'), typeInstead: $('type-instead'),
  confirm: $('confirm'), confirmPayee: $('confirm-payee'), confirmAmount: $('confirm-amount'), confirmSaid: $('confirm-said'),
  yes: $('yes'), no: $('no'),
  result: $('result'), resultTitle: $('result-title'), resultText: $('result-text'), resultDetail: $('result-detail'),
  resultWhy: $('result-why'), resultReasons: $('result-reasons'),
  resultAmount: $('result-amount'), thinking: $('thinking'),
  resultStatus: $('result-status'), resultSignoff: $('result-signoff'), resultSignoffText: $('result-signoff-text'),
  again: $('again'), live: $('live'),
};

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let status = { userName: 'Grace', helperName: 'David', paypalLinked: false };
let current = null;        // the payment being confirmed
let shownId = null;        // the payment shown in the result box
let busy = false;
let lastSpoken = '';       // for "Say it again"
let voiceRate = 0.9;       // Grace can choose "Slower"

// ---------- Speaking and listening ----------

function announce(text) {
  els.live.textContent = '';
  setTimeout(() => { els.live.textContent = text; }, 50); // screen readers
}

function say(text) {
  lastSpoken = text;
  announce(text);
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = voiceRate;      // a little slower than normal; "Slower" makes it slower still
    u.onend = resolve;
    u.onerror = resolve;
    window.speechSynthesis.speak(u);
    setTimeout(resolve, 15000); // never wait forever
  });
}

function listenOnce() {
  return new Promise((resolve) => {
    if (!Recognition) return resolve(null);
    const rec = new Recognition();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let heard = null;
    rec.onresult = (e) => { heard = e.results[0][0].transcript; };
    rec.onerror = () => {};
    rec.onend = () => resolve(heard);
    try { rec.start(); } catch { resolve(null); }
  });
}

function setListening(on, label) {
  els.speak.classList.toggle('listening', on);
  els.speakLabel.textContent = on ? 'Listening... speak now' : (label || 'Tap and speak');
}

// ---------- Talking to the Kin-bill server ----------

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { code: data.code });
  return data;
}

// ---------- Screens ----------

const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Replays a short entrance animation (CSS class "enter") on an element.
function enter(el) {
  el.classList.remove('enter');
  void el.offsetWidth; // restart the animation
  el.classList.add('enter');
}

// Counts an amount up from $0 (about half a second). Shows it straight away with "reduce motion".
function countUp(el, amount) {
  if (calm()) { el.textContent = money(amount); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 600);
    el.textContent = money(amount * (1 - (1 - t) ** 3));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function show(section) {
  for (const s of [els.ask, els.confirm, els.result]) s.classList.toggle('hidden', s !== section);
  if (section !== els.ask) enter(section);
  // The browser tab title says where Grace is (screen readers read it when she switches tabs).
  const step = section === els.confirm ? 'Is this right?' : section === els.result ? els.resultTitle.textContent : 'Who would you like to pay?';
  document.title = `${step} - Kin-bill`;
}

function clock(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

// Every result says what happened in words and with a shape, not only with colour.
const STATUS_ICONS = {
  ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  warn: '<path d="M9 6v12M15 6v12"/>',
  bad: '<path d="M7 7l10 10M17 7L7 17"/>',
  '': '<path d="M6 12h12"/>',
};
function statusLabel(kind) {
  return { ok: 'Sent', warn: `Waiting for ${status.helperName}`, bad: 'Not sent', '': 'Cancelled' }[kind] ?? '';
}

function showResult(kind, title, text, detail = '', reasons = [], { label, signoff, amount } = {}) {
  els.resultAmount.classList.toggle('hidden', amount === undefined);
  if (amount !== undefined) {
    if (kind === 'ok') countUp(els.resultAmount, amount);
    else els.resultAmount.textContent = money(amount);
  }
  els.result.className = `card ${kind}`;
  const icon = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${STATUS_ICONS[kind] ?? STATUS_ICONS['']}</svg>`;
  els.resultStatus.innerHTML = icon;
  els.resultStatus.append(label || statusLabel(kind));
  els.resultSignoff.classList.toggle('hidden', !signoff);
  if (signoff) {
    els.resultSignoff.querySelector('.initial').textContent = status.helperName.charAt(0);
    els.resultSignoffText.textContent = signoff;
    enter(els.resultSignoff);
  }
  els.resultTitle.textContent = title;
  els.resultText.textContent = text;
  els.resultDetail.textContent = detail;
  els.resultReasons.replaceChildren(...reasons.map((r) => Object.assign(document.createElement('li'), { textContent: r })));
  els.resultWhy.classList.toggle('hidden', !reasons.length);
  show(els.result);
  els.resultTitle.focus();   // screen readers start reading at the result
}

function reset() {
  current = null;
  shownId = null;
  busy = false;
  setListening(false);
  els.typed.value = '';
  show(els.ask);
  els.speak.focus();
}

// ---------- The flow ----------

async function handleRequest(text) {
  if (busy || !text) return;
  busy = true;
  setListening(false, 'Checking...');
  els.thinking.classList.remove('hidden');
  announce('Checking, one moment.');
  try {
    const r = await api('/api/requests', { text }).finally(() => els.thinking.classList.add('hidden'));
    if (r.needsRetry) {
      busy = false;
      setListening(false);
      await say(r.spoken);
      return;
    }
    current = r.payment;
    els.confirmPayee.textContent = current.payeeName;
    els.confirmAmount.textContent = money(current.amount);
    els.confirmSaid.textContent = `"${current.said}"`;
    show(els.confirm);
    els.yes.focus();
    await say(r.spoken);
    busy = false;
    listenForYesNo();
  } catch (err) {
    busy = false;
    setListening(false);
    await say(`Sorry, ${err.message}`);
  }
}

// After reading back, listen for "yes" or "no" (the buttons always work too).
async function listenForYesNo() {
  if (!Recognition || !current) return;
  const heard = (await listenOnce() || '').toLowerCase();
  if (!current || busy) return;
  if (/\b(yes|yeah|yep|correct|right|sure|ok|okay|send it)\b/.test(heard)) return answer(true);
  if (/\b(no|nope|cancel|stop|wrong|don'?t)\b/.test(heard)) return answer(false);
}

async function answer(yes) {
  if (!current || busy) return;
  busy = true;
  window.speechSynthesis?.cancel();
  const id = current.id;
  try {
    if (!yes) {
      const r = await api(`/api/requests/${id}/cancel`, {});
      showResult('', 'Cancelled', 'Nothing was sent.');
      await say(r.spoken);
      return;
    }
    els.yes.disabled = els.no.disabled = true;
    const r = await api(`/api/requests/${id}/confirm`, {});
    const p = r.payment;
    shownId = p.id;
    if (p.status === 'PAYING' || p.status === 'PAID') {
      showResult('ok', `Sent to ${p.payeeName}`, r.spoken, 'It usually arrives within a minute or two.', [], { amount: p.amount });
      watchUntilPaid(p.id);
    } else if (p.status === 'HELD') {
      showResult('warn', `Paused: ${status.helperName} will check it`, r.spoken,
        'No money has been sent. The payment is waiting safely.', p.graceReasons || [], { amount: p.amount });
      watchHeld(p.id);
    } else {
      showResult('bad', 'Not sent', r.spoken);
    }
    await say(r.spoken);
  } catch (err) {
    if (err.code === 'NOT_LINKED') {
      els.banner.classList.remove('hidden');
      showResult('bad', 'Connect PayPal first', 'Please connect your PayPal, then try again.', '', [], { label: 'Not connected' });
      await say('Please connect your PayPal first, then try again.');
    } else {
      showResult('bad', 'Not sent', `Sorry, ${err.message} No money was sent.`);
      await say(`Sorry, ${err.message} No money was sent.`);
    }
  } finally {
    els.yes.disabled = els.no.disabled = false;
    current = null;
    busy = false;
  }
}

// While a payment is paused, checks every few seconds for David's decision and tells Grace.
async function watchHeld(id) {
  const stillShown = () => shownId === id && !els.result.classList.contains('hidden');
  for (let i = 0; i < 720 && stillShown(); i++) {   // up to about an hour on screen
    await new Promise((r) => setTimeout(r, 5000));
    let p;
    try { p = await api(`/api/requests/${id}`); } catch { continue; }
    if (p.status === 'HELD') continue;
    if (!stillShown()) return;
    const signed = `Checked by ${status.helperName} · ${clock(p.decidedAt)}`;
    if (p.status === 'PAYING' || p.status === 'PAID') {
      const msg = `${status.helperName} approved your payment to ${p.payeeName}. ${money(p.amount)} is on its way.`;
      showResult('ok', `${status.helperName} approved it`, msg, 'It usually arrives within a minute or two.', [], { label: 'Approved and sent', signoff: signed, amount: p.amount });
      await say(msg);
      watchUntilPaid(id);
    } else if (p.status === 'REJECTED') {
      const msg = `${status.helperName} decided not to send this payment to ${p.payeeName}. No money was sent.`;
      showResult('bad', 'Not sent', msg, `If you are unsure, you can call ${status.helperName}.`, [], { label: `Stopped by ${status.helperName}`, signoff: signed });
      await say(msg);
    } else if (p.status === 'EXPIRED') {
      const msg = 'No one approved this payment in time, so it was cancelled. No money was sent.';
      showResult('bad', 'Cancelled', msg, '', [], { label: 'Cancelled: no answer in time' });
      await say(msg);
    }
    return;
  }
}

// Checks every few seconds until the payout has arrived, then tells Grace.
async function watchUntilPaid(id) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    let p;
    try { p = await api(`/api/requests/${id}`); } catch { continue; }
    if (p.status === 'PAID') {
      const msg = `Good news. ${p.payeeName} has received the ${money(p.amount)}.`;
      els.resultDetail.textContent = msg;
      // Say it out loud, unless Grace has already started another payment.
      if (!els.result.classList.contains('hidden') && !busy) await say(msg);
      else announce(msg);
      return;
    }
    if (p.status !== 'PAYING') return;
  }
}

// ---------- Buttons ----------

els.speak.addEventListener('click', async () => {
  if (busy) return;
  if (!Recognition) {
    els.typeInstead.open = true;
    els.typed.focus();
    await say('Voice is not available in this browser. Please type instead, or use Chrome or Edge.');
    return;
  }
  window.speechSynthesis?.cancel();
  setListening(true);
  const heard = await listenOnce();
  setListening(false);
  if (heard) handleRequest(heard);
  else await say('Sorry, I did not hear anything. Please tap and try again.');
});

els.typedForm.addEventListener('submit', (e) => {
  e.preventDefault();
  handleRequest(els.typed.value.trim());
});

els.yes.addEventListener('click', () => answer(true));
els.no.addEventListener('click', () => answer(false));
els.again.addEventListener('click', reset);

document.querySelectorAll('[data-example]').forEach((b) => {
  b.addEventListener('click', () => {
    els.typed.value = b.dataset.example;
    show(els.ask);
    handleRequest(b.dataset.example);
  });
});

els.linkButton.addEventListener('click', async () => {
  els.linkButton.disabled = true;
  try {
    const { approveUrl } = await api('/api/link/start', {});
    window.location.href = approveUrl; // PayPal brings Grace back here when done
  } catch (err) {
    els.linkButton.disabled = false;
    await say(`Sorry, could not connect PayPal: ${err.message}`);
  }
});

// ---------- Comfort settings (remembered on this device) ----------

function remember(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode: fine */ } }
function recall(key) { try { return localStorage.getItem(key); } catch { return null; } }

function pressOnly(buttons, chosen) {
  buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === chosen)));
}

function setTextSize(cls) {
  document.documentElement.classList.remove('text-lg', 'text-xl');
  if (cls) document.documentElement.classList.add(cls);
  const buttons = [...document.querySelectorAll('[data-size]')];
  pressOnly(buttons, buttons.find((b) => b.dataset.size === cls) || buttons[0]);
  remember('kinbill-text-size', cls);
}

function setVoiceRate(rate) {
  voiceRate = Number(rate) || 0.9;
  const buttons = [...document.querySelectorAll('[data-rate]')];
  pressOnly(buttons, buttons.find((b) => Number(b.dataset.rate) === voiceRate) || buttons[0]);
  remember('kinbill-voice-rate', String(voiceRate));
}

document.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
  setTextSize(b.dataset.size);
  announce(b.dataset.size === 'text-xl' ? 'Biggest text.' : b.dataset.size === 'text-lg' ? 'Bigger text.' : 'Normal text size.');
}));
document.querySelectorAll('[data-rate]').forEach((b) => b.addEventListener('click', () => {
  setVoiceRate(b.dataset.rate);
  say(voiceRate < 0.9 ? 'I will speak more slowly.' : 'I will speak at normal speed.');
}));

setTextSize(recall('kinbill-text-size') || '');
setVoiceRate(recall('kinbill-voice-rate') || 0.9);

// ---------- "Say it again" and keyboard shortcuts ----------

function repeat() {
  if (lastSpoken) say(lastSpoken);
}
document.querySelectorAll('[data-repeat]').forEach((b) => b.addEventListener('click', repeat));

// Y = yes, N or Escape = no (only while "Is this right?" is showing), R = say it again.
// Ignored while typing in a box, so typing a name with a Y or N is safe.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  const key = e.key.toLowerCase();
  const confirming = !els.confirm.classList.contains('hidden');
  if (key === 'r') { e.preventDefault(); repeat(); }
  else if (confirming && key === 'y') { e.preventDefault(); answer(true); }
  else if (confirming && (key === 'n' || key === 'escape')) { e.preventDefault(); answer(false); }
});

// ---------- My safety rules ----------

const rulesEls = {
  list: $('rules-list'), read: $('rules-read'), form: $('rules-form'), message: $('rules-message'),
  limit: $('rule-limit'),
};
let rules = null;

function showRules(r) {
  rules = r;
  rulesEls.list.replaceChildren(...r.summary.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  rulesEls.limit.value = r.settings.perPaymentLimit;
  // David may have set an in-between number: tick the level it belongs to
  [...rulesEls.form.riskThreshold].forEach((x) => { x.checked = careName(Number(x.value)) === careName(r.settings.riskThreshold); });
  rulesEls.form.askForNewPayees.checked = r.settings.askForNewPayees;
}

async function loadRules() {
  try { showRules(await api('/api/settings')); } catch { /* keep the page usable */ }
}

// David may have changed them since the page opened: fetch fresh rules when Grace opens the form.
$('rules-change').addEventListener('toggle', (e) => { if (e.target.open) loadRules(); });

rulesEls.read.addEventListener('click', async () => {
  await loadRules();
  if (rules) say(`Here are your safety rules. ${rules.summary.join(' ')}`);
});

rulesEls.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!rules) return;
  const f = rulesEls.form;
  // Only send what changed, so an unchanged value is never treated as "loosening".
  const wanted = {
    perPaymentLimit: Number(f.perPaymentLimit.value),
    riskThreshold: Number(f.riskThreshold.value),
    askForNewPayees: f.askForNewPayees.checked,
  };
  const changes = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => {
    if (k === 'riskThreshold') return careName(v) !== careName(rules.settings.riskThreshold);
    return v !== rules.settings[k];
  }));
  rulesEls.message.className = 'rules-message';
  if (!Object.keys(changes).length) {
    rulesEls.message.textContent = 'Nothing changed.';
    return say('Nothing changed. Your rules are the same.');
  }
  try {
    const r = await api('/api/settings', changes);
    showRules(r);
    rulesEls.message.classList.add('ok');
    rulesEls.message.textContent = 'Saved. Your rules are updated.';
    await say(r.spoken);
  } catch (err) {
    showRules(rules);                 // put the form back to the rules that are really in place
    rulesEls.message.classList.add('bad');
    rulesEls.message.textContent = err.message;
    await say(err.message);
  }
});

function careName(threshold) {
  return threshold <= 25 ? 'very' : threshold <= 45 ? 'careful' : 'relaxed';
}

// ---------- Start ----------

(async function init() {
  try {
    status = await api('/api/status');
  } catch { /* server not reachable: keep defaults */ }
  els.hello.textContent = `Hello, ${status.userName}`;
  document.querySelectorAll('.helper-name').forEach((n) => { n.textContent = status.helperName; });
  loadRules();
  els.banner.classList.toggle('hidden', status.paypalLinked);

  const link = new URLSearchParams(location.search).get('link');
  if (link === 'done') await say('Your PayPal is connected. Who would you like to pay?');
  if (link === 'failed') await say('Sorry, connecting PayPal did not work. Please try again.');
  if (link === 'cancelled') await say('Connecting PayPal was cancelled.');
  if (link) history.replaceState(null, '', '/grace.html');
})();
