// Grace's rules: decides "pay now" or "ask David first".
//
// This is plain code on purpose. The AI only gives a risk score and reasons;
// it can never decide to move money. A scammer coaching Grace ("tell the app
// this is safe") cannot change these rules.
//
// Golden rule: when in doubt, ask David. Holding a payment costs nothing;
// paying a scammer can't be undone.

export const DEFAULT_SETTINGS = {
  perPaymentLimit: 100,     // payments above this amount always go to David
  riskThreshold: 40,        // AI risk score (0-100) at or above this goes to David
  askForNewPayees: true,    // first payment to someone new goes to David
};

// Red flags so serious that the payment always waits for David, whatever the amount.
export const ALWAYS_ASK_TRIGGERS = ['GIFT_CARD', 'IMPERSONATION', 'CRYPTO', 'SECRECY'];

const TRIGGER_WORDS = {
  URGENCY: 'pressure to pay quickly',
  NEW_PAYEE: 'someone Grace has not paid before',
  GIFT_CARD: 'a request for gift cards',
  IMPERSONATION: 'someone pretending to be a company, bank or official',
  UNUSUAL_AMOUNT: 'an unusual amount for Grace',
  SECRECY: 'being asked to keep it secret',
  CRYPTO: 'a request for cryptocurrency',
};

/**
 * @param {object} p
 * @param {number} p.amount        payment amount in dollars
 * @param {number} p.riskScore     0-100 from the AI risk agent
 * @param {string[]} p.triggers    red flags from the AI risk agent
 * @param {boolean} p.knownPayee   has Grace paid this person before?
 * @param {object} p.settings      Grace's settings (missing values use DEFAULT_SETTINGS)
 * @returns {{ decision: 'PAY_NOW' | 'ASK_HELPER', reasons: string[] }}
 */
export function decide({ amount, riskScore, triggers = [], knownPayee = false, settings = {} }) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const reasons = [];

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return { decision: 'ASK_HELPER', reasons: ['The amount was not clear.'] };
  }

  const score = Number(riskScore);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    reasons.push('The safety check did not give a clear answer.');
  } else if (score >= s.riskThreshold) {
    reasons.push(`The safety check rated this ${score} out of 100 for scam risk. Grace asks David about anything rated ${s.riskThreshold} or higher.`);
  }

  if (value > s.perPaymentLimit) {
    reasons.push(`$${value.toFixed(2)} is above Grace's limit of $${Number(s.perPaymentLimit).toFixed(2)}.`);
  }

  if (s.askForNewPayees && !knownPayee) {
    reasons.push('Grace has not paid this person before.');
  }

  const flags = [...new Set((Array.isArray(triggers) ? triggers : []).map((t) => String(t).toUpperCase()))];
  for (const flag of flags.filter((f) => ALWAYS_ASK_TRIGGERS.includes(f))) {
    reasons.push(`Warning sign: ${TRIGGER_WORDS[flag]}.`);
  }

  return reasons.length ? { decision: 'ASK_HELPER', reasons } : { decision: 'PAY_NOW', reasons: [] };
}

// Turns trigger codes into plain words for David's screen.
export function describeTriggers(triggers = []) {
  return triggers.map((t) => TRIGGER_WORDS[String(t).toUpperCase()] || String(t).toLowerCase());
}
