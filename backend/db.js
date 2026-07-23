const { AsyncLocalStorage } = require('async_hooks');
const postgres = require('postgres');
const bcrypt = require('bcryptjs');

const transactionStorage = new AsyncLocalStorage();

if (!process.env.DATABASE_URL) {
  console.error('[DB] FATAL: DATABASE_URL environment variable must be set.');
  process.exit(1);
}

console.log('[DB] Initializing postgres database client...');

// Initialize the database client using the connection pooler
const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
  max: 10,
  idle_timeout: 20,
  connect_timeout: 30
});

// Get the current execution client (transaction client or global pool)
const getExecutor = () => {
  return transactionStorage.getStore() || sql;
};

// Unified run query execution
const run = async (queryStr, params = []) => {
  const executor = getExecutor();
  
  // Transform standard ? placeholders to postgres $1, $2 style
  let index = 1;
  const transformedQuery = queryStr.replace(/\?/g, () => `$${index++}`);
  
  const res = await executor.unsafe(transformedQuery, params);
  return { id: res[0]?.id || null, changes: res.count };
};

// Unified query all rows
const all = async (queryStr, params = []) => {
  const executor = getExecutor();
  let index = 1;
  const transformedQuery = queryStr.replace(/\?/g, () => `$${index++}`);
  
  return await executor.unsafe(transformedQuery, params);
};

// Unified query single row
const get = async (queryStr, params = []) => {
  const executor = getExecutor();
  let index = 1;
  const transformedQuery = queryStr.replace(/\?/g, () => `$${index++}`);
  
  const res = await executor.unsafe(transformedQuery, params);
  return res[0] || null;
};

// Unified Transaction Runner
const runTransaction = async (actions) => {
  return await sql.begin(async (tx) => {
    return await transactionStorage.run(tx, async () => {
      return await actions();
    });
  });
};

const initDb = async () => {
  try {
    const res = await sql`SELECT NOW()`;
    console.log('[DB] Connection check successful. Database time:', res[0].now);
  } catch (err) {
    console.warn('[DB] Connection check failed on startup (non-blocking):', err.message);
  }
};

module.exports = {
  db: sql,
  run,
  all,
  get,
  runTransaction,
  initDb
};
