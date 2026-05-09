const { pool } = require('./pool');

let qualitiesCustomerMobileEnsured = false;

async function ensureQualitiesCustomerMobileColumn() {
  if (qualitiesCustomerMobileEnsured) return;
  try {
    await pool.query('ALTER TABLE qualities ADD COLUMN customer_mobile VARCHAR(32) NULL');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
  qualitiesCustomerMobileEnsured = true;
}

module.exports = { ensureQualitiesCustomerMobileColumn };
