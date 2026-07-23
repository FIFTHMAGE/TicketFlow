const crypto = require('crypto');
const db = require('../db');
const ledger = require('../ledger');

const BASQET_SECRET = process.env.BASQET_WEBHOOK_SECRET || 'basqet_secret_sandbox_123';

function verifyBasqetSignature(req) {
  const signature = req.headers['x-basqet-signature'];
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', BASQET_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (err) {
    return false;
  }
}

async function handleBasqetWebhook(req, res) {
  // 1. Signature Verification
  if (!verifyBasqetSignature(req)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  const { event, data } = req.body;
  const eventId = req.body.id || `evt_${Date.now()}`; // Basqet event identifier

  try {
    // 2. Idempotency Check
    const existingEvent = await db.get('SELECT * FROM webhook_events WHERE id = ?', [eventId]);
    if (existingEvent) {
      // Already processed, return 200 OK (no-op)
      return res.status(200).json({ status: 'already_processed' });
    }

    // Record the webhook event to ensure idempotency
    await db.run('INSERT INTO webhook_events (id, provider) VALUES (?, ?)', [eventId, 'basqet']);

    if (event === 'transaction.successful') {
      const reference = data.reference;
      const confirmedAmount = parseFloat(data.amount);

      const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [reference]);
      if (tx) {
        if (tx.status !== 'ALLOCATED_TO_LEDGER') {
          // Update transaction state with confirmed amount from webhook
          await db.run(
            'UPDATE transactions SET status = ?, confirmed_amount = ? WHERE reference = ?',
            ['PAYMENT_CONFIRMED', confirmedAmount, reference]
          );

          // Apply double-entry allocation
          await ledger.recordPurchase(tx.reference, tx.gross_amount, tx.platform_id, tx.vendor_id);
        }
      }
    }

    res.status(200).json({ status: 'success' });
  } catch (err) {
    console.error('Basqet Webhook process error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  verifyBasqetSignature,
  handleBasqetWebhook
};
