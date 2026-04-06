const { pool } = require('./pool');

let ensured = false;

/**
 * Adds free-text region (operational area, not geofence). Drops legacy card_number if present.
 */
async function ensureEmployeeRegionColumns() {
  if (ensured) return;
  try {
    await pool.query('ALTER TABLE employees ADD COLUMN region VARCHAR(128) NULL');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
  try {
    await pool.query('ALTER TABLE employees DROP COLUMN card_number');
  } catch (e) {
    const ok = e.code === 'ER_CANT_DROP_FIELD_OR_KEY' || e.errno === 1091;
    if (!ok) throw e;
  }
  ensured = true;
}

module.exports = { ensureEmployeeRegionColumns };
