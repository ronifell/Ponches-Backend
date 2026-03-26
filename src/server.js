const { createApp } = require('./app');
const cron = require('node-cron');
const { nowSantoDomingo } = require('./utils/timezone');
const { pool } = require('./db/pool');
const { sendEmail, sendFcm } = require('./services/notify');
const { notifySuperManagerAttendanceRecord } = require('./services/superManagerAttendanceNotify');

async function sendWorkdayAutoClosedEmailAndPush({ employeeId, officeId, occurredAtDt }) {
  // Supervisors already get the admin-style attendance email via notifySuperManagerAttendanceRecord().
  // This function keeps supervisor push notifications (FCM) for auto closure.
  const [supervisors] = await pool.query(
    `SELECT email, fcm_token
     FROM employees
     WHERE office_id = ? AND role = 'SUPERVISOR' AND email IS NOT NULL`,
    [officeId]
  );
  if (!supervisors?.length) return;

  const dateStr = occurredAtDt.toFormat('yyyy-LL-dd');
  const subject = `Workday auto-closed (${dateStr})`;
  const text = `Employee ${employeeId} workday was not manually closed by 8:00 PM (auto closure).`;

  await Promise.all(
    supervisors.map(async (s) => {
      if (s.fcm_token) {
        await sendFcm({
          toToken: s.fcm_token,
          title: 'Workday auto-closed',
          body: text
        });
      }
    })
  );
}

async function workdayAutoClosureJob() {
  const now = nowSantoDomingo();
  if (now.hour < 20) return; // only after 8pm

  const workdayDate = now.toISODate(); // in Santo Domingo zone

  // Find employees that have activity but no WORKDAY_CLOSED yet, and haven't been notified.
  const [rows] = await pool.query(
    `SELECT a.employee_id, a.office_id
     FROM attendance_events a
     WHERE a.workday_date = ?
       AND a.event_type IN ('CHECK_IN', 'MOVEMENT', 'GEOFENCE_ENTER', 'GEOFENCE_EXIT')
       AND NOT EXISTS (
         SELECT 1
         FROM attendance_events b
         WHERE b.employee_id = a.employee_id
           AND b.workday_date = a.workday_date
           AND b.event_type = 'WORKDAY_CLOSED'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM workday_closure_notified w
         WHERE w.employee_id = a.employee_id
           AND w.workday_date = a.workday_date
       )
     GROUP BY a.employee_id, a.office_id`,
    [workdayDate]
  );

  if (!rows?.length) return;

  const occurredAtDt = now.set({ hour: 20, minute: 0, second: 0, millisecond: 0 });

  for (const r of rows) {
    // Insert the closure event and mark as notified to avoid duplicates.
    await pool.query(
      `INSERT INTO attendance_events
       (id, company_id, office_id, employee_id, event_type, manual_close, source, occurred_at, workday_date)
       SELECT UUID(), company_id, ?, ?, 'WORKDAY_CLOSED', 0, 'AUTO', ?, ?
       FROM employees
       WHERE id = ?
       LIMIT 1`,
      [r.office_id, r.employee_id, occurredAtDt.toSQL({ includeOffset: false }), workdayDate, r.employee_id]
    );

    await pool.query(
      `INSERT INTO workday_closure_notified (employee_id, workday_date) VALUES (?, ?)`,
      [r.employee_id, workdayDate]
    );

    const [empCompany] = await pool.query('SELECT company_id FROM employees WHERE id = ? LIMIT 1', [
      r.employee_id
    ]);
    const companyId = empCompany?.[0]?.company_id;
    if (companyId) {
      notifySuperManagerAttendanceRecord({
        companyId,
        employeeId: r.employee_id,
        officeId: r.office_id,
        eventType: 'WORKDAY_CLOSED',
        source: 'AUTO',
        occurredAtFormatted: occurredAtDt.toFormat('yyyy-LL-dd HH:mm'),
        manualClose: false
      }).catch((e) => console.warn('Super manager attendance email failed:', e.message || e));
    }

    // Notify supervisors (best effort).
    sendWorkdayAutoClosedEmailAndPush({
      employeeId: r.employee_id,
      officeId: r.office_id,
      occurredAtDt
    }).catch((e) => console.warn('Auto workday notification failed:', e));
  }
}

async function main() {
  const app = createApp();
  const env = require('./config/env');
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const serverPort = port || app.get('port') || 3001;

  // Debug: show which env file was loaded and SMTP host (helps trace 10.10.7.111 vs smtp.gmail.com)
  console.log(`[env] loaded: ${env._loadedEnvPath || 'none'}`);
  if (env.mail.smtpHost) {
    console.log(`[env] SMTP host: ${env.mail.smtpHost}:${env.mail.smtpPort}`);
  }

  // Bind all IPv4 interfaces so Android Emulator (10.0.2.2 → host) and LAN devices can connect.
  app.listen(serverPort, '0.0.0.0', () => {
    console.log(`Ponches backend listening on http://0.0.0.0:${serverPort}`);
  });

  // Run job every hour; internally exits until 20:00 Santo Domingo time.
  cron.schedule('0 * * * *', () => {
    workdayAutoClosureJob().catch((e) => console.warn('workdayAutoClosureJob failed:', e));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

