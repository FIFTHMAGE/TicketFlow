const { AsyncLocalStorage } = require('async_hooks');
const pg = require('pg');
const bcrypt = require('bcryptjs');

const transactionStorage = new AsyncLocalStorage();

if (!process.env.DATABASE_URL) {
  console.error('[DB] FATAL: DATABASE_URL environment variable must be set to connect to Supabase.');
  process.exit(1);
}

console.log('[DB] Connecting to Supabase/PostgreSQL...');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Supabase serverless connections
  }
});

// Get the current execution client (transaction client or global pool)
const getExecutor = () => {
  return transactionStorage.getStore() || pool;
};

// Unified run query execution
const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    const executor = getExecutor();
    executor.query(sql, params, (err, res) => {
      if (err) reject(err);
      else resolve({ id: res.rows[0]?.id || null, changes: res.rowCount });
    });
  });
};

// Unified query all rows
const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    const executor = getExecutor();
    executor.query(sql, params, (err, res) => {
      if (err) reject(err);
      else resolve(res.rows);
    });
  });
};

// Unified query single row
const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    const executor = getExecutor();
    executor.query(sql, params, (err, res) => {
      if (err) reject(err);
      else resolve(res.rows[0] || null);
    });
  });
};

// Unified Transaction Runner
const runTransaction = async (actions) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await transactionStorage.run(client, async () => {
      return await actions();
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const initDb = async () => {
  // Database tables are pre-provisioned via the Supabase schema script directly.
  // We perform a basic connectivity check on boot here instead.
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('[DB] Connection check successful. Database time:', res.rows[0].now);
  } catch (err) {
    console.error('[DB] Connection check failed:', err.message);
    throw err;
  }
};

module.exports = {
  db: pool,
  run,
  all,
  get,
  runTransaction,
  initDb
};
