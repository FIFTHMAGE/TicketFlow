const crypto = require('crypto');
const db = require('../db');
const ledger = require('../ledger');
const { sendTicketEmail } = require('../mailer');

const BASQET_SECRET = process.env.BASQET_WEBHOOK_SECRET;
const DEFAULT_BASQET_SECRET = 'basqet_secret_sandbox_123';

if (process.env.NODE_ENV === 'production' && (!BASQET_SECRET || BASQET_SECRET === DEFAULT_BASQET_SECRET)) {
  console.error('[BASQET] FATAL: BASQET_WEBHOOK_SECRET must be set to a non-default value in production.');
  process.exit(1);
}

const EFFECTIVE_SECRET = BASQET_SECRET || DEFAULT_BASQET_SECRET;

// Use the raw body buffer that express stores on req.rawBody for HMAC verification
function verifyBasqetSignature(req) {
  const signature = req.headers['x-basqet-signature'];
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

async function handleBasqetWebhook(req, res) {
  // 1. Signature Verification
  if (!verifyBasqetSignature(req)) {
    console.warn('[BASQET] Webhook signature verification failed');
    return res.status(401).json({ error: 'invalid signature' });
  }

  const { event, data } = req.body;
  const eventId = req.body.id || `evt_${Date.now()}`;

  try {
    // 2. Idempotency Check
    const existingEvent = await db.get('SELECT id FROM webhook_events WHERE id = ?', [eventId]);
    if (existingEvent) {
      return res.status(200).json({ status: 'already_processed' });
    }

    // Record event before processing to claim idempotency slot
    await db.run('INSERT INTO webhook_events (id, provider) VALUES (?, ?)', [eventId, 'basqet']);

    if (event === 'transaction.successful') {
      const reference = data?.reference;
      const confirmedAmount = parseFloat(data?.amount || 0);

      if (!reference) {
        return res.status(400).json({ error: 'Missing transaction reference in webhook payload' });
      }

      const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [reference]);
      if (tx && tx.status !== 'ALLOCATED_TO_LEDGER') {
        await db.run(
          'UPDATE transactions SET status = ?, confirmed_amount = ? WHERE reference = ?',
          ['PAYMENT_CONFIRMED', confirmedAmount, reference]
        );
        await ledger.recordPurchase(tx.reference, tx.gross_amount, tx.platform_id, tx.vendor_id);

        // Convert the reservation if exists
        try {
          const reservations = require('../reservations');
          const reservation = await db.get('SELECT id FROM reservations WHERE transaction_id = ?', [reference]);
          if (reservation) {
            await reservations.convertReservation(reservation.id);
          }
        } catch (resErr) {
          console.warn('[BASQET] Reservation conversion failed (non-fatal):', resErr.message);
        }

        // Send ticket email after confirmed ledger allocation
        try {
          await sendTicketEmail(tx);
        } catch (mailErr) {
          console.error('[BASQET] Ticket email failed (non-fatal):', mailErr.message);
        }
      }

    } else if (event === 'transaction.failed' || event === 'transaction.reversed') {
      const reference = data?.reference;
      if (reference) {
        await db.run(
          'UPDATE transactions SET status = ? WHERE reference = ? AND status NOT IN (?, ?)',
          ['PAYMENT_FAILED', reference, 'ALLOCATED_TO_LEDGER', 'REFUNDED']
        );
      }
    }

    res.status(200).json({ status: 'success' });
  } catch (err) {
    console.error('[BASQET] Webhook process error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  verifyBasqetSignature,
  handleBasqetWebhook
};
