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
| 8. Safety timer (auto-cancel), activity log, PayPal webhooks (verified) | Done (webhooks switch on after deploy) |
| 9. Accessibility: keyboard, screen readers, contrast, text size, voice speed | Done: `npm test` includes accessibility checks |
| 9b. Grace's safety rules: she can make them stricter, only David can loosen them | Done |
| 9c. Visual design "Family Check": PayPal-aligned navy, light / dark / auto themes | Done |
| 10 | Coming |

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

## Feature 8: safety timer, activity log, webhooks

- **Safety timer**: a held payment nobody decides on is voided after `HOLD_TIMEOUT_SECONDS`
  (48 h by default; set `120` for a 2-minute demo). Checked every `SWEEP_INTERVAL_SECONDS`.
  Grace hears that it was cancelled and that no money was sent.
- **Activity log**: every step (Grace asked, AI checked, rules, held, David approved, PayPal delivered,
  timer cancelled, ...) is recorded in `audit_log` and shown on David's screen (AG Grid).
- **Restarts are safe**: payouts still on their way are checked again when the server starts.
- **PayPal webhooks** at `POST /api/paypal/webhook`: every event's signature is verified with PayPal
  (`/v1/notifications/verify-webhook-signature`) before use; repeats are ignored. Needs a public URL
  and `PAYPAL_WEBHOOK_ID`, so it is switched on after deploying (feature 10).

## Feature 9: accessibility

Kin-bill is built for people with low vision, so accessibility is the product, not an extra.

- **Keyboard only**: every control works with Tab / Enter / Space. A **Skip to main content** link comes first.
  On "Is this right?" press **Y** for yes, **N** or **Esc** for no, **R** to hear it again (ignored while typing).
- **Screen readers**: everything Kin-bill says is also announced (live regions); focus moves to each new step;
  every button and field has a name; David's held cards are named "$40.00 to ..." and his buttons say who they pay.
- **Seeing**: 24 px base text, big targets (88 px buttons), thick yellow focus ring, AAA contrast (7:1+) for main text,
  works in Windows High Contrast mode, no zoom blocking, no motion.
- **Grace's comfort settings** (remembered on her device): text size **A / A+ / A++** and voice speed **Normal / Slower**,
  plus a **Say it again** button.
- **David's tables (AG Grid)**: rows and columns kept in reading order for screen readers, taller rows.
- Checked with **axe-core** in Chromium (0 violations on all pages, WCAG 2.2 AA rules) and by `test/a11y.test.js`
  (labels, button names, skip link, contrast ratios).

## Grace's safety rules

- **Grace's screen > My safety rules**: her rules in plain words, **Read my rules aloud**, and **Make my rules safer**
  (lower the limit, a more careful scam check, ask David about new people).
- **Only David can loosen rules** (raise the limit, relax the scam check), on his PIN screen.
  If Grace tries, nothing changes, she hears why, and David sees a warning: someone may be pressuring her.
  Scammers often tell people to "switch off" protections; this makes that impossible from Grace's side.
- Always on, whatever the settings: gift cards, crypto, secrecy, coaching, and people not in her contacts wait for David.
- API: `GET /api/settings`, `POST /api/settings` (stricter only), `POST /api/helper/settings` (PIN). Every change is in the activity log.

## Visual design: "Family Check"

- **PayPal-aligned colours**: one consistent PayPal blue (#0070BA) for every button, the talk button, selected
  options, table headers and links, with PayPal's deep navy as the text colour and pill-shaped buttons.
  Green, amber and red are kept only for meaning (sent, waiting, stopped).
  Kin-bill keeps its own name and logo and says it is not made or endorsed by PayPal.
- **Signature pieces**: a round talk button that pulses only while listening; the confirm step laid out like a cheque
  (Pay to / Amount / You said); a status pill on every result (Sent, Waiting for David, Not sent), never colour alone;
  David's decisions are signed ("Checked by David").
- **Themes**: Auto (follows the device), Light, Dark: the **Screen** buttons on every page, remembered per device.
  David's AG Grid tables switch too (Quartz theme with light and dark params).
- **Type**: Atkinson Hyperlegible Next and Mono (Braille Institute, designed for low vision), served from our own server.
- Contrast is tested for both themes in `test/a11y.test.js`; axe-core finds 0 issues on every page in light and dark.

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
public/             landing page, Grace's screen (grace.*), David's screen (david.*), styles.css, theme.js (light/dark/auto)
scripts/            check-paypal.js, spike-paypal.js
test/               node:test unit tests with a fake fetch
```

## License

MIT, see [LICENSE](LICENSE).
