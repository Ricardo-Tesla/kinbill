// Run with:  npm run try:rules
// Shows, in plain words, what Grace's rules decide for some everyday and scam situations.
// No PayPal, no AI: the risk scores below are examples of what the AI might return.

import { decide } from '../server/rules/engine.js';

const situations = [
  { story: 'Pay Joe the plumber $80 (paid him before)', amount: 80, riskScore: 5, triggers: [], knownPayee: true },
  { story: 'Pay the new gardener $40', amount: 40, riskScore: 10, triggers: [], knownPayee: false },
  { story: 'Pay Joe $250 for a big repair', amount: 250, riskScore: 10, triggers: [], knownPayee: true },
  { story: '"PayPal says my account is locked, send $600 today"', amount: 600, riskScore: 92, triggers: ['URGENCY', 'IMPERSONATION'], knownPayee: false },
  { story: '"My grandson needs $50 in gift cards, don\'t tell his dad"', amount: 50, riskScore: 88, triggers: ['GIFT_CARD', 'SECRECY'], knownPayee: true },
];

console.log("Grace's rules: pay now, or ask David first?\n");
for (const s of situations) {
  const { decision, reasons } = decide(s);
  console.log(`${decision === 'PAY_NOW' ? 'PAY NOW  ' : 'ASK DAVID'}  ${s.story}`);
  for (const r of reasons) console.log(`             - ${r}`);
}
