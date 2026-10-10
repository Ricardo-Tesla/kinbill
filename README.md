# Kin-bill

**Your family has your back before money moves.**

Kin-bill is a voice-first PayPal payment assistant for older and low-vision adults.
An AI risk agent checks every payment for scam signs. Low-risk payments are paid at once;
risky ones are only *authorized* (funds held, nothing moves) and wait for a trusted family
member's approval. If they reject, or don't answer in time, the hold is voided.

Built for the PayPal "Build What's Next with PayPal and AI" hackathon. Sandbox only.

## Status

| Feature | State |
| --- | --- |
| 1. Server skeleton, health check, PayPal token helper | Done |
| 2. Sandbox spike: capture, hold then void, hold then capture then payout | Done (passed in sandbox) |
| 3. Link PayPal once (vault), pay with no browser | Done (passed in sandbox) |
| 4. Grace's rules + database (settings, people paid before) | Done: `npm run try:rules` |
| 5. AI scam checker (Gemini or Claude, keyword safety floor) | Done: `npm run try:ai` |
| 6. Grace's voice screen: speak, hear it read back, yes/no, real sandbox payment | Done: `npm run dev`, open /grace.html |
| 7. David's helper screen: held payments, reasons, approve / reject, live updates, AG Grid history | Done: open /david.html |
| 8–10 | Coming |

## Requirements

- Node.js 22.9 or newer (24 LTS recommended)
- A free PayPal Developer account with a sandbox app and test accounts

## Setup

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
# fill in .env with your sandbox values
npm run check:paypal      # should print SUCCESS
npm run dev               # http://localhost:3000/api/health
npm test                  # unit tests, no network needed
```

## Feature 2: sandbox spike

```bash
npm run spike
```

For each test, open the printed link, log in as the sandbox **buyer** (Grace), approve,
then press Enter in the terminal. Expected: three PASS lines, and Joe's sandbox account
shows $80 and $150 received, but not the voided $600.

## Feature 3: link PayPal once

```bash
npm run spike:vault          # V1 needs Grace's approval in the browser once
npm run spike:vault -- V2    # rerun V2 and V3 with the saved link, no browser
```

## Feature 6: Grace's screen

```bash
npm run dev
```

Open **http://localhost:3000/grace.html** in Chrome or Edge (best for voice).

- Press **Tap and speak** and say *"Pay my plumber Joe 80 dollars"*, or use **Type instead** / the example buttons.
- Kin-bill reads it back; answer **yes** or **no** (voice or the big buttons).
- Safe payments to known contacts are charged to Kin-bill and paid out to the contact.
  Risky payments, new people and anyone not in Grace's contacts are **held** for David.
- Demo contacts: *Joe the plumber* (paid before) and *Sam the gardener* (new). Both use `PAYEE_JOE_EMAIL`.
- If PayPal isn't connected yet, press **Connect PayPal** (one time, $1 check released straight away).
  A link saved by `npm run spike:vault` is reused automatically.

## Feature 7: David's helper screen

Open **http://localhost:3000/david.html** and enter the `HELPER_PIN` from `.env` (default in `.env.example`: `2468`).

- **Waiting for you**: every held payment with the amount, what Grace said, the scam-risk score, the AI's explanation and the reasons.
- **Approve and pay**: Kin-bill captures the held money and pays it out to the contact (PayPal Payouts).
  If the person is not in Grace's contacts, David must enter their PayPal email; they are added to her contacts.
- **Reject**: the hold is voided; no money moves.
- Updates live (Server-Sent Events). Grace's screen tells her David's decision if her "Paused" box is still open.
- **All payments**: history table built with **AG Grid** (sponsor), served from `node_modules`, no CDN.

## Project layout

```
server/
  index.js          starts the server
  app.js            routes (health checks so far)
  config.js         reads .env; refuses to run against live PayPal
  paypal/client.js  OAuth token + request helper
  paypal/orders.js  create / capture / authorize / void / payouts
  rules/engine.js   Grace's rules: pay now or ask David
  db.js             SQLite (built into Node): settings, contacts, PayPal link, payments
  ai/               AI scam checker + keyword safety floor
  payments/service.js  the payment flow: read back, pay now or hold for David
public/             Grace's screen (grace.*), David's screen (david.*), styles, landing page
scripts/            check-paypal.js, spike-paypal.js
test/               node:test unit tests with a fake fetch
```

## License

MIT, see [LICENSE](LICENSE).
