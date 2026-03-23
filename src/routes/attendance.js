const { pool } = require('../db/pool');
const { authRequired } = require('../middleware/auth');
const env = require('../config/env');
const { parseOccuredAt, toWorkdayDate, nowSantoDomingo } = require('../utils/timezone');
const { DateTime } = require('luxon');
const { sendEmail, sendFcm } = require('../services/notify');

async function getSupervisorsForOffice(officeId) {
  const [rows] = await pool.query(
    'SELECT email, fcm_token FROM employees WHERE office_id = ? AND role = ? AND email IS NOT NULL',
    [officeId, 'SUPERVISOR']
  );
  return rows || [];
}

async function getEmployeeContacts(employeeId) {
  const [rows] = await pool.query(
    'SELECT email, fcm_token FROM employees WHERE id = ? LIMIT 1',
    [employeeId]
  );
  return rows?.[0] || null;
}

async function computeLateMinutes({ officeId, occurredAtDt }) {
  const [rows] = await pool.query(
    'SELECT opening_time, grace_minutes FROM offices WHERE id = ? LIMIT 1',
    [officeId]
  );
  const office = rows?.[0];
  if (!office) return null;

  const [hh, mm] = String(office.opening_time).split(':').map((x) => Number(x));
  const openingTime = occurredAtDt.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  const deadline = openingTime.plus({ minutes: Number(office.grace_minutes || 0) });

  if (occurredAtDt <= deadline) return 0;
  // Round to the next whole minute so the notification feels fair.
  const diffMinutes = occurredAtDt.diff(deadline, 'minutes').minutes;
  return Math.ceil(diffMinutes);
}

async function handleCheckInNotifications({ employeeId, officeId, occurredAtDt }) {
  const supervisors = await getSupervisorsForOffice(officeId);
  const lateMinutes = await computeLateMinutes({ officeId, occurredAtDt });
  if (lateMinutes === null || lateMinutes <= 0) return;

  const dateStr = occurredAtDt.toFormat('yyyy-LL-dd');
  const subject = `Late arrival (${dateStr})`;
  const text = `Employee ${employeeId} arrived late by ~${lateMinutes} minutes.`;

  const employee = await getEmployeeContacts(employeeId);

  // Best effort: employee + supervisors
  const targets = [
    ...(employee?.email || employee?.fcm_token ? [employee] : []),
    ...supervisors
  ];

  await Promise.all(
    targets
      .filter((t) => t && (t.email || t.fcm_token))
      .map(async (t) => {
        if (t.email) await sendEmail({ to: t.email, subject, text });
        if (t.fcm_token) {
          await sendFcm({
            toToken: t.fcm_token,
            title: 'Late arrival',
            body: text
          });
        }
      })
  );
}

async function handleWorkdayClosedNotifications({ employeeId, officeId, manualClose, occurredAtDt }) {
  if (manualClose) return;
  const supervisors = await getSupervisorsForOffice(officeId);
  const employee = await getEmployeeContacts(employeeId);

  const dateStr = occurredAtDt.toFormat('yyyy-LL-dd');
  const subject = `Workday auto-closed (${dateStr})`;
  const text = `Employee workday was not manually closed by 8:00 PM (auto closure).`;

  const targets = [
    ...(employee?.email || employee?.fcm_token ? [employee] : []),
    ...supervisors
  ];

  await Promise.all(
    targets
      .filter((t) => t && (t.email || t.fcm_token))
      .map(async (s) => {
        if (s.email) await sendEmail({ to: s.email, subject, text });
        if (s.fcm_token) {
          await sendFcm({ toToken: s.fcm_token, title: 'Workday auto-closed', body: subject });
        }
      })
  );
}

module.exports = function registerAttendanceRoutes(app) {
  app.post('/attendance', authRequired, async (req, res) => {
    const {
      eventType,
      manualClose = false,
      source = 'GEOFENCE',
      occurredAt,
      officeId,
      geofenceKey = null
    } = req.body || {};

    if (!eventType || !officeId) {
      return res.status(400).json({ error: 'eventType and officeId are required' });
    }
    if (!['CHECK_IN', 'MOVEMENT', 'GEOFENCE_ENTER', 'GEOFENCE_EXIT', 'WORKDAY_CLOSED'].includes(eventType)) {
      return res.status(400).json({ error: 'Invalid eventType' });
    }
    if (!['GEOFENCE', 'MANUAL', 'AUTO'].includes(source)) {
      return res.status(400).json({ error: 'Invalid source' });
    }

    // Validate company ownership
    if (req.user.role !== 'ADMIN' && officeId !== req.user.officeId) {
      // For MVP, only allow logging events for the authenticated office.
      // (If you need cross-office employees, relax this rule.)
      return res.status(403).json({ error: 'Forbidden office' });
    }

    const occurredAtDt = parseOccuredAt(occurredAt);
    const workday_date = toWorkdayDate(occurredAtDt);

    const employeeId = req.user.employeeId;
    const companyId = req.user.companyId;

    await pool.query(
      `INSERT INTO attendance_events
      (id, company_id, office_id, employee_id, event_type, manual_close, source, occurred_at, workday_date, geofence_key)
      VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId,
        officeId,
        employeeId,
        eventType,
        manualClose ? 1 : 0,
        source,
        occurredAtDt.toSQL({ includeOffset: false }), // 'yyyy-LL-dd HH:mm:ss'
        workday_date,
        geofenceKey
      ]
    );

    if (eventType === 'CHECK_IN') {
      // Best effort notifications (don't block API)
      handleCheckInNotifications({ employeeId, officeId, occurredAtDt }).catch((e) =>
        console.warn('Late arrival notification failed:', e)
      );
    }
    if (eventType === 'WORKDAY_CLOSED') {
      handleWorkdayClosedNotifications({
        employeeId,
        officeId,
        manualClose: Boolean(manualClose),
        occurredAtDt
      }).catch((e) => console.warn('Workday close notification failed:', e));
    }

    return res.status(201).json({ ok: true });
  });

  app.get('/attendance/:employeeId', authRequired, async (req, res) => {
    const { employeeId } = req.params;

    const requesterId = req.user.employeeId;
    if (requesterId === employeeId) {
      const [rows] = await pool.query(
        `SELECT id, event_type, manual_close, source, occurred_at, workday_date, geofence_key
         FROM attendance_events
         WHERE employee_id = ?
         ORDER BY occurred_at DESC
         LIMIT 200`,
        [employeeId]
      );
      const items = (rows || []).map((r) => ({
        id: r.id,
        eventType: r.event_type,
        manualClose: Boolean(r.manual_close),
        source: r.source,
        occurredAt: r.occurred_at,
        workdayDate: r.workday_date,
        geofenceKey: r.geofence_key
      }));
      return res.json({ items });
    }

    if (!['SUPERVISOR', 'ADMIN'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Supervisor/Admin can view within their company.
    const [empRows] = await pool.query('SELECT company_id FROM employees WHERE id = ? LIMIT 1', [employeeId]);
    const target = empRows?.[0];
    if (!target) return res.status(404).json({ error: 'Employee not found' });
    if (target.company_id !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });

    const [rows] = await pool.query(
      `SELECT a.id, a.event_type, a.manual_close, a.source, a.occurred_at, a.workday_date, a.geofence_key, a.office_id
       FROM attendance_events a
       WHERE a.employee_id = ?
       ORDER BY a.occurred_at DESC
       LIMIT 200`,
      [employeeId]
    );
    const items = (rows || []).map((r) => ({
      id: r.id,
      eventType: r.event_type,
      manualClose: Boolean(r.manual_close),
      source: r.source,
      occurredAt: r.occurred_at,
      workdayDate: r.workday_date,
      geofenceKey: r.geofence_key,
      officeId: r.office_id
    }));
    return res.json({ items });
  });
};

