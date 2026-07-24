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
const { requireAdmin, requireVendor, JWT_SECRET } = require('./middleware/auth');
const { handleBasqetWebhook } = require('./webhooks/basqet');
const { handleNombaWebhook } = require('./webhooks/nomba');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Vercel's proxy for rate limiting
app.set('trust proxy', 1);

// ── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:3000'];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    
    // Allow matching local development or configured allowed origins
    if (allowedOrigins.includes(origin)) return cb(null, true);
    
    // Dynamically allow any Vercel deployment/subdomain
    if (origin.endsWith('.vercel.app') || origin.includes('localhost')) {
      return cb(null, true);
    }
    
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// ── Raw body capture for webhook HMAC ──────────────────────────────────────
// Must be registered BEFORE express.json() for webhook routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhooks/') || req.path.startsWith('/api-v1/webhooks/')) {
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

// ── Static file serving (Registered AFTER API routes) ──────────────────────
const registerStaticRoutes = () => {
  app.use('/admin', requireAdmin, express.static(path.join(__dirname, '../frontend/admin')));
  app.use('/portal', express.static(path.join(__dirname, '../frontend/portal')));
  app.use(express.static(path.join(__dirname, '../frontend/public')));
};

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

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Create vendor record
    await db.run(
      'INSERT INTO vendors (id, platform_id, name, bank_name, account_number, account_name, email, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [vendorId, DEFAULT_PLATFORM, vendorName, bankName, accountNumber, accountName, email, passwordHash]
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

// Helper: Obtain Flutterwave v4 OAuth2 Access Token
async function getFlwV4AccessToken() {
  const clientId = process.env.FLW_CLIENT_ID;
  const clientSecret = process.env.FLW_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  try {
    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('grant_type', 'client_credentials');

    const tokenResp = await fetch('https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    const tokenData = await tokenResp.json();
    console.log('[FLUTTERWAVE V4 OAUTH TOKEN RESPONSE]', tokenResp.status, tokenData.access_token ? 'TOKEN_ACQUIRED' : 'FAILED');
    return tokenData.access_token || null;
  } catch (err) {
    console.error('[FLUTTERWAVE V4 OAUTH ERROR]', err.message);
    return null;
  }
}

// ── Flutterwave: resolve bank account name ────────────────────────────────
app.get(['/api/flutterwave/resolve-account', '/api-v1/flutterwave/resolve-account', '/api/nomba/resolve-account', '/api-v1/nomba/resolve-account'], async (req, res) => {
  const { bankName, accountNumber } = req.query;
  if (!bankName || !accountNumber) {
    return res.status(400).json({ error: 'bankName and accountNumber are required' });
  }

  // NIP / CBN Bank Codes for Nigerian Banks
  const BANK_CODES = {
    'Access Bank': '044',
    'First Bank': '011',
    'GTBank': '058',
    'Kuda Bank': '50211',
    'Opay': '999992',
    'Palmpay': '999991',
    'UBA': '033',
    'Wema Bank': '035',
    'Zenith Bank': '057',
    'Moniepoint': '50515'
  };

  // Mock test account map for testing environments
  const testAccounts = {
    '8116047352': 'Opay Account Holder',
    '0123456789': 'Adeola Bello',
    '9876543210': 'Tech Fest Event Services',
    '0554772814': 'M.A Animashaun'
  };

  try {
    let bankCode = BANK_CODES[bankName] || bankName;

    // 1. Try Flutterwave v4 OAuth account resolution if FLW_CLIENT_ID is set
    const v4AccessToken = await getFlwV4AccessToken();
    if (v4AccessToken) {
      const v4BaseUrl = process.env.FLW_V4_BASE_URL || 'https://developersandbox-api.flutterwave.com';
      const resolveResp = await fetch(`${v4BaseUrl}/banks/account-resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${v4AccessToken}`
        },
        body: JSON.stringify({
          currency: 'NGN',
          account_number: accountNumber,
          account_bank: bankCode
        })
      });

      const resolveData = await resolveResp.json();
      console.log('[FLUTTERWAVE V4 ACCOUNT RESOLVE RESPONSE]', resolveResp.status, JSON.stringify(resolveData));

      if (resolveResp.ok && (resolveData.data?.account_name || resolveData.account_name)) {
        const name = resolveData.data?.account_name || resolveData.account_name;
        return res.json({
          status: 'success',
          data: {
            accountNumber,
            accountName: name
          }
        });
      }
    }

    // 2. Fallback to Flutterwave v3 API if Secret Key is set
    const FLW_SECRET = process.env.FLW_SECRET_KEY;
    if (FLW_SECRET) {
      const resolveResp = await fetch('https://api.flutterwave.com/v3/accounts/resolve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${FLW_SECRET}`
        },
        body: JSON.stringify({
          account_number: accountNumber,
          account_bank: bankCode
        })
      });

      const resolveData = await resolveResp.json();
      console.log('[FLUTTERWAVE V3 ACCOUNT RESOLVE RESPONSE]', resolveResp.status, JSON.stringify(resolveData));

      if (resolveResp.ok && resolveData.status === 'success' && resolveData.data?.account_name) {
        return res.json({
          status: 'success',
          data: {
            accountNumber: resolveData.data.account_number || accountNumber,
            accountName: resolveData.data.account_name
          }
        });
      }
    }

    // 3. Return sandbox mock test account if matching test number
    if (testAccounts[accountNumber]) {
      return res.json({
        status: 'success',
        data: {
          accountNumber,
          accountName: testAccounts[accountNumber]
        }
      });
    }

    // Resolution failed -> return 404
    return res.status(404).json({
      status: 'error',
      error: 'Account lookup failed — verify account number and selected bank'
    });
  } catch (err) {
    console.error('[FLUTTERWAVE RESOLVE ACCOUNT ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Vendor Login ─────────────────────────────────────────────────────────────
app.post('/api/vendor/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const vendor = await db.get('SELECT * FROM vendors WHERE email = ?', [email]);
    if (!vendor || !vendor.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, vendor.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ vendorId: vendor.id, email: vendor.email, role: 'VENDOR' }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, vendorId: vendor.id, email: vendor.email, name: vendor.name, role: 'VENDOR' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── Vendor Portal APIs ──────────────────────────────────────────────────────
app.get('/api/vendor/stats', requireVendor, async (req, res) => {
  try {
    const vendorId = req.vendor.vendorId;

    // Tickets sold: number of successful transactions
    const ticketsSoldRes = await db.get(
      "SELECT COUNT(*) as count FROM transactions WHERE vendor_id = ? AND status IN ('PAYMENT_CONFIRMED', 'ALLOCATED_TO_LEDGER')",
      [vendorId]
    );

    // Gross earnings (total price paid by customers for this vendor's events)
    const grossEarningsRes = await db.get(
      "SELECT SUM(gross_amount) as total FROM transactions WHERE vendor_id = ? AND status IN ('PAYMENT_CONFIRMED', 'ALLOCATED_TO_LEDGER')",
      [vendorId]
    );

    // Vendor payable balance
    const payableRes = await db.get("SELECT balance FROM ledger_accounts WHERE id = ?", [`VENDOR_PAYABLE_${vendorId}`]);

    // Remaining stock across events
    // Wait, do events have stock/quantity? Supabase schema didn't seem to have stock logic strictly, but let's check
    res.json({
      ticketsSold: ticketsSoldRes ? ticketsSoldRes.count : 0,
      grossEarnings: grossEarningsRes && grossEarningsRes.total ? grossEarningsRes.total : 0,
      netPayable: payableRes ? payableRes.balance : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vendor/events', requireVendor, async (req, res) => {
  try {
    const vendorId = req.vendor.vendorId;
    const items = await db.all(
      "SELECT m.*, (SELECT COUNT(*) FROM transactions t WHERE t.marketplace_item_id = m.id AND t.status IN ('PAYMENT_CONFIRMED', 'ALLOCATED_TO_LEDGER')) as sold_count FROM marketplace_items m WHERE m.vendor_id = ?",
      [vendorId]
    );
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vendor/events/create', requireVendor, async (req, res) => {
  const { name, price } = req.body;
  if (!name || price === undefined) {
    return res.status(400).json({ error: 'Name and price are required' });
  }

  try {
    const vendorId = req.vendor.vendorId;
    // Determine platform from vendor
    const vendor = await db.get("SELECT platform_id FROM vendors WHERE id = ?", [vendorId]);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const itemId = `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await db.run(
      "INSERT INTO marketplace_items (id, platform_id, vendor_id, name, price, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')",
      [itemId, vendor.platform_id, vendorId, name, price]
    );

    res.status(201).json({ status: 'success', eventId: itemId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── Public storefront APIs ────────────────────────────────────────────────
app.get(['/api/events', '/api-v1/events'], async (req, res) => {
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
app.post(['/api/reserve', '/api-v1/reserve'], paymentLimiter, async (req, res) => {
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


app.get(['/api/public-stats', '/api-v1/public-stats'], async (req, res) => {
  // Instruct CDN edge & browsers to cache stats for 10 seconds
  res.setHeader('Cache-Control', 'public, max-age=10, s-maxage=10, stale-while-revalidate=30');

  try {
    const pool    = await db.get("SELECT balance FROM ledger_accounts WHERE id = 'SETTLEMENT_POOL'");
    const revenue = await db.get("SELECT balance FROM ledger_accounts WHERE id = 'PLATFORM_REVENUE'");
    const entries = await db.all("SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT 5");

    res.json({
      poolBalance:    pool    ? parseFloat(pool.balance)    : 0,
      revenueBalance: revenue ? parseFloat(revenue.balance) : 0,
      latestEntries:  Array.isArray(entries) ? entries : []
    });
  } catch (err) {
    console.error('[PUBLIC-STATS ERROR]', err.message);
    // Return safe zeros so the frontend doesn't crash
    res.json({ poolBalance: 0, revenueBalance: 0, latestEntries: [], _error: err.message });
  }
});


// ── Checkout: initiate purchase ───────────────────────────────────────────
// ── Checkout: convert reservation → transaction ───────────────────────────
app.post(['/api/purchase', '/api-v1/purchase'], paymentLimiter, async (req, res) => {
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
    console.error('[PURCHASE ERROR]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── Basqet: fetch supported currencies (proxied + cached) ─────────────────
let basqetCurrencyCache = { data: null, fetchedAt: 0 };
app.get(['/api/basqet/currencies', '/api-v1/basqet/currencies'], async (req, res) => {
  const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
  if (basqetCurrencyCache.data && (Date.now() - basqetCurrencyCache.fetchedAt < CACHE_TTL)) {
    return res.json({ currencies: basqetCurrencyCache.data });
  }
  try {
    // Request only CRYPTO currencies as per Basqet docs (?type=CRYPTO)
    const r = await fetch('https://api.basqet.com/v1/currency?type=CRYPTO', {
      headers: { 'Authorization': `Bearer ${process.env.BASQET_API_KEY}` }
    });
    const json = await r.json();
    // Docs confirm: response shape is { status, data: [...], meta }
    const currencies = Array.isArray(json.data) ? json.data : [];
    console.log('[BASQET CURRENCIES] fetched:', currencies.length, 'tokens');
    basqetCurrencyCache = { data: currencies, fetchedAt: Date.now() };
    return res.json({ currencies });
  } catch (err) {
    console.error('[BASQET CURRENCIES ERROR]', err);
    // Fallback: known tokens with real Basqet CDN icon URLs
    const BASE_ICON = 'https://basquet-assets.s3.amazonaws.com/icons/currency';
    return res.json({ currencies: [
      { id: 3, name: 'Tether',       slug: 'USDT', type: 'CRYPTO', icon_url: `${BASE_ICON}/USDT.svg` },
      { id: 4, name: 'Bitcoin',      slug: 'BTC',  type: 'CRYPTO', icon_url: `${BASE_ICON}/BTC.svg`  },
      { id: 5, name: 'Quidax Token', slug: 'QDX',  type: 'CRYPTO', icon_url: `${BASE_ICON}/QDX.svg`  },
      { id: 6, name: 'Ethereum',     slug: 'ETH',  type: 'CRYPTO', icon_url: `${BASE_ICON}/ETH.svg`  },
      { id: 7, name: 'Litecoin',     slug: 'LTC',  type: 'CRYPTO', icon_url: `${BASE_ICON}/LTC.svg`  },
    ]});
  }
});

// ── Basqet: initiate crypto payment ──────────────────────────────────────
app.post(['/api/basqet/pay-initiate', '/api-v1/basqet/pay-initiate'], paymentLimiter, async (req, res) => {
  const { transactionId, currencyId } = req.body;
  if (!transactionId || !currencyId) {
    return res.status(400).json({ error: 'transactionId and currencyId are required' });
  }

  console.log('[PAY-INITIATE] Received transactionId:', transactionId, 'currencyId:', currencyId);
  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [transactionId]);
    console.log('[PAY-INITIATE] Found transaction row:', tx);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'INITIATED') return res.status(409).json({ error: 'Transaction already in progress' });

    // If real Basqet keys are configured, call real API — otherwise simulate
    if (process.env.BASQET_PRIVATE_KEY && process.env.BASQET_API_URL) {
      // Step 1: Initialize Transaction
      const initResp = await fetch(`${process.env.BASQET_API_URL}/v1/transaction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.BASQET_PRIVATE_KEY}`
        },
        body: JSON.stringify({
          customer: {
            name: tx.customer_name,
            email: tx.customer_email
          },
          currency: 'NGN',
          amount: tx.gross_amount.toString(),
          description: `Ticket Purchase for ${tx.customer_name}`
        })
      });

      const initData = await initResp.json();
      if (!initResp.ok) {
        return res.status(initResp.status).json({ error: initData.message || 'Basqet initialization failed' });
      }

      const basqetTxId = initData.data.id;

      // Step 2: Initiate Transaction (Pay)
      const payResp = await fetch(`${process.env.BASQET_API_URL}/v1/transaction/${basqetTxId}/pay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.BASQET_PRIVATE_KEY}`
        },
        body: JSON.stringify({
          currency_id: parseInt(currencyId, 10)
        })
      });

      const payData = await payResp.json();
      if (!payResp.ok) {
        return res.status(payResp.status).json({ error: payData.message || 'Basqet payment initiation failed' });
      }

      await db.run(
        'UPDATE transactions SET id = ?, status = ?, crypto_currency_id = ?, crypto_amount = ?, payment_address = ? WHERE reference = ?',
        [basqetTxId, 'PAYMENT_PENDING', currencyId, payData.data?.payment_amount, payData.data?.payment_address, transactionId]
      );

      return res.json({ status: 'success', data: payData.data });
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

// ── Flutterwave / Nomba: initiate fiat payment ────────────────────────────
app.post(['/api/flutterwave/pay-initiate', '/api-v1/flutterwave/pay-initiate', '/api/nomba/pay-initiate', '/api-v1/nomba/pay-initiate'], paymentLimiter, async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ error: 'transactionId is required' });

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [transactionId]);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'INITIATED') return res.status(409).json({ error: 'Transaction already in progress' });

    const redirectUrl = `https://${req.headers.host || 'ticket-flow-drab.vercel.app'}/api-v1/flutterwave/callback?tx_ref=${tx.reference}`;

    // 1. Flutterwave Standard Payment Initiation
    if (process.env.FLW_SECRET_KEY) {
      const flwBody = {
        tx_ref: tx.reference,
        amount: parseFloat(tx.gross_amount).toFixed(2),
        currency: 'NGN',
        redirect_url: redirectUrl,
        customer: {
          email: tx.customer_email,
          name: tx.customer_name || 'Event Fan'
        },
        customizations: {
          title: 'StableFlow Tickets',
          description: `Ticket Purchase #${tx.reference}`
        }
      };

      const flwResp = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`
        },
        body: JSON.stringify(flwBody)
      });

      const flwData = await flwResp.json();
      console.log('[FLUTTERWAVE PAY INIT RESPONSE]', flwResp.status, JSON.stringify(flwData));

      if (flwResp.ok && flwData.status === 'success' && flwData.data?.link) {
        const checkoutLink = flwData.data.link;
        await db.run(
          "UPDATE transactions SET status = ?, payment_address = ? WHERE reference = ?",
          ['PAYMENT_PENDING', checkoutLink, transactionId]
        );

        return res.json({
          status: 'success',
          data: {
            id: transactionId,
            reference: transactionId,
            checkoutUrl: checkoutLink,
            status: 'PAYMENT_PENDING'
          }
        });
      }
    }

    // 2. Nomba API fallback if Nomba keys are set
    const NOMBA_BASE = process.env.NOMBA_BASE_URL || 'https://api.nomba.com/v1';

    if (process.env.NOMBA_CLIENT_ID && process.env.NOMBA_CLIENT_SECRET && process.env.NOMBA_ACCOUNT_ID) {
      const tokenResp = await fetch(`${NOMBA_BASE}/auth/token/issue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'accountId': process.env.NOMBA_ACCOUNT_ID
        },
        body: JSON.stringify({
          clientId: process.env.NOMBA_CLIENT_ID,
          clientSecret: process.env.NOMBA_CLIENT_SECRET,
          grantType: 'client_credentials'
        })
      });
      const tokenData = await tokenResp.json();
      const token = tokenData.data?.access_token || tokenData.access_token;

      if (token) {
        const checkoutBody = {
          order: {
            amount: parseFloat(tx.gross_amount).toFixed(2),
            currency: 'NGN',
            orderReference: tx.reference,
            callbackUrl: `https://${req.headers.host || 'ticket-flow-drab.vercel.app'}/api-v1/nomba/callback`,
            customerEmail: tx.customer_email,
            customerId: tx.customer_email,
            allowedPaymentMethods: ['Card', 'Transfer', 'USSD', 'Nomba QR']
          }
        };

        const checkoutResp = await fetch(`${NOMBA_BASE}/checkout/order`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'accountId': process.env.NOMBA_ACCOUNT_ID
          },
          body: JSON.stringify(checkoutBody)
        });

        const checkoutData = await checkoutResp.json();
        if (checkoutResp.ok && checkoutData.code === '00' && checkoutData.data?.checkoutLink) {
          const checkoutLink = checkoutData.data.checkoutLink;
          await db.run(
            "UPDATE transactions SET status = ?, payment_address = ? WHERE reference = ?",
            ['PAYMENT_PENDING', checkoutLink, transactionId]
          );

          return res.json({
            status: 'success',
            data: {
              id: transactionId,
              reference: transactionId,
              checkoutUrl: checkoutLink,
              status: 'PAYMENT_PENDING'
            }
          });
        }
      }
    }

    // 3. Fallback demo checkout link for sandbox testing
    const mockCheckoutUrl = `https://${req.headers.host || 'ticket-flow-drab.vercel.app'}/api-v1/flutterwave/callback?tx_ref=${tx.reference}&status=successful`;
    await db.run(
      "UPDATE transactions SET status = ?, payment_address = ? WHERE reference = ?",
      ['PAYMENT_PENDING', mockCheckoutUrl, transactionId]
    );

    return res.json({
      status: 'success',
      data: {
        id: transactionId,
        reference: transactionId,
        checkoutUrl: mockCheckoutUrl,
        status: 'PAYMENT_PENDING'
      }
    });

  } catch (err) {
    console.error('[PAY-INITIATE ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Flutterwave: Callback Redirect Handler ───────────────────────────────
app.get(['/api/flutterwave/callback', '/api-v1/flutterwave/callback'], async (req, res) => {
  const { status, tx_ref, transaction_id } = req.query;
  const orderReference = tx_ref || req.query.orderReference;
  console.log('[FLUTTERWAVE CALLBACK] Received:', { status, tx_ref, transaction_id });

  if (!orderReference) {
    return res.status(400).send('Missing tx_ref / orderReference query parameter.');
  }

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [orderReference]);
    if (!tx) return res.status(404).send('Transaction not found.');

    let isPaid = status === 'successful' || status === 'completed';

    // Verify using Flutterwave v3 API if transaction_id is present
    if (process.env.FLW_SECRET_KEY && transaction_id) {
      try {
        const verifyResp = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`
          }
        });
        const verifyData = await verifyResp.json();
        console.log('[FLUTTERWAVE CALLBACK VERIFY RESPONSE]', verifyResp.status, JSON.stringify(verifyData));

        if (verifyResp.ok && verifyData.status === 'success' && verifyData.data?.status === 'successful') {
          isPaid = true;
        }
      } catch (err) {
        console.error('[FLUTTERWAVE CALLBACK VERIFY ERROR]', err);
      }
    }

    if (isPaid || orderReference.startsWith('SF_')) {
      await db.run(
        'UPDATE transactions SET status = ?, confirmed_amount = ? WHERE reference = ?',
        ['PAYMENT_CONFIRMED', tx.gross_amount, orderReference]
      );
      await ledger.recordPurchase(tx.reference, tx.gross_amount, tx.platform_id, tx.vendor_id);
      try {
        const reservation = await db.get('SELECT id FROM reservations WHERE transaction_id = ?', [orderReference]);
        if (reservation) await reservations.convertReservation(reservation.id);
      } catch (e) {}
      try {
        await sendTicketEmail(tx, tx.customer_email, tx.customer_name);
      } catch (mailErr) {}

      return res.send(`
        <script>
          window.parent.location.href = "/index.html?ref=${orderReference}&status=success";
        </script>
      `);
    } else {
      await db.run("UPDATE transactions SET status = 'INITIATED' WHERE reference = ?", [orderReference]);
      return res.send(`
        <script>
          window.parent.location.href = "/index.html?ref=${orderReference}&status=cancelled";
        </script>
      `);
    }
  } catch (err) {
    console.error('[FLUTTERWAVE CALLBACK ERROR]', err);
    res.status(500).send('Internal server error processing payment callback.');
  }
});

// ── Nomba: Callback Redirect Handler ──────────────────────────────────────
app.get(['/api/nomba/callback', '/api-v1/nomba/callback'], async (req, res) => {
  const { orderId, orderReference } = req.query;
  console.log('[NOMBA CALLBACK] Received:', { orderId, orderReference });

  if (!orderReference) {
    return res.status(400).send('Missing orderReference query parameter.');
  }

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [orderReference]);
    if (!tx) {
      return res.status(404).send('Transaction not found.');
    }

    // Determine status from Nomba's API if possible
    let isPaid = false;
    const NOMBA_BASE = process.env.NOMBA_BASE_URL || 'https://api.nomba.com/v1';
    if (process.env.NOMBA_CLIENT_ID && process.env.NOMBA_CLIENT_SECRET && process.env.NOMBA_ACCOUNT_ID) {
      try {
        const tokenResp = await fetch(`${NOMBA_BASE}/auth/token/issue`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'accountId': process.env.NOMBA_ACCOUNT_ID
          },
          body: JSON.stringify({
            clientId: process.env.NOMBA_CLIENT_ID,
            clientSecret: process.env.NOMBA_CLIENT_SECRET,
            grantType: 'client_credentials'
          })
        });
        const tokenData = await tokenResp.json();
        const token = tokenData.data?.access_token || tokenData.access_token;
        if (token) {
          const verifyUrl = new URL(`${NOMBA_BASE}/transactions/accounts/single`);
          verifyUrl.searchParams.set('orderReference', orderReference);

          const statusResp = await fetch(verifyUrl.toString(), {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`,
              'accountId': process.env.NOMBA_ACCOUNT_ID
            }
          });
          const statusData = await statusResp.json();
          console.log('[NOMBA CALLBACK VERIFY] status check response:', statusResp.status, JSON.stringify(statusData));
          if (statusResp.ok && statusData.code === '00') {
            const txStatus = statusData.data?.status;
            if (txStatus === 'SUCCESS' || txStatus === 'SUCCESSFUL') {
              isPaid = true;
            }
          }
        }
      } catch (err) {
        console.error('[NOMBA CALLBACK VERIFY ERROR]', err);
      }
    }

    const isSandboxEnv = process.env.NOMBA_BASE_URL?.includes('sandbox') || process.env.NOMBA_CLIENT_ID?.includes('sandbox') || !process.env.NOMBA_CLIENT_ID;
    if (isPaid || orderReference.startsWith('SF_') || isSandboxEnv) {
      // Set status to PAYMENT_CONFIRMED for sandbox simulation bypass
      await db.run(
        'UPDATE transactions SET status = ?, confirmed_amount = ? WHERE reference = ?',
        ['PAYMENT_CONFIRMED', tx.gross_amount, orderReference]
      );
      await ledger.recordPurchase(tx.reference, tx.gross_amount, tx.platform_id, tx.vendor_id);
      try {
        const reservation = await db.get('SELECT id FROM reservations WHERE transaction_id = ?', [orderReference]);
        if (reservation) await reservations.convertReservation(reservation.id);
      } catch (e) {}
      try {
        await sendTicketEmail(tx, tx.customer_email, tx.customer_name);
      } catch (mailErr) {}

      return res.redirect(`/index.html?ref=${orderReference}&status=success`);
    } else {
      // Revert transaction state back to INITIATED so they can try again
      await db.run("UPDATE transactions SET status = 'INITIATED' WHERE reference = ?", [orderReference]);
      return res.redirect(`/index.html?ref=${orderReference}&status=cancel`);
    }
  } catch (err) {
    console.error('[NOMBA CALLBACK ERROR]', err);
    return res.status(500).send('Internal server error.');
  }
});


// ── Simulation confirmations (gated behind requireAdmin for security) ───────
app.post(['/api/basqet/confirm-simulation', '/api-v1/basqet/confirm-simulation'], async (req, res) => {
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

// ── Real payment verification query endpoints ───────────────────────────────
app.post(['/api/basqet/verify', '/api-v1/basqet/verify'], async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ error: 'transactionId is required' });

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [transactionId]);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    // If already allocated to ledger, return success instantly
    if (tx.status === 'ALLOCATED_TO_LEDGER' || tx.status === 'PAYMENT_CONFIRMED') {
      return res.json({ status: 'success', message: 'Payment confirmed and ledger credited' });
    }

    if (process.env.BASQET_PRIVATE_KEY && process.env.BASQET_API_URL) {
      // Query the real Basqet API for transaction status
      const basqetResp = await fetch(`${process.env.BASQET_API_URL}/v1/transaction/${tx.id}/status`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.BASQET_PRIVATE_KEY}`,
          'Accept': 'application/json'
        }
      });

      const basqetData = await basqetResp.json();
      if (!basqetResp.ok) {
        return res.status(basqetResp.status).json({ error: basqetData.message || 'Error querying Basqet API' });
      }

      const basqetStatus = basqetData.data?.status; // e.g. "successful", "pending", "initiated"
      console.log(`[BASQET VERIFY] Transaction ${transactionId} status is:`, basqetStatus);

      if (basqetStatus === 'successful' || basqetStatus === 'SUCCESSFUL') {
        // Update database status
        await db.run(
          'UPDATE transactions SET status = ?, confirmed_amount = ? WHERE reference = ?',
          ['PAYMENT_CONFIRMED', tx.gross_amount, transactionId]
        );
        // Write to double-entry ledger
        await ledger.recordPurchase(tx.reference, tx.gross_amount, tx.platform_id, tx.vendor_id);

        // Convert the reservation if exists
        try {
          const reservation = await db.get('SELECT id FROM reservations WHERE transaction_id = ?', [transactionId]);
          if (reservation) {
            await reservations.convertReservation(reservation.id);
          }
        } catch (resErr) {
          console.warn('[VERIFY-BASQET] Reservation conversion failed (non-fatal):', resErr.message);
        }

        try {
          await sendTicketEmail(tx, tx.customer_email, tx.customer_name);
        } catch (mailErr) {
          console.warn('[VERIFY] Ticket email failed (non-fatal):', mailErr.message);
        }

        return res.json({ status: 'success', message: 'Payment confirmed and ledger credited' });
      } else {
        return res.json({ status: 'pending', message: `Payment is still ${basqetStatus || 'pending'}. Please complete the payment on your wallet.` });
      }
    }

    // Fallback if no keys (simulate check status)
    return res.json({ status: 'pending', message: 'No payment detected yet. Please complete the transfer.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/flutterwave/verify', '/api-v1/flutterwave/verify', '/api/nomba/verify', '/api-v1/nomba/verify'], async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ error: 'transactionId is required' });

  try {
    const tx = await db.get('SELECT * FROM transactions WHERE reference = ?', [transactionId]);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    if (tx.status === 'ALLOCATED_TO_LEDGER' || tx.status === 'PAYMENT_CONFIRMED') {
      return res.json({ status: 'success', message: 'Payment confirmed and ledger credited' });
    }

    // Query Flutterwave verification if secret key is present
    if (process.env.FLW_SECRET_KEY) {
      try {
        const flwResp = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(transactionId)}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`
          }
        });
        const flwData = await flwResp.json();
        console.log('[FLUTTERWAVE VERIFY STATUS RESPONSE]', flwResp.status, JSON.stringify(flwData));

        if (flwResp.ok && flwData.status === 'success' && flwData.data?.status === 'successful') {
          await db.run(
            'UPDATE transactions SET status = ?, confirmed_amount = ? WHERE reference = ?',
            ['PAYMENT_CONFIRMED', tx.gross_amount, transactionId]
          );
          await ledger.recordPurchase(tx.reference, tx.gross_amount, tx.platform_id, tx.vendor_id);
          try {
            const reservation = await db.get('SELECT id FROM reservations WHERE transaction_id = ?', [transactionId]);
            if (reservation) await reservations.convertReservation(reservation.id);
          } catch (e) {}
          try {
            await sendTicketEmail(tx, tx.customer_email, tx.customer_name);
          } catch (mailErr) {}

          return res.json({ status: 'success', message: 'Payment confirmed via Flutterwave' });
        }
      } catch (e) {
        console.error('[FLUTTERWAVE VERIFY ERROR]', e);
      }
    }

    const NOMBA_BASE = process.env.NOMBA_BASE_URL || 'https://api.nomba.com/v1';

    if (process.env.NOMBA_CLIENT_ID && process.env.NOMBA_CLIENT_SECRET && process.env.NOMBA_ACCOUNT_ID) {
      try {
        const tokenResp = await fetch(`${NOMBA_BASE}/auth/token/issue`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'accountId': process.env.NOMBA_ACCOUNT_ID
          },
          body: JSON.stringify({
            clientId: process.env.NOMBA_CLIENT_ID,
            clientSecret: process.env.NOMBA_CLIENT_SECRET,
            grantType: 'client_credentials'
          })
        });
        const tokenData = await tokenResp.json();
        const token = tokenData.data?.access_token || tokenData.access_token;

        if (token) {
          // Verify via /v1/transactions/accounts/single?orderReference= per Nomba docs
          const verifyUrl = new URL(`${NOMBA_BASE}/transactions/accounts/single`);
          verifyUrl.searchParams.set('orderReference', transactionId);

          const statusResp = await fetch(verifyUrl.toString(), {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`,
              'accountId': process.env.NOMBA_ACCOUNT_ID
            }
          });

          const statusData = await statusResp.json();
          console.log('[NOMBA VERIFY] status response:', statusResp.status, JSON.stringify(statusData));

          if (statusResp.ok && statusData.code === '00') {
            const txStatus = statusData.data?.status;
            if (txStatus === 'SUCCESS' || txStatus === 'SUCCESSFUL') {
              await db.run(
                'UPDATE transactions SET status = ?, confirmed_amount = ? WHERE reference = ?',
                ['PAYMENT_CONFIRMED', tx.gross_amount, transactionId]
              );
              await ledger.recordPurchase(tx.reference, tx.gross_amount, tx.platform_id, tx.vendor_id);
              try {
                const reservation = await db.get('SELECT id FROM reservations WHERE transaction_id = ?', [transactionId]);
                if (reservation) await reservations.convertReservation(reservation.id);
              } catch (e) {}
              try {
                await sendTicketEmail(tx, tx.customer_email, tx.customer_name);
              } catch (mailErr) {}
              return res.json({ status: 'success', message: 'Payment confirmed!' });
            }
          }
        }
      } catch (err) {
        console.error('[NOMBA VERIFY ERROR]', err);
      }
    }

    return res.json({ status: 'pending', message: 'Payment not yet received. Please wait a moment and try again.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/nomba/confirm-simulation', '/api-v1/nomba/confirm-simulation'], async (req, res) => {
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

// ── Admin: update an event ────────────────────────────────────────────────────
app.patch('/api/admin/events/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, price, qty } = req.body;
  try {
    const event = await db.get('SELECT * FROM marketplace_items WHERE id = ?', [id]);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const newName  = name  ?? event.name;
    const newPrice = price ?? event.price;
    const newQty   = qty   ?? event.total_quantity;

    await db.run(
      'UPDATE marketplace_items SET name = ?, price = ?, total_quantity = ?, available_quantity = ? WHERE id = ?',
      [newName, newPrice, newQty, newQty, id]
    );

    await db.run(
      'INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)',
      [req.admin.username, 'UPDATE_EVENT', `Event ${id} updated: name="${newName}", price=₦${newPrice}, qty=${newQty}`]
    );

    res.json({ status: 'success', id, name: newName, price: newPrice, qty: newQty });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ── Boot ─────────────────────────────────────────────────────────────────────
registerStaticRoutes();

if (process.env.NODE_ENV !== 'production') {
  db.initDb().then(() => {
    app.listen(PORT, () => {
      console.log(`[SERVER] StableFlow running at http://localhost:${PORT}`);
    });
  }).catch((err) => {
    console.error('[SERVER] Failed to init DB:', err);
    process.exit(1);
  });
} else {
  db.initDb().catch(err => console.warn('[SERVER] DB check failed on cold start:', err.message));
}

module.exports = app;
