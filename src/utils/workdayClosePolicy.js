const { DateTime } = require('luxon');
const { pool } = require('../db/pool');
const { ZONE, toWorkdayDate } = require('./timezone');

/**
 * Earliest local time (America/Santo_Domingo) when an EMPLOYEE may manually close the workday.
 * Half day → 12:00; otherwise (including no schedule row) → 17:00.
 */
async function getScheduleDayTypeForDate(employeeId, companyId, scheduleDate) {
  const [rows] = await pool.query(
    `SELECT day_type
     FROM employee_work_schedules
     WHERE employee_id = ? AND company_id = ? AND schedule_date = ?
     LIMIT 1`,
    [employeeId, companyId, scheduleDate]
  );
  return rows?.[0]?.day_type ?? null;
}

function earliestEmployeeCloseDateTime(workdayDateIso, dayType) {
  const base = DateTime.fromISO(workdayDateIso, { zone: ZONE }).startOf('day');
  const isHalf = dayType === 'HALF_DAY';
  const hour = isHalf ? 12 : 17;
  return base.set({ hour, minute: 0, second: 0, millisecond: 0 });
}

/**
 * @returns {Promise<{ status: number, error: string } | null>} null if allowed
 */
async function enforceEmployeeManualWorkdayClose({ role, employeeId, companyId, occurredAtDt }) {
  if (role === 'SUPERVISOR' || role === 'ADMIN') return null;

  const workdayDate = toWorkdayDate(occurredAtDt);
  const dayType = await getScheduleDayTypeForDate(employeeId, companyId, workdayDate);
  const earliest = earliestEmployeeCloseDateTime(workdayDate, dayType);

  if (occurredAtDt < earliest) {
    const msg =
      dayType === 'HALF_DAY'
        ? 'Cannot close the workday before 12:00 PM on a half day.'
        : 'Cannot close the workday before 5:00 PM.';
    return { status: 400, error: msg };
  }
  return null;
}

module.exports = {
  enforceEmployeeManualWorkdayClose,
  earliestEmployeeCloseDateTime,
  getScheduleDayTypeForDate
};
