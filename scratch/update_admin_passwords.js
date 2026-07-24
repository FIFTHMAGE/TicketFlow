require('dotenv').config();
const path = require('path');
const db = require(path.join(__dirname, '../backend/db'));

async function fixAdmins() {
  await db.db.unsafe(`UPDATE admins SET password_hash = '$2b$10$Lp4WfVKb1OMMra1UQJyx1OgzukCJJSmVajUbP9jaVCBN26G/e6jlW' WHERE username = 'admin'`);
  await db.db.unsafe(`UPDATE admins SET password_hash = '$2b$10$GUhIg0U1Kw69qWO5hUSNQ.289VLosI2CGixmctdUX5c8yNtdI4pYi' WHERE username = 'finance'`);
  console.log('SUCCESS');
  process.exit(0);
}

fixAdmins().catch(err => {
  console.error(err);
  process.exit(1);
});
