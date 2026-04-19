const { pool } = require('../db/pool');

/**
 * Supervisors should only receive notifications for direct reports (`employees.supervisor_id`),
 * not every supervisor in the same office/geofence.
 *
 * @returns {Promise<Array<{ email: string|null, fcm_token: string|null }>>} 0 or 1 row(s).
 */
async function getAssignedSupervisorContacts(employeeId) {
  const [rows] = await pool.query(
    `SELECT sup.email, sup.fcm_token
     FROM employees e
     INNER JOIN employees sup ON sup.id = e.supervisor_id AND sup.company_id = e.company_id
     WHERE e.id = ?
       AND sup.role = 'SUPERVISOR'
     LIMIT 1`,
    [employeeId]
  );
  const row = rows?.[0];
  if (!row) return [];
  return [row];
}

module.exports = { getAssignedSupervisorContacts };
