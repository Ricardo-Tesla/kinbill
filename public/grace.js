// Grace's screen: speak (or type) a payment, hear it read back, say yes or no, then hear the result.
// Voice in and out uses the browser's built-in Web Speech API (best in Chrome or Edge); no extra keys needed.
// Everything spoken is also sent to a screen-reader live region, and buttons and the Y, N and R keys always work.
// Risky payments pause until David checks them; this screen keeps watching and tells Grace his decision.
// Animations are skipped when the device asks for reduced motion; text size and voice speed are remembered.

// Short helper to find an element by id.
const $ = (id) => document.getElementById(id);
// Every element the script uses, looked up once.
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

// Some browsers only offer the prefixed name. When neither exists, Grace is offered the typing box.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
// Defaults until /api/status answers, so the screen still makes sense if the server is slow.
let status = { userName: 'Grace', helperName: 'David', paypalLinked: false };
let current = null;        // the payment being confirmed
let shownId = null;        // the payment shown in the result box
let busy = false;          // true while a request is running, so a double tap or voice cannot send twice
let lastSpoken = '';       // for "Say it again"
let voiceRate = 0.9;       // Grace can choose "Slower"

// ---------- Speaking and listening ----------

// Puts text in the screen-reader live region.
function announce(text) {
  els.live.textContent = '';
  // Clearing first and waiting a moment makes screen readers announce a message even if it repeats.
  setTimeout(() => { els.live.textContent = text; }, 50);
}

/**
 * Speaks text aloud and also shows it to screen readers.
 * @param {string} text  what to say
 * @returns {Promise<void>} resolves when speaking ends, or after 15 seconds at most
 */
function say(text) {
  lastSpoken = text;
  announce(text);
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    window.speechSynthesis.cancel(); // stop anything still speaking, so messages never overlap
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = voiceRate;      // a little slower than normal; "Slower" makes it slower still
    u.onend = resolve;
    u.onerror = resolve;
    window.speechSynthesis.speak(u);
    setTimeout(resolve, 15000); // some browsers do not always fire onend: never wait forever
  });
}

/**
 * Listens through the microphone for one phrase.
 * @returns {Promise<string|null>} what was heard, or null if nothing was heard or voice is not available
 */
function listenOnce() {
  return new Promise((resolve) => {
    if (!Recognition) return resolve(null);
    const rec = new Recognition();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let heard = null;
    rec.onresult = (e) => { heard = e.results[0][0].transcript; };
    rec.onerror = () => {};  // errors (no speech, microphone blocked) still end in onend, which resolves
    rec.onend = () => resolve(heard);
    try { rec.start(); } catch { resolve(null); } // start() throws if recognition is already running
  });
}

/**
 * Shows on the talk button whether the microphone is listening.
 * @param {boolean} on  true while listening
 * @param {string} [label]  button text to show when not listening
 */
function setListening(on, label) {
  els.speak.classList.toggle('listening', on);
  els.speakLabel.textContent = on ? 'Listening... speak now' : (label || 'Tap and speak');
}

// ---------- Talking to the Kin-bill server ----------

/**
 * Calls the Kin-bill server: GET without a body, POST with one.
 * @param {string} path  API path, e.g. '/api/requests'
 * @param {object} [body]  JSON body to POST
 * @returns {Promise<object>} the JSON reply; throws an Error with the server's message and code on failure
 */
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

// True when the device asks for reduced motion; animations are then skipped.
const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Replays a short entrance animation (CSS class "enter") on an element.
function enter(el) {
  el.classList.remove('enter');
  void el.offsetWidth; // reading offsetWidth forces a reflow, so the animation starts again
  el.classList.add('enter');
}

/**
 * Counts an amount up from $0 (about half a second). Shows it straight away with "reduce motion".
 * @param {HTMLElement} el  where to show the amount
 * @param {number} amount  the final amount in dollars
 */
function countUp(el, amount) {
  if (calm()) { el.textContent = money(amount); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 600);
    el.textContent = money(amount * (1 - (1 - t) ** 3)); // eases out, slowing down near the final amount
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Shows one of the three steps (ask, confirm, result) and hides the other two.
 * @param {HTMLElement} section  the step to show
 */
function show(section) {
  for (const s of [els.ask, els.confirm, els.result]) s.classList.toggle('hidden', s !== section);
  if (section !== els.ask) enter(section);
  // The browser tab title says where Grace is (screen readers read it when she switches tabs).
  const step = section === els.confirm ? 'Is this right?' : section === els.result ? els.resultTitle.textContent : 'Who would you like to pay?';
  document.title = `${step} - Kin-bill`;
}

// Formats a time of day, such as "3:05 PM"; uses the current time when none is given.
function clock(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Formats a number as dollars, e.g. $80.00.
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
// The words shown next to the status shape for each kind of result.
function statusLabel(kind) {
  return { ok: 'Sent', warn: `Waiting for ${status.helperName}`, bad: 'Not sent', '': 'Cancelled' }[kind] ?? '';
}

/**
 * Fills in and shows the result step, then moves focus to its title.
 * @param {string} kind  'ok' (sent), 'warn' (waiting for David), 'bad' (not sent) or '' (cancelled)
 * @param {string} title  short heading
 * @param {string} text  main message, usually the same words that are spoken
 * @param {string} [detail]  extra line, such as when the money should arrive
 * @param {string[]} [reasons]  why the payment was paused, in plain words
 * @param {object} [options]  label: status words to use instead of the default;
 *   signoff: "Checked by David" line; amount: dollars to show
 */
function showResult(kind, title, text, detail = '', reasons = [], { label, signoff, amount } = {}) {
  els.resultAmount.classList.toggle('hidden', amount === undefined);
  if (amount !== undefined) {
    // Only money that was sent counts up; any other amount simply appears.
    if (kind === 'ok') countUp(els.resultAmount, amount);
    else els.resultAmount.textContent = money(amount);
  }
  els.result.className = `card ${kind}`;
  const icon = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${STATUS_ICONS[kind] ?? STATUS_ICONS['']}</svg>`;
  els.resultStatus.innerHTML = icon;
  els.resultStatus.append(label || statusLabel(kind));
  els.resultSignoff.classList.toggle('hidden', !signoff);
  if (signoff) {
    // The helper's initial, shown like a signature on the decision.
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

/**
 * Clears the current payment and goes back to the first step, ready for a new request.
 */
function reset() {
  current = null;
  shownId = null;
  busy = false;
  setListening(false);
  els.typed.value = '';
  show(els.ask);
  els.speak.focus(); // the talk button is the next thing Grace needs
}

// ---------- The flow ----------

/**
 * Sends what Grace said (or typed) to the server, then reads the payment back for her to confirm.
 * @param {string} text  her request in her own words
 */
async function handleRequest(text) {
  if (busy || !text) return;
  busy = true;
  setListening(false, 'Checking...');
  els.thinking.classList.remove('hidden');
  announce('Checking, one moment.');
  try {
    const r = await api('/api/requests', { text }).finally(() => els.thinking.classList.add('hidden'));
    // No clear amount was heard: ask Grace to try again and stay on this step.
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
    els.yes.focus(); // keyboard and switch users can confirm straight away
    await say(r.spoken);
    busy = false;    // cleared before listening, so a spoken "yes" is accepted
    listenForYesNo();
  } catch (err) {
    busy = false;
    setListening(false);
    await say(`Sorry, ${err.message}`);
  }
}

/**
 * After reading back, listens for "yes" or "no" (the buttons always work too).
 * Anything else is ignored, so nothing is sent unless Grace clearly agrees.
 */
async function listenForYesNo() {
  if (!Recognition || !current) return;
  const heard = (await listenOnce() || '').toLowerCase();
  if (!current || busy) return; // Grace may have pressed a button while the microphone was on
  if (/\b(yes|yeah|yep|correct|right|sure|ok|okay|send it)\b/.test(heard)) return answer(true);
  if (/\b(no|nope|cancel|stop|wrong|don'?t)\b/.test(heard)) return answer(false);
}

/**
 * Confirms or cancels the payment that was read back, then shows and speaks the result.
 * Low-risk payments are sent; risky ones are held for David, and this screen keeps watching.
 * @param {boolean} yes  true to send, false to cancel
 */
async function answer(yes) {
  if (!current || busy) return;
  busy = true;
  window.speechSynthesis?.cancel(); // stop the read-back so the result is heard straight away
  const id = current.id;
  try {
    if (!yes) {
      const r = await api(`/api/requests/${id}/cancel`, {});
      showResult('', 'Cancelled', 'Nothing was sent.');
      await say(r.spoken);
      return;
    }
    els.yes.disabled = els.no.disabled = true; // no second press while the payment is being made
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
    // PayPal is not connected yet: show the banner with the button to connect it.
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

// Browsers slow down timers in a tab that is not showing, and Grace may not be looking.
// pause() also wakes up as soon as the tab is shown again, and sayWhenSeen() keeps a message
// until Grace is back on this screen, then says it.

/**
 * Waits for a while, but wakes up early as soon as the tab is shown again.
 * @param {number} ms  the longest time to wait, in milliseconds
 * @returns {Promise<void>}
 */
function pause(ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); document.removeEventListener('visibilitychange', onShow); resolve(); };
    const onShow = () => { if (!document.hidden) done(); };
    const t = setTimeout(done, ms);
    document.addEventListener('visibilitychange', onShow);
  });
}

let waitingToSay = null;   // a message kept until the tab is visible again (only the latest one)

/**
 * Says text now if Grace can see this tab; otherwise keeps it and says it when she comes back.
 * Screen readers are told straight away either way.
 * @param {string} text  what to say
 * @returns {Promise<void>}
 */
function sayWhenSeen(text) {
  if (!document.hidden) return say(text);
  waitingToSay = text;
  announce(text);
  return Promise.resolve();
}
// When Grace returns to this tab, say the kept message after a short pause so the page has settled.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && waitingToSay) {
    const text = waitingToSay;
    waitingToSay = null;
    setTimeout(() => say(text), 400);
  }
});

/**
 * While a payment is paused, checks every few seconds for David's decision and tells Grace.
 * @param {number|string} id  the held payment
 */
async function watchHeld(id) {
  // Stop watching once Grace has moved on to another payment.
  const stillShown = () => shownId === id && !els.result.classList.contains('hidden');
  for (let i = 0; i < 720 && stillShown(); i++) {   // up to about an hour on screen
    await pause(5000);
    let p;
    try { p = await api(`/api/requests/${id}`); } catch { continue; }
    if (p.status === 'HELD') continue;
    if (!stillShown()) return;
    // Signed with David's name and the time, so Grace knows a real person decided.
    const signed = `Checked by ${status.helperName} · ${clock(p.decidedAt)}`;
    if (p.status === 'PAYING' || p.status === 'PAID') {
      const msg = `${status.helperName} approved your payment to ${p.payeeName}. ${money(p.amount)} is on its way.`;
      showResult('ok', `${status.helperName} approved it`, msg, 'It usually arrives within a minute or two.', [], { label: 'Approved and sent', signoff: signed, amount: p.amount });
      await sayWhenSeen(msg);
      watchUntilPaid(id);
    } else if (p.status === 'REJECTED') {
      const msg = `${status.helperName} decided not to send this payment to ${p.payeeName}. No money was sent.`;
      showResult('bad', 'Not sent', msg, `If you are unsure, you can call ${status.helperName}.`, [], { label: `Stopped by ${status.helperName}`, signoff: signed });
      await sayWhenSeen(msg);
    } else if (p.status === 'EXPIRED') {
      const msg = 'No one approved this payment in time, so it was cancelled. No money was sent.';
      showResult('bad', 'Cancelled', msg, '', [], { label: 'Cancelled: no answer in time' });
      await sayWhenSeen(msg);
    }
    return;
  }
}

/**
 * Checks every few seconds until the payout has arrived, then tells Grace.
 * @param {number|string} id  the payment being sent
 */
async function watchUntilPaid(id) {
  // 40 checks, 5 seconds apart: over 3 minutes, enough for a sandbox payout (usually 1-2 minutes).
  for (let i = 0; i < 40; i++) {
    await pause(5000);
    let p;
    try { p = await api(`/api/requests/${id}`); } catch { continue; }
    if (p.status === 'PAID') {
      const msg = `Good news. ${p.payeeName} has received the ${money(p.amount)}.`;
      els.resultDetail.textContent = msg;
      // Say it out loud, unless Grace has already started another payment.
      if (!els.result.classList.contains('hidden') && !busy) await sayWhenSeen(msg);
      else announce(msg);
      return;
    }
    if (p.status !== 'PAYING') return; // failed or otherwise finished: nothing more to wait for
  }
}

// ---------- Buttons ----------

// Talk button: listen once, then send what was heard.
els.speak.addEventListener('click', async () => {
  if (busy) return;
  // No voice input in this browser: open the typing box and move focus there.
  if (!Recognition) {
    els.typeInstead.open = true;
    els.typed.focus();
    await say('Voice is not available in this browser. Please type instead, or use Chrome or Edge.');
    return;
  }
  window.speechSynthesis?.cancel(); // so the microphone does not hear the app talking
  setListening(true);
  const heard = await listenOnce();
  setListening(false);
  if (heard) handleRequest(heard);
  else await say('Sorry, I did not hear anything. Please tap and try again.');
});

// Typed requests go through the same steps as spoken ones.
els.typedForm.addEventListener('submit', (e) => {
  e.preventDefault();
  handleRequest(els.typed.value.trim());
});

els.yes.addEventListener('click', () => answer(true));
els.no.addEventListener('click', () => answer(false));
els.again.addEventListener('click', reset); // "Make another payment"

// Example buttons send a ready-made request, for trying the app and for demos.
document.querySelectorAll('[data-example]').forEach((b) => {
  b.addEventListener('click', () => {
    els.typed.value = b.dataset.example;
    show(els.ask);
    handleRequest(b.dataset.example);
  });
});

// One-time setup: Grace approves on PayPal once, so later payments need no PayPal screens.
els.linkButton.addEventListener('click', async () => {
  els.linkButton.disabled = true; // avoid starting the link twice
  try {
    const { approveUrl } = await api('/api/link/start', {});
    window.location.href = approveUrl; // PayPal brings Grace back here when done
  } catch (err) {
    els.linkButton.disabled = false;
    await say(`Sorry, could not connect PayPal: ${err.message}`);
  }
});

// ---------- Comfort settings (remembered on this device) ----------

// Kept in localStorage so Grace sets them once, with no account needed.
// localStorage can throw (private mode, blocked storage); the screen still works without it.
function remember(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode: fine */ } }
function recall(key) { try { return localStorage.getItem(key); } catch { return null; } }

// Marks the chosen toggle as pressed (aria-pressed), so screen readers say which one is on.
function pressOnly(buttons, chosen) {
  buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === chosen)));
}

/**
 * Changes the text size for the whole page and remembers it.
 * @param {string} cls  '' for normal, 'text-lg' or 'text-xl'
 */
function setTextSize(cls) {
  document.documentElement.classList.remove('text-lg', 'text-xl');
  if (cls) document.documentElement.classList.add(cls);
  const buttons = [...document.querySelectorAll('[data-size]')];
  pressOnly(buttons, buttons.find((b) => b.dataset.size === cls) || buttons[0]);
  remember('kinbill-text-size', cls);
}

/**
 * Changes how fast the app speaks and remembers it.
 * @param {number|string} rate  speech rate; 0.9 is the normal speed here
 */
function setVoiceRate(rate) {
  voiceRate = Number(rate) || 0.9;
  const buttons = [...document.querySelectorAll('[data-rate]')];
  pressOnly(buttons, buttons.find((b) => Number(b.dataset.rate) === voiceRate) || buttons[0]);
  remember('kinbill-voice-rate', String(voiceRate));
}

// Text size buttons: the change is announced, because a screen-reader user may not see it.
document.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
  setTextSize(b.dataset.size);
  announce(b.dataset.size === 'text-xl' ? 'Biggest text.' : b.dataset.size === 'text-lg' ? 'Bigger text.' : 'Normal text size.');
}));
// Voice speed buttons: say a short sentence at the new speed so Grace can hear the difference.
document.querySelectorAll('[data-rate]').forEach((b) => b.addEventListener('click', () => {
  setVoiceRate(b.dataset.rate);
  say(voiceRate < 0.9 ? 'I will speak more slowly.' : 'I will speak at normal speed.');
}));

// Restore the choices Grace made last time on this device.
setTextSize(recall('kinbill-text-size') || '');
setVoiceRate(recall('kinbill-voice-rate') || 0.9);

// ---------- "Say it again" and keyboard shortcuts ----------

// Says the last spoken message again, for when Grace missed it.
function repeat() {
  if (lastSpoken) say(lastSpoken);
}
document.querySelectorAll('[data-repeat]').forEach((b) => b.addEventListener('click', repeat));

// Y = yes, N or Escape = no (only while "Is this right?" is showing), R = say it again.
// Ignored while typing in a box, so typing a name with a Y or N is safe.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return; // leave browser and screen-reader shortcuts alone
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
let rules = null;   // the rules last loaded from the server, used to spot what Grace changed

/**
 * Shows Grace's rules as a plain list and fills in the change form.
 * @param {object} r  rules from the server: summary sentences and settings values
 */
function showRules(r) {
  rules = r;
  rulesEls.list.replaceChildren(...r.summary.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  rulesEls.limit.value = r.settings.perPaymentLimit;
  // David may have set an in-between number: tick the level it belongs to.
  [...rulesEls.form.riskThreshold].forEach((x) => { x.checked = careName(Number(x.value)) === careName(r.settings.riskThreshold); });
  rulesEls.form.askForNewPayees.checked = r.settings.askForNewPayees;
}

// Fetches the current rules and shows them. A failure is ignored so the rest of the page keeps working.
async function loadRules() {
  try { showRules(await api('/api/settings')); } catch { /* keep the page usable */ }
}

// David may have changed them since the page opened: fetch fresh rules when Grace opens the form.
$('rules-change').addEventListener('toggle', (e) => { if (e.target.open) loadRules(); });

// "Read my rules aloud": fetch fresh rules first, so Grace hears what is really in place.
rulesEls.read.addEventListener('click', async () => {
  await loadRules();
  if (rules) say(`Here are your safety rules. ${rules.summary.join(' ')}`);
});

// Save button: Grace can only make her rules stricter. The server refuses any loosening,
// and David is warned about the attempt (a scammer may be coaching her).
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

/**
 * Names the care level a risk threshold belongs to, so in-between numbers match one of Grace's three choices.
 * @param {number} threshold  risk score at or above which payments are held
 * @returns {string} 'very', 'careful' or 'relaxed'
 */
function careName(threshold) {
  return threshold <= 25 ? 'very' : threshold <= 45 ? 'careful' : 'relaxed';
}

// ---------- Start ----------

// On page load: greet Grace by name, load her rules, and say how linking PayPal went
// when PayPal has just sent her back here (?link=done, failed or cancelled).
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
  if (link) history.replaceState(null, '', '/grace.html'); // so a reload does not repeat the message
})();
