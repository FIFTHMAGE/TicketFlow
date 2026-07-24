const { Resend } = require('resend');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';

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
 * Generate a PDF ticket and return it as a Buffer
 */
async function generateTicketPDF(tx, eventName, name) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', err => reject(err));

      // Header card
      doc.rect(40, 40, 515, 80).fill('#92CB3C');
      doc.fillColor('#0B0D0A')
         .font('Helvetica-Bold')
         .fontSize(22)
         .text('ADMISSION TICKET', 60, 65)
         .fontSize(10)
         .font('Helvetica')
         .text('Present this document at the gate scanner console', 60, 92);

      // Event details
      doc.fillColor('#171912')
         .font('Helvetica-Bold')
         .fontSize(18)
         .text(eventName, 40, 160)
         .fontSize(10)
         .fillColor('#6E6E6E')
         .text('EVENT DESCRIPTION & ACCESS INFO', 40, 190);

      // Event metadata block
      doc.fillColor('#0B0D0A')
         .fontSize(11)
         .font('Helvetica-Bold')
         .text('Attendee Name:', 40, 220)
         .font('Helvetica')
         .text(name, 160, 220)
         
         .font('Helvetica-Bold')
         .text('Ticket Reference:', 40, 240)
         .font('Helvetica-Oblique')
         .text(tx.reference, 160, 240)
         
         .font('Helvetica-Bold')
         .text('Amount Paid:', 40, 260)
         .font('Helvetica')
         .text(`₦${tx.gross_amount.toLocaleString()}`, 160, 260)
         
         .font('Helvetica-Bold')
         .text('Status:', 40, 280)
         .font('Helvetica')
         .text('CONFIRMED', 160, 280);

      // Add a line divider
      doc.moveTo(40, 310).lineTo(555, 310).strokeColor('#E9E3D2').stroke();

      // Embed the QR Code
      const qrBuffer = await QRCode.toBuffer(tx.reference, {
        type: 'png',
        width: 180,
        margin: 1
      });

      doc.image(qrBuffer, 207, 340, { width: 180 });

      doc.fillColor('#7A7462')
         .fontSize(9)
         .font('Helvetica-Oblique')
         .text('Secured and processed by StableFlow ticket settlement network.', 40, 540, { align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Send a ticket confirmation email with inline QR code and PDF ticket attachment
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
  const qrBase64 = qrDataUri.replace('data:image/png;base64,', '');

  // Generate PDF attachment
  let pdfBuffer;
  try {
    pdfBuffer = await generateTicketPDF(tx, event, name);
  } catch (pdfErr) {
    console.error('[MAILER] Failed to generate PDF ticket:', pdfErr);
  }

  // Beautiful modern clean email content matching Tix / Red Bull style
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; background: #FAF9F6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
    .container { max-width: 520px; margin: 40px auto; background: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.05); border: 1px solid #EDEDE6; }
    .header { background: #92CB3C; padding: 32px; text-align: left; }
    .header h1 { margin: 0; color: #0B0D0A; font-size: 24px; font-weight: 800; letter-spacing: -0.02em; }
    .body { padding: 32px; color: #171912; }
    .greeting { font-size: 18px; font-weight: 700; color: #0B0D0A; margin-bottom: 20px; }
    .event-card { background: #FAF9F6; border: 1px solid #EDEDE6; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
    .event-title { font-size: 18px; font-weight: 800; color: #0B0D0A; margin-bottom: 6px; }
    .event-meta { font-size: 13px; color: #7A7462; line-height: 1.5; margin-bottom: 4px; }
    .summary-title { font-size: 14px; font-weight: 700; color: #0B0D0A; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; border-bottom: 2px solid #EDEDE6; padding-bottom: 6px; }
    
    /* Cross-client safe table styling to replace flexbox layout */
    .detail-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    .detail-row td { padding: 10px 0; border-bottom: 1px dashed #EDEDE6; font-size: 14px; }
    .detail-table tr:last-of-type td { border-bottom: none; }
    .detail-label { color: #7A7462; text-align: left; }
    .detail-value { color: #0B0D0A; font-weight: 600; text-align: right; word-break: break-all; }
    
    .qr-box { text-align: center; margin: 32px 0; padding: 20px; background: #FAF9F6; border-radius: 12px; border: 1px dashed #EDEDE6; }
    .qr-box img { border-radius: 6px; display: inline-block; }
    .footer { padding: 24px 32px; font-size: 12px; color: #7A7462; text-align: center; background: #FAF9F6; border-top: 1px solid #EDEDE6; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Order Confirmed</h1>
    </div>
    <div class="body">
      <div class="greeting">${name}, you're officially in!</div>
      
      <div class="event-card">
        <div class="event-title">${event}</div>
        <div class="event-meta">📍 Venue Admission Gate Console</div>
        <div class="event-meta">🎫 Status: Confirmed & Paid</div>
      </div>
 
      <div class="summary-title">Order Summary</div>
      <table class="detail-table">
        <tr class="detail-row">
          <td class="detail-label">Ticket Reference</td>
          <td class="detail-value" style="font-family: monospace; font-size: 13px;">${tx.reference}</td>
        </tr>
        <tr class="detail-row">
          <td class="detail-label">Amount Paid</td>
          <td class="detail-value">₦${tx.gross_amount.toLocaleString()}</td>
        </tr>
      </table>
 
      <div class="qr-box">
        <div style="font-size: 13px; font-weight: 700; color: #0B0D0A; margin-bottom: 12px;">Your Gate Pass Entry Code</div>
        <img src="cid:ticket-qr" width="160" height="160" alt="Ticket QR Code" />
        <div style="font-size: 11px; color: #7A7462; margin-top: 10px;">We've also attached a printable PDF version of your ticket to this email.</div>
      </div>
    </div>
    <div class="footer">
      Please present the attached PDF or this QR code on arrival. Powered by StableFlow.
    </div>
  </div>
</body>
</html>
`;
 
  try {
    const attachments = [
      {
        filename: 'ticket-qr.png',
        content: qrBase64,
        content_id: 'ticket-qr',
        id: 'ticket-qr',
        content_type: 'image/png',
        disposition: 'inline'
      }
    ];
 
    if (pdfBuffer) {
      attachments.push({
        filename: `Ticket-${tx.reference}.pdf`,
        content: pdfBuffer.toString('base64'),
        content_type: 'application/pdf',
        disposition: 'attachment'
      });
    }

    const result = await client.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `Your Ticket Details — ${event}`,
      html,
      attachments
    });
    console.log('[MAILER] Ticket email with PDF sent to', email, '| ID:', result?.id);
    return result;
  } catch (err) {
    console.error('[MAILER] Failed to send ticket email:', err.message);
    throw err;
  }
}

module.exports = { sendTicketEmail, generateTicketQR, generateTicketPDF };
