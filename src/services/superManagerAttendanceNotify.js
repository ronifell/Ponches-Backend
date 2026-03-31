const { pool } = require('../db/pool');
const env = require('../config/env');
const { sendEmail } = require('./notify');

function extractEmailAddress(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  // Common patterns:
  // - "Company Name" <company@example.com>
  // - company@example.com
  const angleMatch = s.match(/<([^>]+)>/);
  if (angleMatch?.[1]) return angleMatch[1].trim();
  if (s.includes('@')) return s;
  return null;
}

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

  // For workday auto-closure alerts (employee didn't manually close by 8pm),
  // also email the company notification address stored on `companies.notification_email`.
  // Fallback: if the DB column is empty, try extracting an address from `MAIL_FROM` for backwards compatibility.
  const shouldSendCompanyCopy = eventType === 'WORKDAY_CLOSED' && !manualClose && source === 'AUTO';
  let companyEmail = null;
  if (shouldSendCompanyCopy) {
    const [companyRows] = await pool.query(
      'SELECT notification_email FROM companies WHERE id = ? LIMIT 1',
      [companyId]
    );
    companyEmail = trimEmail(companyRows?.[0]?.notification_email);
    if (!companyEmail) {
      companyEmail = extractEmailAddress(env.mail.mailFrom) || extractEmailAddress(env.mail.smtpUser);
    }
  }

  const emailTargets = recipients.filter((r) => r.id !== employeeId);
  if (shouldSendCompanyCopy && companyEmail) {
    const companyEmailNorm = companyEmail.trim().toLowerCase();
    const existsAlready = emailTargets.some((r) => String(r.email || '').trim().toLowerCase() === companyEmailNorm);
    if (!existsAlready) {
      emailTargets.push({ id: '__company__', email: companyEmailNorm, full_name: 'Company' });
    }
  } else if (shouldSendCompanyCopy && !companyEmail) {
    console.warn('Company email not configured; skipping company copy for auto-closure.');
  }

  await Promise.all(
    emailTargets.map((r) => sendEmail({ to: r.email, subject, text }))
  );
}

module.exports = { notifySuperManagerAttendanceRecord };
