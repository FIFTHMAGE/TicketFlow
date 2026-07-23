const fs = require('fs');
const path = require('path');
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
    console.log("Connected to database. Executing schema initialization...");

    const schemaPath = path.join(__dirname, '../supabase_schema.sql');
    const sqlContent = fs.readFileSync(schemaPath, 'utf8');

    // Run the schema setup
    await sql.unsafe(sqlContent);
    console.log("Database schema successfully deployed and seeded!");
  } catch (err) {
    console.error("Migration failed:", err.message);
  } finally {
    await sql.end();
  }
}

migrate();
