// Builds the Express app. Kept separate from index.js so tests can use it without opening a port.

import express from 'express';
import { isPayPalConfigured } from './config.js';
import { getAccessToken } from './paypal/client.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  // Quick "is the server alive?" check.
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      app: 'kinbill',
      paypalConfigured: isPayPalConfigured(),
    });
  });

  // Checks that our PayPal sandbox credentials actually work.
  app.get('/api/health/paypal', async (req, res) => {
    try {
      await getAccessToken({ forceRefresh: true });
      res.json({ paypal: 'connected' });
    } catch (err) {
      res.status(502).json({ paypal: 'error', message: err.message });
    }
  });

  return app;
}
