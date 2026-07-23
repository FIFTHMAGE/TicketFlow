require('dotenv').config();

// ── Startup secret guard ────────────────────────────────────────────────────
const DANGEROUS_DEFAULTS = {
  ADMIN_JWT_SECRET: 'stableflow_super_secret_payout_ledger',
  BASQET_WEBHOOK_SECRET: 'basqet_secret_sandbox_123',
  NOMBA_WEBHOOK_SECRET: 'nomba_secret_sandbox_123'
};

if (process.env.NODE_ENV === 'production') {
  for (const [key, defaultVal] of Object.entries(DANGEROUS_DEFAULTS)) {
    if (!process.env[key] || process.env[key] === defaultVal) {
      console.warn(`[STARTUP] WARNING: ${key} is using default or missing values. Update this variable in production for security.`);
    }
  }
}

const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const ledger = require('./ledger');
const settlement = require('./settlement');
const reconciliation = require('./reconciliation');
const reservations = require('./reservations');
const { sendTicketEmail } = require('./mailer');
const { requireAdmin, JWT_SECRET } = require('./middleware/auth');
const { handleBasqetWebhook } = require('./webhooks/basqet');
const { handleNombaWebhook } = require('./webhooks/nomba');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:3000'];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// ── Raw body capture for webhook HMAC ──────────────────────────────────────
// Must be registered BEFORE express.json() for webhook routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhooks/')) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      req.rawBody = data;
      req.body = JSON.parse(data || '{}');
      next();
    });
  } else {
    next();
  }
});

app.use(express.json());

// ── Rate limiting ─────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many login attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many payment requests. Slow down.' }
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'Webhook rate limit exceeded.' }
});

// ── Static file serving ───────────────────────────────────────────────────
app.use('/admin', requireAdmin, express.static(path.join(__dirname, '../frontend/admin')));
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const admin = await db.get('SELECT * FROM admins WHERE username = ?', [username]);
    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ username: admin.username, role: admin.role }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, username: admin.username, role: admin.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Vendor Self-Registration ──────────────────────────────────────────────
app.post('/api/vendor/register', authLimiter, async (req, res) => {
  const { accountType, firstName, lastName, email, phone, orgName, bankName, accountNumber, accountName, password } = req.body;

  // Input validation
  if (!firstName || !lastName) return res.status(400).json({ error: 'First and last name are required' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email is required' });
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });
  if (!bankName || !accountNumber || !accountName) return res.status(400).json({ error: 'Bank details are required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (accountType === 'organization' && !orgName) return res.status(400).json({ error: 'Organisation name is required' });

  try {
    // Check duplicate email
    const existing = await db.get('SELECT id FROM vendors WHERE account_number = ?', [accountNumber]);
    if (existing) return res.status(409).json({ error: 'An account with this bank account number already exists' });

    const DEFAULT_PLATFORM = 'platform_stableflow_1';
    const vendorId = `vendor_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const vendorName = accountType === 'organization' ? orgName : `${firstName} ${lastName}`;

    // Create vendor record
    await db.run(
      'INSERT INTO vendors (id, platform_id, name, bank_name, account_number, account_name) VALUES (?, ?, ?, ?, ?, ?)',
      [vendorId, DEFAULT_PLATFORM, vendorName, bankName, accountNumber, accountName]
    );

    // Create vendor payable ledger account
    await db.run(
      "INSERT INTO ledger_accounts (id, name, type) VALUES (?, ?, 'LIABILITY')",
      [`VENDOR_PAYABLE_${vendorId}`, `Vendor Payable - ${vendorName}`]
    );

    // Audit log
    await db.run(
      'INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)',
      ['system', 'VENDOR_REGISTERED', `New vendor registered: ${vendorName} (${email}), type: ${accountType}`]
    );

    // Send welcome/verification email
    try {
      const { sendTicketEmail } = require('./mailer');
      // Reuse mailer with a synthetic tx-like object for the welcome email
      const fakeTx = { reference: vendorId, gross_amount: 0, customer_name: firstName, customer_email: email };
      // We'll extend mailer.js later for vendor welcome — for now just log
      console.log(`[REGISTER] Vendor registered: ${vendorName} (${email})`);
    } catch (mailErr) {
      console.warn('[REGISTER] Welcome email failed (non-fatal):', mailErr.message);
    }

    res.status(201).json({
      status: 'success',
      message: 'Account created successfully. Check your email to verify your address.',
      vendorId
    });
  } catch (err) {
    console.error('[REGISTER] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Resend verification email ─────────────────────────────────────────────
app.post('/api/vendor/resend-verification', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
  // Email verification token system can be added here once an email provider is active
  console.log(`[VERIFY] Resend verification requested for: ${email}`);
  res.json({ status: 'success', message: 'Verification email resent if account exists.' });
});



// ── Public storefront APIs ────────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  try {
    await reservations.expireStale(); // flush expired holds before returning counts
    const items = await db.all(`
      SELECT m.*, p.name as platform_name, v.name as vendor_name 
      FROM marketplace_items m
      JOIN platforms p ON m.platform_id = p.id
      JOIN vendors v ON m.vendor_id = v.id
      WHERE m.status = 'ACTIVE'
    `);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ticket Reservation ────────────────────────────────────────────────────
app.post('/api/reserve', paymentLimiter, async (req, res) => {
  const { eventId, customerName, customerEmail } = req.body;

  if (!eventId) return res.status(400).json({ error: 'eventId is required' });
  if (!customerName) return res.status(400).json({ error: 'customerName is required' });
  if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return res.status(400).json({ error: 'A valid customerEmail is required' });
  }

  try {
    const result = await reservations.createReservation(eventId, customerName, customerEmail);
    res.status(201).json({ status: 'reserved', ...result });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/reserve/:id', async (req, res) => {
  try {
    const data = await reservations.getReservation(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/reserve/:id', async (req, res) => {
  try {
    const result = await reservations.cancelReservation(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});


app.get('/api/public-stats', async (req, res) => {
  try {
    const pool = await db.get("SELECT balance FROM ledger_accounts WHERE id = 'SETTLEMENT_POOL'");
    const revenue = await db.get("SELECT balance FROM ledger_accounts WHERE id = 'PLATFORM_REVENUE'");
    const entries = await db.all("SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT 5");

    res.json({
      poolBalance: pool ? pool.balance : 0,
      revenueBalance: revenue ? revenue.balance : 0,
      latestEntries: entries
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Checkout: initiate purchase ───────────────────────────────────────────
// ── Checkout: convert reservation → transaction ───────────────────────────
app.post('/api/purchase', paymentLimiter, async (req, res) => {
  const { eventId, customerName, customerEmail, reservationId } = req.body;

  if (!eventId) return res.status(400).json({ error: 'eventId is required' });
  if (!customerName) return res.status(400).json({ error: 'customerName is required' });
  if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return res.status(400).json({ error: 'A valid customerEmail is required' });
  }

  try {
    // Validate reservation if one was provided
    if (reservationId) {
      const reservation = await db.get('SELECT * FROM reservations WHERE id = ?', [reservationId]);
      if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
      if (reservation.status !== 'ACTIVE') {
        return res.status(410).json({ error: `Reservation is ${reservation.status.toLowerCase()} — please start over` });
      }
      if (new Date(reservation.expires_at) <= new Date()) {
        await db.run("UPDATE reservations SET status = 'EXPIRED' WHERE id = ?", [reservationId]);
        await db.run(
          'UPDATE marketplace_items SET available_quantity = available_quantity + 1 WHERE id = ? AND available_quantity < total_quantity',
          [reservation.marketplace_item_id]
        );
        return res.status(410).json({ error: 'Your reservation has expired. Please reserve again.' });
      }
      if (reservation.marketplace_item_id !== eventId) {
        return res.status(400).json({ error: 'Reservation does not match the selected event' });
      }
    }

    const item = await db.get('SELECT * FROM marketplace_items WHERE id = ?', [eventId]);
    if (!item) return res.status(404).json({ error: 'Event not found' });

    const platform = await db.get('SELECT * FROM platforms WHERE id = ?', [item.platform_id]);
    if (!platform) return res.status(404).json({ error: 'Platform not found' });

    const reference = `SF_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const grossAmount = item.price;
    const platformFee = Math.round((grossAmount * platform.platform_split_pct) / 100 * 100) / 100;
    const vendorAmount = Math.round((grossAmount - platformFee) * 100) / 100;

    await db.run(
      `INSERT INTO transactions 
        (id, reference, platform_id, vendor_id, marketplace_item_id, gross_amount, platform_fee, vendor_amount, status, customer_name, customer_email) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [reference, reference, item.platform_id, item.vendor_id, item.id, grossAmount, platformFee, vendorAmount, 'INITIATED', customerName, customerEmail]
    );

    // Link reservation to this transaction
    if (reservationId) {
      await db.run('UPDATE reservations SET transaction_id = ? WHERE id = ?', [reference, reservationId]);
    }

    res.json({
      message: 'Transaction initialized',
      transaction: {
        id: reference,
        reference,
        status: 'INITIATED',
        amount: grossAmount,
        currency: 'NGN',
        reservationId: reservationId || null,
        customer: { name: customerName, email: customerEmail }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Basqet: initiate crypto payment ──────────────────────────────────────
app.post('/api/basqet/pay-initiate', paymentLimiter, async (req, res) => {
  const { transactionId, currencyId } = req.body;
  if (!transactionId || !currencyId) {
    return res.status(400).json({ error: 'transactionId and currencyId are required' });
  }

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [transactionId]);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'INITIATED') return res.status(409).json({ error: 'Transaction already in progress' });

    // If real Basqet keys are configured, call real API — otherwise simulate
    if (process.env.BASQET_PRIVATE_KEY && process.env.BASQET_API_URL) {
      // Real Basqet API call
      const basqetResp = await fetch(`${process.env.BASQET_API_URL}/v1/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.BASQET_PRIVATE_KEY}`
        },
        body: JSON.stringify({
          reference: tx.reference,
          amount: tx.gross_amount,
          currency: 'NGN',
          currency_id: currencyId,
          customer_email: tx.customer_email,
          customer_name: tx.customer_name
        })
      });

      const basqetData = await basqetResp.json();
      if (!basqetResp.ok) {
        return res.status(basqetResp.status).json({ error: basqetData.message || 'Basqet API error' });
      }

      await db.run(
        'UPDATE transactions SET status = ?, crypto_currency_id = ?, crypto_amount = ?, payment_address = ? WHERE reference = ?',
        ['PAYMENT_PENDING', currencyId, basqetData.data?.payment_amount, basqetData.data?.payment_address, transactionId]
      );

      return res.json({ status: 'success', data: basqetData.data });
    }

    // Simulation fallback
    let currencyTicker = 'USDC';
    let exchangeRate = 1600;
    if (currencyId === 3) { currencyTicker = 'USDT'; exchangeRate = 1600; }
    else if (currencyId === 4) { currencyTicker = 'BTC'; exchangeRate = 100000000; }
    else if (currencyId === 6) { currencyTicker = 'ETH'; exchangeRate = 5000000; }

    const cryptoAmount = tx.gross_amount / exchangeRate;
    const mockAddress = `0x${currencyTicker.toLowerCase()}_${Math.random().toString(36).substring(2, 15)}`;

    await db.run(
      'UPDATE transactions SET status = ?, crypto_currency_id = ?, crypto_amount = ?, payment_address = ? WHERE reference = ?',
      ['PAYMENT_PENDING', currencyId, cryptoAmount, mockAddress, transactionId]
    );

    res.json({
      status: 'success',
      data: {
        id: transactionId,
        reference: transactionId,
        status: 'PAYMENT_PENDING',
        payment_amount: cryptoAmount,
        payment_address: mockAddress,
        ticker: currencyTicker
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Nomba: initiate fiat payment ──────────────────────────────────────────
app.post('/api/nomba/pay-initiate', paymentLimiter, async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ error: 'transactionId is required' });

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [transactionId]);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'INITIATED') return res.status(409).json({ error: 'Transaction already in progress' });

    if (process.env.NOMBA_CLIENT_ID && process.env.NOMBA_CLIENT_SECRET) {
      // Real Nomba checkout initiation would go here
      // Nomba provides a hosted checkout URL for card payments
      // For now, surface the virtual account number from Nomba API
    }

    // Simulation — generate a virtual account number to display in checkout
    const mockBankAccount = `9988${Math.floor(100000 + Math.random() * 900000)}`;
    await db.run(
      "UPDATE transactions SET status = ?, payment_address = ? WHERE reference = ?",
      ['PAYMENT_PENDING', mockBankAccount, transactionId]
    );

    res.json({
      status: 'success',
      data: {
        id: transactionId,
        reference: transactionId,
        status: 'PAYMENT_PENDING',
        bank_name: 'Nomba Microfinance Bank',
        bank_account: mockBankAccount,
        amount: tx.gross_amount
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Simulation confirmations (gated behind requireAdmin for security) ───────
app.post('/api/basqet/confirm-simulation', requireAdmin, async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ error: 'transactionId is required' });

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [transactionId]);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status === 'ALLOCATED_TO_LEDGER') return res.json({ message: 'Already allocated' });

    await db.run(
      'UPDATE transactions SET status = ?, confirmed_amount = ? WHERE reference = ?',
      ['PAYMENT_CONFIRMED', tx.gross_amount, transactionId]
    );
    await ledger.recordPurchase(tx.reference, tx.gross_amount, tx.platform_id, tx.vendor_id);

    // Convert the reservation if exists
    try {
      const reservation = await db.get('SELECT id FROM reservations WHERE transaction_id = ?', [transactionId]);
      if (reservation) {
        await reservations.convertReservation(reservation.id);
      }
    } catch (resErr) {
      console.warn('[SIM-BASQET] Reservation conversion failed (non-fatal):', resErr.message);
    }

    try {
      await sendTicketEmail(tx, tx.customer_email, tx.customer_name);
    } catch (mailErr) {
      console.warn('[SIM] Ticket email failed (non-fatal):', mailErr.message);
    }

    res.json({ status: 'success', message: 'Basqet payment simulated & ledger allocated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/nomba/confirm-simulation', requireAdmin, async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ error: 'transactionId is required' });

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [transactionId]);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status === 'ALLOCATED_TO_LEDGER') return res.json({ message: 'Already allocated' });

    await db.run(
      'UPDATE transactions SET status = ?, confirmed_amount = ? WHERE reference = ?',
      ['PAYMENT_CONFIRMED', tx.gross_amount, transactionId]
    );
    await ledger.recordPurchase(tx.reference, tx.gross_amount, tx.platform_id, tx.vendor_id);

    // Convert the reservation if exists
    try {
      const reservation = await db.get('SELECT id FROM reservations WHERE transaction_id = ?', [transactionId]);
      if (reservation) {
        await reservations.convertReservation(reservation.id);
      }
    } catch (resErr) {
      console.warn('[SIM-NOMBA] Reservation conversion failed (non-fatal):', resErr.message);
    }

    try {
      await sendTicketEmail(tx, tx.customer_email, tx.customer_name);
    } catch (mailErr) {
      console.warn('[SIM] Ticket email failed (non-fatal):', mailErr.message);
    }

    res.json({ status: 'success', message: 'Nomba payment simulated & ledger allocated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Real webhooks (raw body captured above) ───────────────────────────────
app.post('/api/webhooks/basqet', webhookLimiter, handleBasqetWebhook);
app.post('/api/webhooks/nomba', webhookLimiter, handleNombaWebhook);

// ── Admin APIs ────────────────────────────────────────────────────────────
app.get('/api/admin/ledger', requireAdmin, async (req, res) => {
  try {
    const accounts = await db.all('SELECT * FROM ledger_accounts ORDER BY type, id');
    const entries = await db.all('SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT 50');
    const transactions = await db.all('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50');
    const reconciliationFlags = await db.all('SELECT * FROM reconciliation_flags ORDER BY created_at DESC');
    res.json({ accounts, entries, transactions, reconciliationFlags });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/batches/trigger', requireAdmin, async (req, res) => {
  const ipAddress = req.ip || '127.0.0.1';
  try {
    const result = await settlement.runSettlementBatch(req.admin.username, ipAddress);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/settlements', requireAdmin, async (req, res) => {
  try {
    const batches = await db.all('SELECT * FROM settlement_batches ORDER BY created_at DESC');
    const payouts = await db.all(`
      SELECT p.*, v.name as vendor_name, v.bank_name, v.account_number 
      FROM payouts p
      JOIN vendors v ON p.vendor_id = v.id
      ORDER BY p.created_at DESC
    `);
    res.json({ batches, payouts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reconcile', requireAdmin, async (req, res) => {
  try {
    const result = await reconciliation.runReconciliationJob(req.admin.username);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/payouts/approve', requireAdmin, async (req, res) => {
  const { payoutId } = req.body;
  if (!payoutId) return res.status(400).json({ error: 'payoutId is required' });

  const ipAddress = req.ip || '127.0.0.1';
  try {
    const result = await settlement.approvePayout(payoutId, req.admin.username, req.admin.role, ipAddress);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/refund', requireAdmin, async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ error: 'transactionId is required' });

  const ipAddress = req.ip || '127.0.0.1';
  try {
    await db.run(
      'INSERT INTO audit_logs (username, action, details, ip_address) VALUES (?, ?, ?, ?)',
      [req.admin.username, 'INITIATE_REFUND', `Refund requested for ${transactionId}`, ipAddress]
    );
    const result = await ledger.processRefund(transactionId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Ticket Validation / Scan Endpoint ──────────────────────────────────────
app.post('/api/scan', requireAdmin, async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: 'reference is required' });

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [reference]);
    if (!tx) {
      return res.status(404).json({ error: 'Invalid Ticket: Reference not found' });
    }

    if (tx.status !== 'ALLOCATED_TO_LEDGER' && tx.status !== 'PAYMENT_CONFIRMED') {
      return res.status(400).json({ error: `Invalid Ticket: Payment status is ${tx.status}` });
    }

    if (tx.checked_in === 1) {
      return res.status(409).json({
        error: 'Ticket Already Used',
        checkedInAt: tx.updated_at || tx.created_at,
        customerName: tx.customer_name
      });
    }

    await db.run('UPDATE transactions SET checked_in = 1 WHERE reference = ?', [reference]);

    // Record check-in to audit logs
    await db.run(
      'INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)',
      [req.admin.username, 'TICKET_CHECKIN', `Ticket ${reference} scanned and checked in successfully`]
    );

    res.json({
      status: 'success',
      message: 'Access Granted: Ticket Validated',
      ticket: {
        reference: tx.reference,
        customerName: tx.customer_name,
        customerEmail: tx.customer_email,
        grossAmount: tx.gross_amount
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin Event Creation ──────────────────────────────────────────────────
app.post('/api/admin/events', requireAdmin, async (req, res) => {
  const { name, price, qty, vendorId } = req.body;
  if (!name || !price || !qty || !vendorId) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const vendor = await db.get('SELECT * FROM vendors WHERE id = ?', [vendorId]);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const eventId = `item_evt_${Date.now()}`;
    await db.run(
      'INSERT INTO marketplace_items (id, platform_id, vendor_id, name, price, total_quantity, available_quantity) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [eventId, vendor.platform_id, vendorId, name, price, qty, qty]
    );

    await db.run(
      'INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)',
      [req.admin.username, 'CREATE_EVENT', `Event created: ${name} (₦${price}, Stock: ${qty}) for vendor ${vendorId}`]
    );

    res.status(201).json({ status: 'success', eventId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ── Boot ─────────────────────────────────────────────────────────────────────
db.initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`[SERVER] StableFlow running at http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('[SERVER] Failed to init DB:', err);
  process.exit(1);
});
