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
| 3. Link PayPal once (vault), pay with no browser | Spike script ready: `npm run spike:vault` |
| 4–10 | Coming |

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

## Project layout

```
server/
  index.js          starts the server
  app.js            routes (health checks so far)
  config.js         reads .env; refuses to run against live PayPal
  paypal/client.js  OAuth token + request helper
  paypal/orders.js  create / capture / authorize / void
scripts/            check-paypal.js, spike-paypal.js
test/               node:test unit tests with a fake fetch
```

## License

MIT, see [LICENSE](LICENSE).
