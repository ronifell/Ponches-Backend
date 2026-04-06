const { pool } = require('./pool');

let ensured = false;

/**
 * Adds free-text region (operational area, not geofence) and optional access card number.
 * Idempotent for existing databases.
 */
async function ensureEmployeeRegionColumns() {
  if (ensured) return;
  for (const sql of [
    'ALTER TABLE employees ADD COLUMN region VARCHAR(128) NULL',
    'ALTER TABLE employees ADD COLUMN card_number VARCHAR(64) NULL'
  ]) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
  }
  ensured = true;
}

module.exports = { ensureEmployeeRegionColumns };
