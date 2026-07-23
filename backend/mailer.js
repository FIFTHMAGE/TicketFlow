const { Resend } = require('resend');
const QRCode = require('qrcode');

const FROM_EMAIL = process.env.FROM_EMAIL || 'tickets@stableflow.io';

// Lazily instantiated so server starts without throwing when key is absent
let _resend = null;
function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

/**
 * Generate a QR code data URI for the ticket reference
 */
async function generateTicketQR(reference) {
  return QRCode.toDataURL(reference, {
    width: 200,
    margin: 2,
    color: { dark: '#0B0D0A', light: '#F3EFE3' }
  });
}

/**
 * Send a ticket confirmation email with embedded QR code
 * @param {Object} tx - Transaction record from database
 * @param {string} [customerEmail] - Override email (if not stored on tx)
 * @param {string} [customerName] - Override name
 * @param {string} [eventName] - Event display name
 */
async function sendTicketEmail(tx, customerEmail, customerName, eventName) {
  const email = customerEmail || tx.customer_email || null;
  const name = customerName || tx.customer_name || 'Guest';
  const event = eventName || 'StableFlow Event';

  if (!email) {
    console.warn('[MAILER] No email address for transaction', tx.reference, '— skipping ticket email');
    return;
  }

  const client = getResend();
  if (!client) {
    console.warn('[MAILER] RESEND_API_KEY not set — skipping ticket email');
    return;
  }

  const qrDataUri = await generateTicketQR(tx.reference);
  // Extract base64 from data URI for inline attachment
  const qrBase64 = qrDataUri.replace('data:image/png;base64,', '');

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { margin: 0; padding: 0; background: #0B0D0A; font-family: 'Inter', Arial, sans-serif; }
    .container { max-width: 480px; margin: 40px auto; background: #171912; border-radius: 14px; overflow: hidden; }
    .header { background: #92CB3C; padding: 24px 32px; }
    .header h1 { margin: 0; color: #0B0D0A; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
    .body { padding: 32px; color: #EDEDE6; }
    .event-name { font-size: 18px; font-weight: 600; color: #92CB3C; margin-bottom: 8px; }
    .ref { font-family: monospace; font-size: 13px; color: #C9C2AC; margin-bottom: 24px; }
    .qr-box { text-align: center; margin: 24px 0; }
    .qr-box img { border-radius: 8px; }
    .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(237,237,230,0.1); font-size: 13px; }
    .detail-label { color: #C9C2AC; }
    .detail-value { color: #EDEDE6; font-weight: 500; }
    .footer { padding: 20px 32px; font-size: 11px; color: #6E6E6E; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>✦ Your Ticket</h1>
    </div>
    <div class="body">
      <div class="event-name">${event}</div>
      <div class="ref">Ref: ${tx.reference}</div>
      <div class="qr-box">
        <img src="cid:ticket-qr" width="200" height="200" alt="Ticket QR Code" />
      </div>
      <div class="detail-row">
        <span class="detail-label">Name</span>
        <span class="detail-value">${name}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Amount Paid</span>
        <span class="detail-value">₦${tx.gross_amount.toLocaleString()}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Status</span>
        <span class="detail-value" style="color: #92CB3C;">CONFIRMED</span>
      </div>
    </div>
    <div class="footer">
      Present this QR code at the gate. Powered by StableFlow.
    </div>
  </div>
</body>
</html>
`;

  try {
    const result = await client.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `Your Ticket — ${event}`,
      html,
      attachments: [
        {
          filename: 'ticket-qr.png',
          content: qrBase64,
          content_id: 'ticket-qr',
          content_type: 'image/png'
        }
      ]
    });
    console.log('[MAILER] Ticket email sent to', email, '| ID:', result?.id);
    return result;
  } catch (err) {
    console.error('[MAILER] Failed to send ticket email:', err.message);
    throw err;
  }
}

module.exports = { sendTicketEmail, generateTicketQR };
