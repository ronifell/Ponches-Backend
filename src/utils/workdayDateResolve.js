const { pool } = require('../db/pool');
const { toWorkdayDate } = require('./timezone');

/**
 * Use the same calendar `workday_date` as today's activity rows when present, so manual close
 * lines up with CHECK_IN/MOVEMENT rows and the auto-close job sees one closed workday.
 */
async function resolveWorkdayDateForClose(employeeId, occurredAtDt) {
  const target = toWorkdayDate(occurredAtDt);
  const [rows] = await pool.query(
    `SELECT workday_date FROM attendance_events
     WHERE employee_id = ?
       AND workday_date = ?
       AND event_type IN ('CHECK_IN', 'MOVEMENT', 'GEOFENCE_ENTER', 'GEOFENCE_EXIT')
     ORDER BY occurred_at DESC
     LIMIT 1`,
    [employeeId, target]
  );
  const d = rows?.[0]?.workday_date;
  if (d) {
    const s = typeof d === 'string' ? d.slice(0, 10) : String(d).slice(0, 10);
    return s;
  }
  return target;
}

module.exports = { resolveWorkdayDateForClose };
