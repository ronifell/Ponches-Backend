/**
 * Runs the password_reset_codes table migration.
 * Use for existing DBs: npm run db:password-reset-migrate
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

async function main() {
  const migrationPath = path.join(__dirname, 'migrations', '003_password_reset_codes.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  const conn = await pool.getConnection();
  try {
    await conn.query(sql);
    console.log('Migration 003_password_reset_codes completed successfully.');
  } finally {
    conn.release();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
