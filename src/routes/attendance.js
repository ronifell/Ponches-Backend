const { pool } = require('../db/pool');
const { authRequired } = require('../middleware/auth');
const { parseOccuredAt, toWorkdayDate } = require('../utils/timezone');
const { enforceEmployeeManualWorkdayClose } = require('../utils/workdayClosePolicy');
const { notifySuperManagerAttendanceRecord } = require('../services/superManagerAttendanceNotify');
const { notifyLateArrivalIfNeeded, notifyWorkdayAutoClosed } = require('../services/attendanceNotify');

async function isWorkdayAlreadyClosed(employeeId, workdayDate) {
  const [rows] = await pool.query(
    `SELECT 1
     FROM attendance_events
     WHERE employee_id = ?
       AND workday_date = ?
       AND event_type IN ('WORKDAY_CLOSED', 'GEOFENCE_EXIT')
     LIMIT 1`,
    [employeeId, workdayDate]
  );
  return Boolean(rows?.length);
}

module.exports = function registerAttendanceRoutes(app) {
  app.post('/attendance', authRequired, async (req, res) => {
    const {
      eventType,
      manualClose = false,
      source = 'GEOFENCE',
      occurredAt,
      officeId,
      geofenceKey = null,
      latitude: latRaw,
      longitude: lngRaw
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

    const latitude = latRaw != null && latRaw !== '' ? Number(latRaw) : null;
    const longitude = lngRaw != null && lngRaw !== '' ? Number(lngRaw) : null;
    if (latitude != null && !Number.isFinite(latitude)) {
      return res.status(400).json({ error: 'Invalid latitude' });
    }
    if (longitude != null && !Number.isFinite(longitude)) {
      return res.status(400).json({ error: 'Invalid longitude' });
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

      const alreadyClosed = await isWorkdayAlreadyClosed(employeeId, workday_date);
      if (alreadyClosed) {
        return res.status(400).json({ error: 'Workday is already closed' });
      }
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
      geofenceKey: resolvedGeofenceKey,
      omitSupervisorsForEmail: eventType === 'WORKDAY_CLOSED' && source === 'AUTO'
    }).catch((e) => console.warn('Super manager attendance email failed:', e.message || e));

    if (eventType === 'CHECK_IN') {
      notifyLateArrivalIfNeeded({
        employeeId,
        officeId: resolvedOfficeId,
        occurredAtDt,
        latitude,
        longitude,
        geofenceKey: resolvedGeofenceKey
      }).catch((e) => console.warn('Late arrival notification failed:', e));
    }
    if (eventType === 'WORKDAY_CLOSED' && source === 'AUTO' && !manualClose) {
      notifyWorkdayAutoClosed({
        employeeId,
        officeId: resolvedOfficeId,
        occurredAtDt
      }).catch((e) => console.warn('Workday auto-close notification failed:', e));
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
