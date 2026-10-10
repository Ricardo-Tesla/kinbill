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
export const ALWAYS_ASK_TRIGGERS = ['GIFT_CARD', 'IMPERSONATION', 'CRYPTO', 'SECRECY', 'COACHED'];

// Gentle words for Grace herself: explain, never frighten or blame.
const TRIGGER_WORDS_FOR_GRACE = {
  GIFT_CARD: 'Real companies and family members rarely ask for gift cards.',
  IMPERSONATION: 'Someone may be pretending to be a company, an official or a relative.',
  SECRECY: 'You were asked to keep it a secret.',
  CRYPTO: 'Requests for cryptocurrency are often tricks.',
  COACHED: 'Someone told you what to say to Kin-bill.',
};

const TRIGGER_WORDS = {
  URGENCY: 'pressure to pay quickly',
  NEW_PAYEE: 'someone Grace has not paid before',
  GIFT_CARD: 'a request for gift cards',
  IMPERSONATION: 'someone who may be pretending to be a company, official or family member',
  UNUSUAL_AMOUNT: 'an unusual amount for Grace',
  SECRECY: 'being asked to keep it secret',
  CRYPTO: 'a request for cryptocurrency',
  COACHED: 'someone telling Grace what to say to Kin-bill',
};

/**
 * @param {object} p
 * @param {number} p.amount        payment amount in dollars
 * @param {number} p.riskScore     0-100 from the AI risk agent
 * @param {string[]} p.triggers    red flags from the AI risk agent
 * @param {boolean} p.knownPayee   has Grace paid this person before?
 * @param {object} p.settings      Grace's settings (missing values use DEFAULT_SETTINGS)
 * @param {string} p.payeeName     who is being paid (used in Grace's wording)
 * @returns {{ decision: 'PAY_NOW' | 'ASK_HELPER', reasons: string[], graceReasons: string[] }}
 *   reasons:      for David (direct, detailed)
 *   graceReasons: for Grace (gentle, "you" wording), same order
 */
export function decide({ amount, riskScore, triggers = [], knownPayee = false, settings = {}, payeeName = '' }) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const reasons = [];
  const graceReasons = [];
  const add = (forDavid, forGrace) => { reasons.push(forDavid); graceReasons.push(forGrace); };
  const them = payeeName && payeeName.toLowerCase() !== 'unknown' ? payeeName : 'this person';

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return { decision: 'ASK_HELPER', reasons: ['The amount was not clear.'], graceReasons: ['I was not sure about the amount.'] };
  }

  const score = Number(riskScore);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    add('The safety check did not give a clear answer.', 'I could not finish my safety check, so a second look is safer.');
  } else if (score >= s.riskThreshold) {
    add(`The safety check rated this ${score} out of 100 for scam risk. Grace asks David about anything rated ${s.riskThreshold} or higher.`,
      'Something about this request sounds like a common trick, so a second look is safer.');
  }

  if (value > s.perPaymentLimit) {
    add(`$${value.toFixed(2)} is above Grace's limit of $${Number(s.perPaymentLimit).toFixed(2)}.`,
      `It is more than your limit of $${Number(s.perPaymentLimit).toFixed(2)}.`);
  }

  if (s.askForNewPayees && !knownPayee) {
    add('Grace has not paid this person before.', `You have not paid ${them} before.`);
  }

  const flags = [...new Set((Array.isArray(triggers) ? triggers : []).map((t) => String(t).toUpperCase()))];
  for (const flag of flags.filter((f) => ALWAYS_ASK_TRIGGERS.includes(f))) {
    add(`Warning sign: ${TRIGGER_WORDS[flag]}.`, TRIGGER_WORDS_FOR_GRACE[flag]);
  }

  return reasons.length
    ? { decision: 'ASK_HELPER', reasons, graceReasons }
    : { decision: 'PAY_NOW', reasons: [], graceReasons: [] };
}

// Turns trigger codes into plain words for David's screen.
export function describeTriggers(triggers = []) {
  return triggers.map((t) => TRIGGER_WORDS[String(t).toUpperCase()] || String(t).toLowerCase());
}
