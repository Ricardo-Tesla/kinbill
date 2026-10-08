// Starts the Kin-bill server.

import { createApp } from './app.js';
import { config, isPayPalConfigured } from './config.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`Kin-bill server running at http://localhost:${config.port}`);
  console.log(`Health check:  http://localhost:${config.port}/api/health`);
  if (!isPayPalConfigured()) {
    console.warn('PayPal credentials are missing. Copy .env.example to .env and fill them in.');
  }
});
