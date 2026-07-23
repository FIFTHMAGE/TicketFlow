const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.resolve(__dirname, 'stableflow_marketplace.db');
const db = new sqlite3.Database(dbPath);

// Helper to run query with promise
const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

// Helper to query all with promise
const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Helper to query one row with promise
const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Helper to wrap transactions in BEGIN IMMEDIATE to acquire write lock
const runTransaction = async (actions) => {
  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    const result = await actions();
    await run('COMMIT');
    return result;
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
};

const initDb = async () => {
  // Enable foreign keys
  await run('PRAGMA foreign_keys = ON');

  // Create platforms table
  await run(`
    CREATE TABLE IF NOT EXISTS platforms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      commission_type TEXT NOT NULL DEFAULT 'PERCENTAGE',
      commission_value REAL NOT NULL DEFAULT 0.0,
      settlement_cycle TEXT NOT NULL DEFAULT 'T+1',
      vendor_split_pct REAL NOT NULL DEFAULT 90.0,
      platform_split_pct REAL NOT NULL DEFAULT 10.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create vendors table
  await run(`
    CREATE TABLE IF NOT EXISTS vendors (
      id TEXT PRIMARY KEY,
      platform_id TEXT NOT NULL,
      name TEXT NOT NULL,
      bank_name TEXT NOT NULL,
      account_number TEXT NOT NULL,
      account_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (platform_id) REFERENCES platforms(id)
    )
  `);

  // Create marketplace_items table (events/tickets)
  await run(`
    CREATE TABLE IF NOT EXISTS marketplace_items (
      id TEXT PRIMARY KEY,
      platform_id TEXT NOT NULL,
      vendor_id TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      FOREIGN KEY (platform_id) REFERENCES platforms(id),
      FOREIGN KEY (vendor_id) REFERENCES vendors(id)
    )
  `);

  // Create transactions table
  await run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      platform_id TEXT NOT NULL,
      vendor_id TEXT NOT NULL,
      marketplace_item_id TEXT NOT NULL,
      gross_amount REAL NOT NULL,
      platform_fee REAL NOT NULL,
      vendor_amount REAL NOT NULL,
      confirmed_amount REAL,
      status TEXT NOT NULL DEFAULT 'INITIATED',
      crypto_currency_id INTEGER,
      crypto_amount REAL,
      payment_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (platform_id) REFERENCES platforms(id),
      FOREIGN KEY (vendor_id) REFERENCES vendors(id),
      FOREIGN KEY (marketplace_item_id) REFERENCES marketplace_items(id)
    )
  `);

  // Create ledger_accounts table
  await run(`
    CREATE TABLE IF NOT EXISTS ledger_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0.0
    )
  `);

  // Create ledger_entries table
  await run(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reference TEXT NOT NULL,
      account_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES ledger_accounts(id)
    )
  `);

  // Create settlement_batches table
  await run(`
    CREATE TABLE IF NOT EXISTS settlement_batches (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create payouts table with approval tracking
  await run(`
    CREATE TABLE IF NOT EXISTS payouts (
      id TEXT PRIMARY KEY,
      vendor_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      amount REAL NOT NULL,
      idempotency_key TEXT UNIQUE NOT NULL,
      provider_reference TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      approved_by_finance TEXT,
      approved_by_admin TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendor_id) REFERENCES vendors(id),
      FOREIGN KEY (batch_id) REFERENCES settlement_batches(id)
    )
  `);

  // Create webhook_events table for idempotency
  await run(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create reconciliation_flags table
  await run(`
    CREATE TABLE IF NOT EXISTS reconciliation_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_difference REAL NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create admins table with roles
  await run(`
    CREATE TABLE IF NOT EXISTS admins (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'ADMIN', -- 'ADMIN' or 'FINANCE'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create audit_logs table with states and IP tracking
  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      before_state TEXT,
      after_state TEXT,
      ip_address TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed default admin accounts
  const defaultAdmin = await get("SELECT * FROM admins WHERE username = 'admin'");
  if (!defaultAdmin) {
    const adminHash = await bcrypt.hash('password123', 10);
    await run('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)', ['admin', adminHash, 'ADMIN']);
  }
  
  const defaultFinance = await get("SELECT * FROM admins WHERE username = 'finance'");
  if (!defaultFinance) {
    const financeHash = await bcrypt.hash('finance123', 10);
    await run('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)', ['finance', financeHash, 'FINANCE']);
  }

  // Seed default platform & ledger accounts if empty
  const defaultPlatform = await get('SELECT * FROM platforms LIMIT 1');
  if (!defaultPlatform) {
    const platformId = 'platform_stableflow_1';
    await run(
      'INSERT INTO platforms (id, name, commission_type, commission_value, settlement_cycle, vendor_split_pct, platform_split_pct) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [platformId, 'StableFlow Events Marketplace', 'PERCENTAGE', 10.0, 'T+1', 90.0, 10.0]
    );

    // Seed Ledger Accounts
    await run("INSERT INTO ledger_accounts (id, name, type) VALUES ('SETTLEMENT_POOL', 'Settlement Pool', 'ASSET')");
    await run("INSERT INTO ledger_accounts (id, name, type) VALUES ('PLATFORM_REVENUE', 'Platform Revenue', 'REVENUE')");
    await run("INSERT INTO ledger_accounts (id, name, type) VALUES ('REFUND_RESERVE', 'Refund Reserve', 'LIABILITY')");
    await run("INSERT INTO ledger_accounts (id, name, type) VALUES ('CHARGEBACK_RESERVE', 'Chargeback Reserve', 'LIABILITY')");

    // Seed Vendors
    const vendor1 = 'vendor_tix_organizer';
    await run(
      'INSERT INTO vendors (id, platform_id, name, bank_name, account_number, account_name) VALUES (?, ?, ?, ?, ?, ?)',
      [vendor1, platformId, 'Tix Africa Organizer', 'Wema Bank', '0123456789', 'Tix Africa Event Services']
    );
    await run(`INSERT INTO ledger_accounts (id, name, type) VALUES ('VENDOR_PAYABLE_' || ?, ?, 'LIABILITY')`, [
      vendor1,
      'Vendor Payable - Tix Africa Organizer'
    ]);

    const vendor2 = 'vendor_tech_fest';
    await run(
      'INSERT INTO vendors (id, platform_id, name, bank_name, account_number, account_name) VALUES (?, ?, ?, ?, ?, ?)',
      [vendor2, platformId, 'Lagos Tech Fest', 'Access Bank', '9876543210', 'Tech Fest Ltd']
    );
    await run(`INSERT INTO ledger_accounts (id, name, type) VALUES ('VENDOR_PAYABLE_' || ?, ?, 'LIABILITY')`, [
      vendor2,
      'Vendor Payable - Lagos Tech Fest'
    ]);

    // Seed Marketplace Items
    await run(
      'INSERT INTO marketplace_items (id, platform_id, vendor_id, name, price) VALUES (?, ?, ?, ?, ?)',
      ['item_tech_ticket', platformId, vendor1, 'Lagos Tech Fest Standard Pass', 10000.0]
    );
    await run(
      'INSERT INTO marketplace_items (id, platform_id, vendor_id, name, price) VALUES (?, ?, ?, ?, ?)',
      ['item_vip_ticket', platformId, vendor2, 'Lagos Tech Fest VIP Pass', 50000.0]
    );
    
    // Seed a high value item for testing threshold authorization limit (₦5,000,000+)
    await run(
      'INSERT INTO marketplace_items (id, platform_id, vendor_id, name, price) VALUES (?, ?, ?, ?, ?)',
      ['item_mega_concert', platformId, vendor2, 'Mega Festival Premium Sponsorship', 6000000.0]
    );
  }
};

module.exports = {
  db,
  run,
  all,
  get,
  runTransaction,
  initDb
};
