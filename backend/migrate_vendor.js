const postgres = require('postgres');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL env variable not found!");
  process.exit(1);
}

const sql = postgres(connectionString, {
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  try {
    console.log("Connected to database. Executing schema update...");
    await sql.unsafe(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;`);
    await sql.unsafe(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
    console.log("Database schema successfully updated!");
  } catch (err) {
    console.error("Migration failed:", err.message);
  } finally {
    await sql.end();
  }
}

migrate();
