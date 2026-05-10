const { DateTime } = require('luxon');
const { pool } = require('../db/pool');
const { toWorkdayDate, ZONE } = require('./timezone');

/**
 * mysql2 returns JS `Date` for DATE columns; `String(d).slice(0,10)` becomes "Sun Apr 19" (invalid for SQL DATE).
 * Always normalize to yyyy-LL-dd for binds.
 */
function toIsoWorkdayDateSql(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return DateTime.fromJSDate(value).setZone(ZONE).toFormat('yyyy-LL-dd');
  }
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const dt = DateTime.fromISO(str, { zone: ZONE });
  if (dt.isValid) return dt.toFormat('yyyy-LL-dd');
  const t = Date.parse(str);
  if (!Number.isNaN(t)) {
    return DateTime.fromMillis(t).setZone(ZONE).toFormat('yyyy-LL-dd');
  }
  return str.slice(0, 10);
}

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
    return toIsoWorkdayDateSql(d);
  }
  return target;
}

module.exports = { resolveWorkdayDateForClose };
