const { pool } = require('../db/pool');

let ensured = false;

async function ensureWorkdayClosureNotifiedTable() {
  if (ensured) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS workday_closure_notified (
      employee_id CHAR(36) NOT NULL,
      workday_date DATE NOT NULL,
      notified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_id, workday_date)
    ) ENGINE=InnoDB`
  );
  ensured = true;
}

/**
 * After a manual / geofence workday close, record this so `workdayAutoClosureJob` does not add a duplicate AUTO close.
 * Also use when `workday_date` on the close row could disagree with activity rows (occurred_at still falls on that DR day).
 */
async function recordWorkdayClosureHandledForAutoJob(employeeId, workdayDate) {
  await ensureWorkdayClosureNotifiedTable();
  await pool.query(
    `INSERT IGNORE INTO workday_closure_notified (employee_id, workday_date) VALUES (?, ?)`,
    [employeeId, workdayDate]
  );
}

module.exports = {
  ensureWorkdayClosureNotifiedTable,
  recordWorkdayClosureHandledForAutoJob
};
