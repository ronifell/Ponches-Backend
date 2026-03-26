const { pool } = require('../db/pool');
const env = require('../config/env');
const { sendEmail } = require('./notify');

function trimEmail(value) {
  if (value == null) return null;
  const t = String(value).trim();
  return t.length ? t : null;
}

/**
 * Recipients for attendance alerts:
 * - company ADMINs with a profile email (updated via PUT /employees)
 * - office SUPERVISORs with an email (office-scoped, same email field as admin)
 * If there are no ADMINs with email, fall back to SUPER_MANAGER_EMPLOYEE_CODE.
 */
async function resolveAttendanceNotifyRecipients(companyId, officeId) {
  const [adminRows] = await pool.query(
    `SELECT id, email, full_name FROM employees WHERE company_id = ? AND role = 'ADMIN'`,
    [companyId]
  );
  const adminWithEmail = (adminRows || [])
    .map((r) => ({ ...r, email: trimEmail(r.email) }))
    .filter((r) => r.email);

  let adminOrFallbackRecipients = [];
  if (adminWithEmail.length) {
    adminOrFallbackRecipients = adminWithEmail;
  } else {
    const code = env.superManagerEmployeeCode;
    const [mgrRows] = await pool.query(
      `SELECT id, email, full_name FROM employees WHERE company_id = ? AND employee_code = ? LIMIT 1`,
      [companyId, code]
    );
    const mgr = mgrRows?.[0];
    const email = trimEmail(mgr?.email);
    if (!email) {
      console.warn(
        `No ADMIN with email and no fallback super manager (${code}) email; skipping attendance notification`
      );
      adminOrFallbackRecipients = [];
    } else {
      adminOrFallbackRecipients = [{ id: mgr.id, email, full_name: mgr.full_name }];
    }
  }

  // Office-scoped supervisor emails (these should also receive the same admin-style attendance email).
  const supervisorRecipients = officeId
    ? (
        await pool.query(
          `SELECT id, email, full_name
           FROM employees
           WHERE office_id = ? AND role = 'SUPERVISOR' AND email IS NOT NULL`,
          [officeId]
        )
      )[0]
        .map((r) => ({ ...r, email: trimEmail(r.email) }))
        .filter((r) => r.email)
    : [];

  // De-dup recipients by employee id.
  const uniq = new Map();
  for (const r of [...adminOrFallbackRecipients, ...supervisorRecipients]) {
    uniq.set(r.id, r);
  }

  return Array.from(uniq.values());
}

/**
 * Email company administrator(s) whenever an attendance row is created.
 * Uses the current `employees.email` from the DB (same field edited on the profile page).
 */
async function notifySuperManagerAttendanceRecord({
  companyId,
  employeeId,
  officeId,
  eventType,
  source,
  occurredAtFormatted,
  manualClose = false,
  geofenceKey = null
}) {
  const recipients = await resolveAttendanceNotifyRecipients(companyId, officeId);
  if (!recipients.length) return;

  const [actorRows] = await pool.query(
    `SELECT employee_code, full_name FROM employees WHERE id = ? LIMIT 1`,
    [employeeId]
  );
  const actor = actorRows?.[0];
  const who = actor ? `${actor.employee_code} (${actor.full_name})` : String(employeeId);

  const subject = `Attendance: ${eventType} — ${who}`;
  const lines = [
    'A new attendance record was added.',
    '',
    `Employee: ${who}`,
    `Event: ${eventType}`,
    `Source: ${source}`,
    `Time: ${occurredAtFormatted}`,
    `Office ID: ${officeId}`,
    `Manual close: ${manualClose ? 'yes' : 'no'}`
  ];
  if (geofenceKey) lines.push(`Geofence: ${geofenceKey}`);
  const text = lines.join('\n');

  await Promise.all(
    recipients
      .filter((r) => r.id !== employeeId)
      .map((r) => sendEmail({ to: r.email, subject, text }))
  );
}

module.exports = { notifySuperManagerAttendanceRecord };
