/**
 * Runs the employee_invites table migration.
 * Use for existing DBs: npm run db:invites-migrate
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

async function main() {
  const migrationPath = path.join(__dirname, 'migrations', '002_employee_invites.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  const conn = await pool.getConnection();
  try {
    await conn.query(sql);
    console.log('Migration 002_employee_invites completed successfully.');
  } finally {
    conn.release();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
