-- ============================================================
-- StableFlow / TicketFlow — Supabase Schema
-- Run this entire file in the Supabase SQL Editor once,
-- before connecting your app via DATABASE_URL.
-- ============================================================


-- ── Platforms ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platforms (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  commission_type     TEXT NOT NULL DEFAULT 'PERCENTAGE',
  commission_value    NUMERIC(15,2) NOT NULL DEFAULT 0.0,
  settlement_cycle    TEXT NOT NULL DEFAULT 'T+1',
  vendor_split_pct    NUMERIC(6,4) NOT NULL DEFAULT 90.0,
  platform_split_pct  NUMERIC(6,4) NOT NULL DEFAULT 10.0,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);


-- ── Vendors ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors (
  id              TEXT PRIMARY KEY,
  platform_id     TEXT NOT NULL REFERENCES platforms(id),
  name            TEXT NOT NULL,
  bank_name       TEXT NOT NULL,
  bank_code       TEXT,
  account_number  TEXT NOT NULL,
  account_name    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendors_platform ON vendors(platform_id);


-- ── Marketplace Items (Events / Tickets) ─────────────────────
CREATE TABLE IF NOT EXISTS marketplace_items (
  id          TEXT PRIMARY KEY,
  platform_id TEXT NOT NULL REFERENCES platforms(id),
  vendor_id   TEXT NOT NULL REFERENCES vendors(id),
  name        TEXT NOT NULL,
  price       NUMERIC(15,2) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE'
);

CREATE INDEX IF NOT EXISTS idx_items_platform ON marketplace_items(platform_id);
CREATE INDEX IF NOT EXISTS idx_items_vendor   ON marketplace_items(vendor_id);


-- ── Transactions ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id                    TEXT PRIMARY KEY,
  reference             TEXT UNIQUE NOT NULL,
  platform_id           TEXT NOT NULL REFERENCES platforms(id),
  vendor_id             TEXT NOT NULL REFERENCES vendors(id),
  marketplace_item_id   TEXT NOT NULL REFERENCES marketplace_items(id),
  gross_amount          NUMERIC(15,2) NOT NULL,
  platform_fee          NUMERIC(15,2) NOT NULL,
  vendor_amount         NUMERIC(15,2) NOT NULL,
  confirmed_amount      NUMERIC(15,2),
  status                TEXT NOT NULL DEFAULT 'INITIATED',
  customer_name         TEXT,
  customer_email        TEXT,
  crypto_currency_id    INTEGER,
  crypto_amount         NUMERIC(20,8),
  payment_address       TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_status     ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_vendor     ON transactions(vendor_id);


-- ── Ledger Accounts ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  type    TEXT NOT NULL,       -- ASSET | LIABILITY | REVENUE
  balance NUMERIC(20,2) NOT NULL DEFAULT 0.0
);


-- ── Ledger Entries (Double-Entry Journal) ─────────────────────
CREATE TABLE IF NOT EXISTS ledger_entries (
  id          BIGSERIAL PRIMARY KEY,
  reference   TEXT NOT NULL,
  account_id  TEXT NOT NULL REFERENCES ledger_accounts(id),
  type        TEXT NOT NULL,   -- DEBIT | CREDIT
  amount      NUMERIC(15,2) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entries_reference  ON ledger_entries(reference);
CREATE INDEX IF NOT EXISTS idx_entries_account    ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_entries_created_at ON ledger_entries(created_at DESC);


-- ── Settlement Batches ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settlement_batches (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_batches_status ON settlement_batches(status);


-- ── Payouts ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payouts (
  id                  TEXT PRIMARY KEY,
  vendor_id           TEXT NOT NULL REFERENCES vendors(id),
  batch_id            TEXT NOT NULL REFERENCES settlement_batches(id),
  amount              NUMERIC(15,2) NOT NULL,
  idempotency_key     TEXT UNIQUE NOT NULL,
  provider_reference  TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  approved_by_finance TEXT,
  approved_by_admin   TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payouts_status   ON payouts(status);
CREATE INDEX IF NOT EXISTS idx_payouts_vendor   ON payouts(vendor_id);
CREATE INDEX IF NOT EXISTS idx_payouts_batch    ON payouts(batch_id);


-- ── Webhook Events (Idempotency) ──────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_events (
  id         TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ── Reconciliation Flags ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS reconciliation_flags (
  id                 BIGSERIAL PRIMARY KEY,
  transaction_id     TEXT NOT NULL,
  type               TEXT NOT NULL,   -- AMOUNT_MISMATCH | LEDGER_UNBALANCED
  amount_difference  NUMERIC(15,2) NOT NULL,
  description        TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flags_transaction ON reconciliation_flags(transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_flags_ledger_unbalanced
  ON reconciliation_flags(transaction_id, type)
  WHERE type = 'LEDGER_UNBALANCED';


-- ── Admins ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
  username      TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'ADMIN',   -- ADMIN | FINANCE
  created_at    TIMESTAMPTZ DEFAULT NOW()
);


-- ── Audit Logs ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  username     TEXT NOT NULL,
  action       TEXT NOT NULL,
  details      TEXT,
  before_state TEXT,
  after_state  TEXT,
  ip_address   TEXT,
  timestamp    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_username  ON audit_logs(username);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);


-- ============================================================
-- SEED DATA
-- Run this section only once on a fresh database.
-- After deployment, change admin passwords immediately via:
--   UPDATE admins SET password_hash = crypt('NEW_PASSWORD', gen_salt('bf')) WHERE username = 'admin';
-- ============================================================

-- Default platform
INSERT INTO platforms (id, name, commission_type, commission_value, settlement_cycle, vendor_split_pct, platform_split_pct)
VALUES ('platform_stableflow_1', 'StableFlow Events Marketplace', 'PERCENTAGE', 10.0, 'T+1', 90.0, 10.0)
ON CONFLICT (id) DO NOTHING;

-- Ledger accounts
INSERT INTO ledger_accounts (id, name, type) VALUES
  ('SETTLEMENT_POOL',    'Settlement Pool',    'ASSET'),
  ('PLATFORM_REVENUE',   'Platform Revenue',   'REVENUE'),
  ('REFUND_RESERVE',     'Refund Reserve',     'LIABILITY'),
  ('CHARGEBACK_RESERVE', 'Chargeback Reserve', 'LIABILITY')
ON CONFLICT (id) DO NOTHING;

-- Vendors
INSERT INTO vendors (id, platform_id, name, bank_name, account_number, account_name)
VALUES
  ('vendor_tix_organizer', 'platform_stableflow_1', 'Tix Africa Organizer', 'Wema Bank',   '0123456789', 'Tix Africa Event Services'),
  ('vendor_tech_fest',     'platform_stableflow_1', 'Lagos Tech Fest',       'Access Bank', '9876543210', 'Tech Fest Ltd')
ON CONFLICT (id) DO NOTHING;

-- Vendor ledger payable accounts
INSERT INTO ledger_accounts (id, name, type) VALUES
  ('VENDOR_PAYABLE_vendor_tix_organizer', 'Vendor Payable - Tix Africa Organizer', 'LIABILITY'),
  ('VENDOR_PAYABLE_vendor_tech_fest',     'Vendor Payable - Lagos Tech Fest',       'LIABILITY')
ON CONFLICT (id) DO NOTHING;

-- Marketplace items (events)
INSERT INTO marketplace_items (id, platform_id, vendor_id, name, price) VALUES
  ('item_tech_ticket',   'platform_stableflow_1', 'vendor_tix_organizer', 'Lagos Tech Fest Standard Pass',        10000.00),
  ('item_vip_ticket',    'platform_stableflow_1', 'vendor_tech_fest',     'Lagos Tech Fest VIP Pass',             50000.00),
  ('item_mega_concert',  'platform_stableflow_1', 'vendor_tech_fest',     'Mega Festival Premium Sponsorship',  6000000.00)
ON CONFLICT (id) DO NOTHING;

-- Default admin accounts
-- IMPORTANT: These use bcrypt hashes of 'password123' and 'finance123'.
-- Change these passwords immediately after first login.
INSERT INTO admins (username, password_hash, role) VALUES
  ('admin',   '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'ADMIN'),
  ('finance', '$2a$10$dAbE2UoJj6Pof7.bNRnFOucQQE53pJnHsEhIqf0k8JNAV0Wf.IXW', 'FINANCE')
ON CONFLICT (username) DO NOTHING;

-- ============================================================
-- Row Level Security (Optional — recommended for Supabase)
-- Uncomment and configure if you want table-level RLS.
-- The app connects via a service role key so RLS is bypassed,
-- but enabling it protects against accidental direct access.
-- ============================================================

-- ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
