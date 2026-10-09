// Backup scam checker: simple keyword rules, no AI.
// Used (1) when no AI key is set or the AI fails, and (2) ALWAYS as a safety floor:
// the final risk can never be lower than what these keywords find, so the AI
// can't be talked into calling an obvious scam "safe".

export const TRIGGERS = ['URGENCY', 'NEW_PAYEE', 'GIFT_CARD', 'IMPERSONATION', 'UNUSUAL_AMOUNT', 'SECRECY', 'CRYPTO', 'COACHED'];

const PATTERNS = {
  URGENCY: [/\burgent/i, /\bright now\b/i, /\bimmediately\b/i, /\btoday\b/i, /\bbefore (it'?s|its) too late\b/i, /\bhurry\b/i, /\bas soon as possible\b/i, /\basap\b/i, /\bor else\b/i],
  GIFT_CARD: [/gift ?cards?/i, /itunes card/i, /google play card/i, /steam card/i, /\bvouchers?\b/i],
  IMPERSONATION: [
    /\b(from|calling from|this is) (paypal|the bank|my bank|your bank|microsoft|apple|amazon|the irs|irs|tax office|police|government|social security)/i,
    /account (is |has been )?(locked|suspended|frozen|blocked|compromised|hacked)/i,
    /\bverify (my|your) (account|identity)\b/i,
    /\b(tech|technical) support\b/i,
    /\brefund (department|team)\b/i,
    /\b(grandson|granddaughter|nephew|niece)\b.*\b(needs?|in trouble|jail|bail|hospital|stuck)\b/i,
  ],
  SECRECY: [/don'?t tell/i, /do not tell/i, /keep (it|this) (a )?secret/i, /between (you and me|us)/i, /\bsecret\b/i],
  CRYPTO: [/bitcoin/i, /\bcrypto/i, /\bbtc\b/i, /ethereum/i, /\busdt\b/i, /\bwallet address\b/i],
  // Someone told Grace what to say to the app: a classic sign she is being coached by a scammer.
  COACHED: [
    /\btell (the|this|your) (app|system|assistant|computer)\b/i,
    /\bignore (the|your|all|any) (rules|instructions|warnings|limits)\b/i,
    /\b(say|mark) (it|this)( is| as)? (safe|approved|fine)\b/i,
    /\bdon'?t (ask|tell|call) (david|my son)\b/i,
  ],
};

const WEIGHTS = { URGENCY: 25, GIFT_CARD: 45, IMPERSONATION: 45, SECRECY: 35, CRYPTO: 45, COACHED: 50 };

const WORD_NUMBERS = {
  ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  'one hundred': 100, 'a hundred': 100, hundred: 100, 'two hundred': 200, 'three hundred': 300,
  'five hundred': 500, 'six hundred': 600, 'one thousand': 1000, 'a thousand': 1000, thousand: 1000,
};

export function findTriggers(text = '') {
  return Object.entries(PATTERNS)
    .filter(([, patterns]) => patterns.some((re) => re.test(text)))
    .map(([trigger]) => trigger);
}

export function keywordRiskScore(triggers) {
  return Math.min(100, 5 + triggers.reduce((sum, t) => sum + (WEIGHTS[t] || 0), 0));
}

// Rough extraction of "who" and "how much" for when the AI isn't available.
export function roughIntent(text = '') {
  let amount = null;
  const digits = text.match(/\$?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(dollars|usd|bucks)?/i);
  if (digits) amount = Number(digits[1].replace(/,/g, ''));
  if (amount === null) {
    const lower = text.toLowerCase();
    const word = Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).find((w) => lower.includes(w));
    if (word) amount = WORD_NUMBERS[word];
  }
  const who = text.match(/\b(?:[Pp]ay|[Ss]end|[Gg]ive)\s+(?:(?:[Mm]y|[Tt]he|[Oo]ur)\s+)?(?:(?:plumber|gardener|grandson|granddaughter|son|daughter|friend|neighbou?r|doctor|landlord)\s+)?([A-Z][a-z]+)/);
  return {
    payee_name: who ? who[1] : 'unknown',
    payee_email: null,
    amount,
    currency: 'USD',
    note: text.slice(0, 140),
  };
}

export function keywordAnalysis(text) {
  const triggers = findTriggers(text);
  const intent = roughIntent(text);
  const risk = keywordRiskScore(triggers);
  return {
    intent,
    risk_score: risk,
    flagged_triggers: triggers,
    spoken_summary: risk >= 40
      ? 'This request has some warning signs, so I will ask David to check it first.'
      : `You asked to pay ${intent.payee_name}${intent.amount ? ` ${intent.amount} dollars` : ''}.`,
    helper_explanation: triggers.length
      ? `Keyword check found: ${triggers.join(', ').toLowerCase().replace(/_/g, ' ')}.`
      : 'Keyword check found no warning signs.',
  };
}
