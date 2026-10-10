// Grace's screen: speak (or type) -> hear it read back -> say yes/no -> hear the result.
// Uses the browser's built-in speech features (best in Chrome or Edge). No extra keys needed.

const $ = (id) => document.getElementById(id);
const els = {
  hello: $('hello'), banner: $('link-banner'), linkButton: $('link-button'),
  ask: $('ask'), prompt: $('prompt'), speak: $('speak'), speakLabel: $('speak-label'),
  typedForm: $('typed-form'), typed: $('typed'), typeInstead: $('type-instead'),
  confirm: $('confirm'), confirmText: $('confirm-text'), confirmSaid: $('confirm-said'),
  yes: $('yes'), no: $('no'),
  result: $('result'), resultTitle: $('result-title'), resultText: $('result-text'), resultDetail: $('result-detail'),
  resultWhy: $('result-why'), resultReasons: $('result-reasons'),
  again: $('again'), live: $('live'),
};

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let status = { userName: 'Grace', helperName: 'David', paypalLinked: false };
let current = null;        // the payment being confirmed
let busy = false;

// ---------- Speaking and listening ----------

function announce(text) {
  els.live.textContent = '';
  setTimeout(() => { els.live.textContent = text; }, 50); // screen readers
}

function say(text) {
  announce(text);
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.9;            // a little slower, easier to follow
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

function show(section) {
  for (const s of [els.ask, els.confirm, els.result]) s.classList.toggle('hidden', s !== section);
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function showResult(kind, title, text, detail = '', reasons = []) {
  els.result.className = `card ${kind}`;
  els.resultTitle.textContent = title;
  els.resultText.textContent = text;
  els.resultDetail.textContent = detail;
  els.resultReasons.replaceChildren(...reasons.map((r) => Object.assign(document.createElement('li'), { textContent: r })));
  els.resultWhy.classList.toggle('hidden', !reasons.length);
  show(els.result);
  els.again.focus();
}

function reset() {
  current = null;
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
  try {
    const r = await api('/api/requests', { text });
    if (r.needsRetry) {
      busy = false;
      setListening(false);
      await say(r.spoken);
      return;
    }
    current = r.payment;
    els.confirmText.textContent = `Pay ${current.payeeName} ${money(current.amount)}?`;
    els.confirmSaid.textContent = `You said: "${current.said}"`;
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
    if (p.status === 'PAYING' || p.status === 'PAID') {
      showResult('ok', `Sent ${money(p.amount)} to ${p.payeeName}`, r.spoken, 'It usually arrives within a minute or two.');
      watchUntilPaid(p.id);
    } else if (p.status === 'HELD') {
      showResult('warn', `Paused: ${status.helperName} will check it`, r.spoken,
        'No money has been sent. The payment is waiting safely.', p.graceReasons || []);
    } else {
      showResult('bad', 'Not sent', r.spoken);
    }
    await say(r.spoken);
  } catch (err) {
    if (err.code === 'NOT_LINKED') {
      els.banner.classList.remove('hidden');
      showResult('bad', 'Connect PayPal first', 'Please connect your PayPal, then try again.');
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

// ---------- Start ----------

(async function init() {
  try {
    status = await api('/api/status');
  } catch { /* server not reachable: keep defaults */ }
  els.hello.textContent = `Hello, ${status.userName}`;
  els.banner.classList.toggle('hidden', status.paypalLinked);

  const link = new URLSearchParams(location.search).get('link');
  if (link === 'done') await say('Your PayPal is connected. Who would you like to pay?');
  if (link === 'failed') await say('Sorry, connecting PayPal did not work. Please try again.');
  if (link === 'cancelled') await say('Connecting PayPal was cancelled.');
  if (link) history.replaceState(null, '', '/grace.html');
})();
