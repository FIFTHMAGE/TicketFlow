require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const db = require('./db');
const ledger = require('./ledger');
const settlement = require('./settlement');
const reconciliation = require('./reconciliation');
const { requireAdmin, JWT_SECRET } = require('./middleware/auth');
const { handleBasqetWebhook } = require('./webhooks/basqet');
const { handleNombaWebhook } = require('./webhooks/nomba');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Gated static admin dashboard before files are served
app.use('/admin', requireAdmin, express.static(path.join(__dirname, '../frontend/admin')));

// Serve public storefront static folder
app.use(express.static(path.join(__dirname, '../frontend/public')));
// Also serve login.html in public
app.use(express.static(path.join(__dirname, '../frontend/public')));

// AUTH API: Admin Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const admin = await db.get('SELECT * FROM admins WHERE username = ?', [username]);
    if (!admin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, admin.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT token using real database role (ADMIN or FINANCE)
    const token = jwt.sign({ username: admin.username, role: admin.role }, JWT_SECRET, { expiresIn: '8h' });

    res.json({ token, username: admin.username, role: admin.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get storefront events
app.get('/api/events', async (req, res) => {
  try {
    const items = await db.all(`
      SELECT m.*, p.name as platform_name, v.name as vendor_name 
      FROM marketplace_items m
      JOIN platforms p ON m.platform_id = p.id
      JOIN vendors v ON m.vendor_id = v.id
    `);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get public ledger summary metrics for homepage mockup
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

// API: Initialize purchase (Customer storefront)
app.post('/api/purchase', async (req, res) => {
  const { eventId, customerName, customerEmail } = req.body;

  try {
    const item = await db.get('SELECT * FROM marketplace_items WHERE id = ?', [eventId]);
    if (!item) return res.status(404).json({ error: 'Event ticket not found' });

    const platform = await db.get('SELECT * FROM platforms WHERE id = ?', [item.platform_id]);
    if (!platform) return res.status(404).json({ error: 'Platform not found' });

    const reference = `SF_REF_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const grossAmount = item.price;
    const platformFee = (grossAmount * platform.platform_split_pct) / 100.0;
    const vendorAmount = grossAmount - platformFee;

    // 1. Create Transaction record
    await db.run(
      `INSERT INTO transactions (id, reference, platform_id, vendor_id, marketplace_item_id, gross_amount, platform_fee, vendor_amount, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [reference, reference, item.platform_id, item.vendor_id, item.id, grossAmount, platformFee, vendorAmount, 'INITIATED']
    );

    res.json({
      message: 'Transaction initialized',
      transaction: {
        id: reference,
        reference: reference,
        status: 'INITIATED',
        amount: grossAmount,
        currency: 'NGN',
        customer: { name: customerName, email: customerEmail }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Simulate payment initiation on Basqet (locks crypto rate & assigns payment info)
app.post('/api/basqet/pay-initiate', async (req, res) => {
  const { transactionId, currencyId } = req.body;

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [transactionId]);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    // Mock exchange rates
    let exchangeRate = 1.0;
    let currencyTicker = 'USDC';

    if (currencyId === 3) { currencyTicker = 'USDT'; exchangeRate = 1600; }
    else if (currencyId === 4) { currencyTicker = 'BTC'; exchangeRate = 100000000; }
    else if (currencyId === 6) { currencyTicker = 'ETH'; exchangeRate = 5000000; }

    const cryptoAmount = tx.gross_amount / exchangeRate;
    const mockAddress = `0x${cryptoTicker.toLowerCase()}__${Math.random().toString(36).substring(2, 15)}`;

    // Update Transaction state in DB
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

// API: Simulate payment initiation on Nomba (creates mock bank transfer account details)
app.post('/api/nomba/pay-initiate', async (req, res) => {
  const { transactionId } = req.body;

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [transactionId]);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    const mockBankAccount = `998877${Math.floor(1000 + Math.random() * 9000)}`;

    // Update Transaction state in DB
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
        bank_account: mockBankAccount
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Simulated Payment Confirmation (Simulating what the Basqet webhook does internally)
app.post('/api/basqet/confirm-simulation', async (req, res) => {
  const { transactionId } = req.body;

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [transactionId]);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    if (tx.status === 'PAYMENT_CONFIRMED' || tx.status === 'ALLOCATED_TO_LEDGER') {
      return res.json({ message: 'Transaction already paid' });
    }

    // Set confirmed amount
    await db.run(
      'UPDATE transactions SET status = ?, confirmed_amount = ? WHERE reference = ?',
      ['PAYMENT_CONFIRMED', tx.gross_amount, transactionId]
    );

    // Record purchase inside the ledger
    await ledger.recordPurchase(tx.reference, tx.gross_amount, tx.platform_id, tx.vendor_id);

    res.json({
      status: 'success',
      message: 'Payment confirmed & allocated to ledger successfully'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Simulated Nomba checkout payment confirmation
app.post('/api/nomba/confirm-simulation', async (req, res) => {
  const { transactionId } = req.body;

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [transactionId]);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    if (tx.status === 'PAYMENT_CONFIRMED' || tx.status === 'ALLOCATED_TO_LEDGER') {
      return res.json({ message: 'Transaction already paid' });
    }

    // Set confirmed amount
    await db.run(
      'UPDATE transactions SET status = ?, confirmed_amount = ? WHERE reference = ?',
      ['PAYMENT_CONFIRMED', tx.gross_amount, transactionId]
    );

    // Record purchase inside the ledger
    await ledger.recordPurchase(tx.reference, tx.gross_amount, tx.platform_id, tx.vendor_id);

    res.json({
      status: 'success',
      message: 'Nomba payment confirmed & allocated to ledger successfully'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real webhooks
app.post('/api/webhooks/basqet', handleBasqetWebhook);
app.post('/api/webhooks/nomba', handleNombaWebhook);

// GATED ADMIN APIS: requireAdmin JWT validation
app.get('/api/admin/ledger', requireAdmin, async (req, res) => {
  try {
    const accounts = await db.all('SELECT * FROM ledger_accounts');
    const entries = await db.all('SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT 50');
    const transactions = await db.all('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50');
    const reconciliationFlags = await db.all('SELECT * FROM reconciliation_flags ORDER BY created_at DESC');
    
    res.json({ accounts, entries, transactions, reconciliationFlags });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/batches/trigger', requireAdmin, async (req, res) => {
  try {
    const result = await settlement.runSettlementBatch(req.admin.username);
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

// ADMIN API: Approve a pending high-value payout
app.post('/api/admin/payouts/approve', requireAdmin, async (req, res) => {
  const { payoutId } = req.body;
  const ipAddress = req.ip || req.connection.remoteAddress || '127.0.0.1';

  try {
    const result = await settlement.approvePayout(payoutId, req.admin.username, req.admin.role, ipAddress);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ADMIN API: Execute a refund request
app.post('/api/admin/refund', requireAdmin, async (req, res) => {
  const { transactionId } = req.body;
  const ipAddress = req.ip || req.connection.remoteAddress || '127.0.0.1';

  try {
    // Log audit trail for refund initiation
    await db.run(
      'INSERT INTO audit_logs (username, action, details, ip_address) VALUES (?, ?, ?, ?)',
      [req.admin.username, 'INITIATE_REFUND', `Refund requested for transaction ${transactionId}`, ipAddress]
    );

    const result = await ledger.processRefund(transactionId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Start Database & Listen
db.initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`StableFlow marketplace backend running at http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to init DB:', err);
});
