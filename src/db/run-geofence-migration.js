/**
 * Runs the GEOFENCE_ENTER/GEOFENCE_EXIT migration.
 * Use when mysql client is not installed: npm run db:geofence-migrate
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

async function main() {
  const migrationPath = path.join(__dirname, 'migrations', '001_add_geofence_enter_exit.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  const conn = await pool.getConnection();
  try {
    await conn.query(sql);
    console.log('Migration 001_add_geofence_enter_exit completed successfully.');
  } finally {
    conn.release();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
