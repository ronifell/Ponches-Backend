const { pool } = require('../db/pool');
const { authRequired } = require('../middleware/auth');
const { parseOccuredAt, toWorkdayDate } = require('../utils/timezone');
const { enforceEmployeeManualWorkdayClose } = require('../utils/workdayClosePolicy');
const { notifySuperManagerAttendanceRecord } = require('../services/superManagerAttendanceNotify');
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

  // Supervisors already get the admin-style attendance email via notifySuperManagerAttendanceRecord().
  // So for late-arrival we avoid duplicate supervisor emails:
  // - email only to the employee (if present)
  // - push notifications to employee and supervisors (if they have FCM tokens)
  const emailTargets = employee?.email ? [employee] : [];
  const fcmTargets = [
    ...(employee?.fcm_token ? [employee] : []),
    ...supervisors.filter((s) => s?.fcm_token)
  ];

  await Promise.all([
    ...emailTargets.map(async (t) => sendEmail({ to: t.email, subject, text })),
    ...fcmTargets.map(async (t) =>
      sendFcm({
        toToken: t.fcm_token,
        title: 'Late arrival',
        body: text
      })
    )
  ]);
}

async function handleWorkdayClosedNotifications({ employeeId, officeId, manualClose, occurredAtDt }) {
  if (manualClose) return;
  const supervisors = await getSupervisorsForOffice(officeId);
  const employee = await getEmployeeContacts(employeeId);

  const dateStr = occurredAtDt.toFormat('yyyy-LL-dd');
  const subject = `Workday auto-closed (${dateStr})`;
  const text = `Employee workday was not manually closed by 8:00 PM (auto closure).`;

  // Supervisors already get the admin-style attendance email via notifySuperManagerAttendanceRecord().
  // So for workday-closed we avoid duplicate supervisor emails:
  // - email only to the employee (if present)
  // - push notifications to employee and supervisors (if they have FCM tokens)
  const emailTargets = employee?.email ? [employee] : [];
  const fcmTargets = [
    ...(employee?.fcm_token ? [employee] : []),
    ...supervisors.filter((s) => s?.fcm_token)
  ];

  await Promise.all([
    ...emailTargets.map(async (t) => sendEmail({ to: t.email, subject, text })),
    ...fcmTargets.map(async (t) =>
      sendFcm({
        toToken: t.fcm_token,
        title: 'Workday auto-closed',
        body: subject
      })
    )
  ]);
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

    if (!eventType) {
      return res.status(400).json({ error: 'eventType is required' });
    }
    if (!['CHECK_IN', 'MOVEMENT', 'GEOFENCE_ENTER', 'GEOFENCE_EXIT', 'WORKDAY_CLOSED'].includes(eventType)) {
      return res.status(400).json({ error: 'Invalid eventType' });
    }
    if (!['GEOFENCE', 'MANUAL', 'AUTO'].includes(source)) {
      return res.status(400).json({ error: 'Invalid source' });
    }

    const employeeId = req.user.employeeId;
    const companyId = req.user.companyId;

    const [empRows] = await pool.query(
      'SELECT office_id, geofence_key FROM employees WHERE id = ? LIMIT 1',
      [employeeId]
    );
    const emp = empRows?.[0];
    if (!emp) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    let resolvedOfficeId = emp.office_id;
    if (req.user.role === 'ADMIN') {
      if (!officeId) {
        return res.status(400).json({ error: 'officeId is required' });
      }
      resolvedOfficeId = officeId;
    } else if (officeId && officeId !== emp.office_id) {
      return res.status(400).json({ error: 'officeId must match your assigned office' });
    }

    const resolvedGeofenceKey =
      geofenceKey != null && geofenceKey !== ''
        ? geofenceKey
        : resolvedOfficeId === emp.office_id
          ? emp.geofence_key
          : null;

    const occurredAtDt = parseOccuredAt(occurredAt);
    const workday_date = toWorkdayDate(occurredAtDt);

    if (eventType === 'WORKDAY_CLOSED' && source !== 'AUTO') {
      const deny = await enforceEmployeeManualWorkdayClose({
        role: req.user.role,
        employeeId,
        companyId,
        occurredAtDt
      });
      if (deny) return res.status(deny.status).json({ error: deny.error });
    }

    await pool.query(
      `INSERT INTO attendance_events
      (id, company_id, office_id, employee_id, event_type, manual_close, source, occurred_at, workday_date, geofence_key)
      VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId,
        resolvedOfficeId,
        employeeId,
        eventType,
        manualClose ? 1 : 0,
        source,
        occurredAtDt.toSQL({ includeOffset: false }), // 'yyyy-LL-dd HH:mm:ss'
        workday_date,
        resolvedGeofenceKey
      ]
    );

    const occurredAtFormatted = occurredAtDt.toFormat('yyyy-LL-dd HH:mm');
    notifySuperManagerAttendanceRecord({
      companyId,
      employeeId,
      officeId: resolvedOfficeId,
      eventType,
      source,
      occurredAtFormatted,
      manualClose: Boolean(manualClose),
      geofenceKey: resolvedGeofenceKey
    }).catch((e) => console.warn('Super manager attendance email failed:', e.message || e));

    if (eventType === 'CHECK_IN') {
      // Best effort notifications (don't block API)
      handleCheckInNotifications({ employeeId, officeId: resolvedOfficeId, occurredAtDt }).catch((e) =>
        console.warn('Late arrival notification failed:', e)
      );
    }
    if (eventType === 'WORKDAY_CLOSED') {
      handleWorkdayClosedNotifications({
        employeeId,
        officeId: resolvedOfficeId,
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

