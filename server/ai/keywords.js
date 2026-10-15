// Keywords: the backup scam checker, using simple keyword rules and no AI.
// Used (1) when no AI key is set or the AI fails, and (2) ALWAYS as a safety floor:
// the final risk can never be lower than what these keywords find, so the AI
// can't be talked into calling an obvious scam "safe".

// The only warning-sign codes allowed. An AI answer that uses any other code is rejected.
export const TRIGGERS = ['URGENCY', 'NEW_PAYEE', 'GIFT_CARD', 'IMPERSONATION', 'UNUSUAL_AMOUNT', 'SECRECY', 'CRYPTO', 'COACHED'];

// Phrases that point to each warning sign. NEW_PAYEE and UNUSUAL_AMOUNT are not here:
// they depend on Grace's history, not on her words.
const PATTERNS = {
  URGENCY: [/\burgent/i, /\bright now\b/i, /\bimmediately\b/i, /\btoday\b/i, /\bbefore (it'?s|its) too late\b/i, /\bhurry\b/i, /\bas soon as possible\b/i, /\basap\b/i, /\bor else\b/i],
  GIFT_CARD: [/gift ?cards?/i, /itunes card/i, /google play card/i, /steam card/i, /\bvouchers?\b/i],
  IMPERSONATION: [
    /\b(from|calling from|this is) (paypal|the bank|my bank|your bank|microsoft|apple|amazon|the irs|irs|tax office|police|government|social security)/i,
    /account (is |has been )?(locked|suspended|frozen|blocked|compromised|hacked)/i,
    /\bverify (my|your) (account|identity)\b/i,
    /\b(tech|technical) support\b/i,
    /\brefund (department|team)\b/i,
    // The "grandparent scam": a relative is said to be in trouble and to need money fast.
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

// Risk points per warning sign, added to a base of 5. Any serious sign on its own reaches
// the default ask-David threshold of 40; urgency on its own does not.
const WEIGHTS = { URGENCY: 25, GIFT_CARD: 45, IMPERSONATION: 45, SECRECY: 35, CRYPTO: 45, COACHED: 50 };

// Amounts spoken as words, for when speech-to-text does not write digits.
const WORD_NUMBERS = {
  ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  'one hundred': 100, 'a hundred': 100, hundred: 100, 'two hundred': 200, 'three hundred': 300,
  'five hundred': 500, 'six hundred': 600, 'one thousand': 1000, 'a thousand': 1000, thousand: 1000,
};

/**
 * Finds the warning signs whose phrases appear in the text.
 * @param {string} text  what Grace said
 * @returns {string[]} trigger codes found, each at most once
 */
export function findTriggers(text = '') {
  return Object.entries(PATTERNS)
    .filter(([, patterns]) => patterns.some((re) => re.test(text)))
    .map(([trigger]) => trigger);
}

/**
 * Turns warning signs into a risk score: 5 plus the weight of each sign, capped at 100.
 * @param {string[]} triggers  trigger codes
 * @returns {number} risk score 0-100
 */
export function keywordRiskScore(triggers) {
  return Math.min(100, 5 + triggers.reduce((sum, t) => sum + (WEIGHTS[t] || 0), 0));
}

/**
 * Roughly extracts "who" and "how much" for when the AI isn't available.
 * Digits are preferred over number words; the payee is the capitalised name after "pay", "send" or "give".
 * @param {string} text  what Grace said
 * @returns {object} intent in the same shape as the AI's (payee_name is 'unknown' if none is found)
 */
export function roughIntent(text = '') {
  let amount = null;
  const digits = text.match(/\$?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(dollars|usd|bucks)?/i);
  if (digits) amount = Number(digits[1].replace(/,/g, ''));
  if (amount === null) {
    const lower = text.toLowerCase();
    // Longest phrases first, so "two hundred" is found before "hundred".
    const word = Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).find((w) => lower.includes(w));
    if (word) amount = WORD_NUMBERS[word];
  }
  // A role word may come before the name ("pay my plumber Joe"); the name itself must be capitalised.
  const who = text.match(/\b(?:[Pp]ay|[Ss]end|[Gg]ive)\s+(?:(?:[Mm]y|[Tt]he|[Oo]ur)\s+)?(?:(?:plumber|gardener|grandson|granddaughter|son|daughter|friend|neighbou?r|doctor|landlord)\s+)?([A-Z][a-z]+)/);
  return {
    payee_name: who ? who[1] : 'unknown',
    payee_email: null,
    amount,
    currency: 'USD',
    note: text.slice(0, 140),
  };
}

/**
 * Full keyword-only analysis, in the same shape as the AI's answer.
 * Used when the AI is off or fails, so Grace is never blocked by an AI outage.
 * @param {string} text  what Grace said
 * @returns {object} intent, risk_score, flagged_triggers, spoken_summary and helper_explanation
 */
export function keywordAnalysis(text) {
  const triggers = findTriggers(text);
  const intent = roughIntent(text);
  const risk = keywordRiskScore(triggers);
  return {
    intent,
    risk_score: risk,
    flagged_triggers: triggers,
    // 40 matches the default ask-David threshold in the rules engine.
    spoken_summary: risk >= 40
      ? 'This request has some warning signs, so I will ask David to check it first.'
      : `You asked to pay ${intent.payee_name}${intent.amount ? ` ${intent.amount} dollars` : ''}.`,
    helper_explanation: triggers.length
      ? `Keyword check found: ${triggers.join(', ').toLowerCase().replace(/_/g, ' ')}.`
      : 'Keyword check found no warning signs.',
  };
}
