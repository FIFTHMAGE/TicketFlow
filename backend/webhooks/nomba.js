const crypto = require('crypto');
const db = require('../db');
const settlement = require('../settlement');

const NOMBA_SECRET = process.env.NOMBA_WEBHOOK_SECRET || 'nomba_secret_sandbox_123';

function verifyNombaSignature(req) {
  const signature = req.headers['x-nomba-signature'];
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', NOMBA_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (err) {
    return false;
  }
}

async function handleNombaWebhook(req, res) {
  // 1. Signature Verification
  if (!verifyNombaSignature(req)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  const { eventId, payoutId, status, providerRef } = req.body;
  const uniqueEventId = eventId || `nomba_evt_${Date.now()}`;

  try {
    // 2. Idempotency check
    const existingEvent = await db.get('SELECT * FROM webhook_events WHERE id = ?', [uniqueEventId]);
    if (existingEvent) {
      return res.status(200).json({ status: 'already_processed' });
    }

    // Record the webhook event for idempotency
    await db.run('INSERT INTO webhook_events (id, provider) VALUES (?, ?)', [uniqueEventId, 'nomba']);

    // 3. Process webhook logic
    const response = await settlement.processNombaWebhook(payoutId, status, providerRef);
    res.json(response);
  } catch (err) {
    console.error('Nomba Webhook process error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  verifyNombaSignature,
  handleNombaWebhook
};
