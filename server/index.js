// Starts the Kin-bill server.

import { createApp } from './app.js';
import { config, isPayPalConfigured } from './config.js';
import { openDb, seedDemoContacts, importLegacyVault, getVaultId } from './db.js';
import { createPaymentService } from './payments/service.js';

const db = openDb();
seedDemoContacts(db, config.payeeJoeEmail);
if (importLegacyVault(db)) console.log('Reused the saved PayPal link from .kinbill-vault.json');

const service = createPaymentService({
  db,
  holdTimeoutSeconds: config.holdTimeoutSeconds,
  publicUrl: config.publicUrl,
  userName: config.userName,
  helperName: config.helperName,
});

const app = createApp({ db, service });

// Safety timer: cancels holds nobody decided in time, and resumes payout checks after a restart.
service.startTimers({ intervalMs: config.sweepIntervalSeconds * 1000 });

app.listen(config.port, () => {
  console.log(`Kin-bill is running:  ${config.publicUrl}`);
  console.log(`Grace's screen:       ${config.publicUrl}/grace.html`);
  if (!isPayPalConfigured()) console.warn('PayPal credentials are missing. Copy .env.example to .env and fill them in.');
  if (!config.payeeJoeEmail) console.warn('PAYEE_JOE_EMAIL is missing in .env, so no demo contacts were added.');
  console.log(`Safety timer:         holds are cancelled after ${Math.round(config.holdTimeoutSeconds / 60)} min without a decision`);
  if (!getVaultId(db)) console.log(`${config.userName}'s PayPal is not connected yet: open Grace's screen and press "Connect PayPal".`);
});
