// Server start-up: prepares the database and starts the Kin-bill web server.
// Restores Grace's saved PayPal link, builds the payment service and the app (app.js),
// starts the safety timer that cancels holds nobody decided, then listens for visitors.

import { createApp } from './app.js';
import { config, isPayPalConfigured } from './config.js';
import { openDb, seedDemoContacts, importLegacyVault, importVaultFromEnv, seedDemoHistory, getVaultId } from './db.js';
import { createPaymentService } from './payments/service.js';

// Each step below only adds data that is missing, so restarting is safe.
// The saved PayPal link can come from an old local file or from KINBILL_VAULT_ID,
// because free hosts like Render may wipe the database on restart.
const db = openDb();
seedDemoContacts(db, config.payeeJoeEmail);
if (importLegacyVault(db)) console.log('Reused the saved PayPal link from .kinbill-vault.json');
if (importVaultFromEnv(db, config.vaultId)) console.log('Restored the saved PayPal link from KINBILL_VAULT_ID');
if (config.demo && seedDemoHistory(db, config)) console.log('Demo mode: added example payments to the history');

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

// Listen on all interfaces so a host like Render can reach the server.
// The start-up messages say where to open the app and what still needs setting up.
app.listen(config.port, '0.0.0.0', () => {
  console.log(`Kin-bill is running:  ${config.publicUrl}`);
  console.log(`Grace's screen:       ${config.publicUrl}/grace.html`);
  if (!isPayPalConfigured()) console.warn('PayPal credentials are missing. Copy .env.example to .env and fill them in.');
  if (!config.payeeJoeEmail) console.warn('PAYEE_JOE_EMAIL is missing in .env, so no demo contacts were added.');
  console.log(`Safety timer:         holds are cancelled after ${Math.round(config.holdTimeoutSeconds / 60)} min without a decision`);
  if (!getVaultId(db)) console.log(`${config.userName}'s PayPal is not connected yet: open Grace's screen and press "Connect PayPal".`);
});
