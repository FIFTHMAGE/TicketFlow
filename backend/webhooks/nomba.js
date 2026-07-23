const crypto = require('crypto');
const db = require('../db');
const settlement = require('../settlement');

const NOMBA_SECRET = process.env.NOMBA_WEBHOOK_SECRET;
const DEFAULT_NOMBA_SECRET = 'nomba_secret_sandbox_123';

if (process.env.NODE_ENV === 'production' && (!NOMBA_SECRET || NOMBA_SECRET === DEFAULT_NOMBA_SECRET)) {
  console.warn('[NOMBA] WARNING: NOMBA_WEBHOOK_SECRET is using default or missing values. Signature verification will fail in production.');
}

const EFFECTIVE_SECRET = NOMBA_SECRET || DEFAULT_NOMBA_SECRET;

// Use raw body buffer for HMAC verification
function verifyNombaSignature(req) {
  const signature = req.headers['x-nomba-signature'];
  if (!signature) return false;

  const bodyToSign = req.rawBody || JSON.stringify(req.body);

  const expected = crypto
    .createHmac('sha256', EFFECTIVE_SECRET)
    .update(bodyToSign)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch (err) {
    return false;
  }
}

async function handleNombaWebhook(req, res) {
  // 1. Signature Verification
  if (!verifyNombaWebhook(req)) {
    console.warn('[NOMBA] Webhook signature verification failed');
    return res.status(401).json({ error: 'invalid signature' });
  }

  const { eventId, payoutId, status, providerRef } = req.body;

  if (!payoutId) {
    return res.status(400).json({ error: 'Missing payoutId in webhook payload' });
  }

  const uniqueEventId = eventId || `nomba_evt_${Date.now()}`;

  try {
    // 2. Idempotency check
    const existingEvent = await db.get('SELECT id FROM webhook_events WHERE id = ?', [uniqueEventId]);
    if (existingEvent) {
      return res.status(200).json({ status: 'already_processed' });
    }

    await db.run('INSERT INTO webhook_events (id, provider) VALUES (?, ?)', [uniqueEventId, 'nomba']);

    // 3. Process webhook
    const response = await settlement.processNombaWebhook(payoutId, status, providerRef);
    res.json(response);
  } catch (err) {
    console.error('[NOMBA] Webhook process error:', err);
    res.status(500).json({ error: err.message });
  }
}

// Fix function name typo — was verifyNombaSignature called as verifyNombaWebhook
function verifyNombaWebhook(req) {
  return verifyNombaSignature(req);
}

module.exports = {
  verifyNombaSignature,
  handleNombaWebhook
};
