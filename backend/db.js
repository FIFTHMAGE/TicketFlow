const { AsyncLocalStorage } = require('async_hooks');
const pg = require('pg');
const { URL } = require('url');
const bcrypt = require('bcryptjs');

const transactionStorage = new AsyncLocalStorage();

let pool = null;

if (process.env.DATABASE_URL) {
  console.log('[DB] Connecting to Supabase via DATABASE_URL parser fallback...');
  try {
    const parsed = new URL(process.env.DATABASE_URL);
    const auth = decodeURIComponent(parsed.username || '').split(':');
    
    const config = {
      host: parsed.hostname,
      port: parseInt(parsed.port || '5432', 10),
      database: parsed.pathname.substring(1),
      user: auth[0] || 'postgres',
      password: auth[1] || '',
      ssl: { rejectUnauthorized: false }
    };
    
    console.log('[DB] Host:', config.host, 'User:', config.user, 'Port:', config.port);
    pool = new pg.Pool(config);
  } catch (err) {
    console.warn('[DB] Failed parsing DATABASE_URL, fallback to raw connectionString:', err.message);
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }
} else if (process.env.DB_HOST) {
  console.log('[DB] Connecting to Supabase via individual parameters...');
  pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
  });
} else {
  console.error('[DB] FATAL: Either DATABASE_URL or DB_HOST must be set.');
  process.exit(1);
}

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
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('[DB] Connection check successful. Database time:', res.rows[0].now);
  } catch (err) {
    console.warn('[DB] Connection check failed on startup (non-blocking):', err.message);
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
