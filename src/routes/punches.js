const { pool } = require('../db/pool');
const { authRequired } = require('../middleware/auth');
const { parseOccuredAt, toWorkdayDate } = require('../utils/timezone');
const { enforceEmployeeManualWorkdayClose } = require('../utils/workdayClosePolicy');

function mapPunchToAttendanceEvent(punchType) {
  if (punchType === 'ENTRY') return 'CHECK_IN';
  if (punchType === 'EXIT') return 'WORKDAY_CLOSED';
  return 'MOVEMENT';
}

async function getEmployeeType(employeeId) {
  const [rows] = await pool.query('SELECT employee_type FROM employees WHERE id = ? LIMIT 1', [employeeId]);
  return rows?.[0]?.employee_type || 'CENTRALIZED';
}

async function getOfficeGeofence(officeId) {
  const [rows] = await pool.query(
    `SELECT latitude, longitude, radius_meters
     FROM geofences
     WHERE office_id = ?
     ORDER BY created_at ASC
     LIMIT 1`,
    [officeId]
  );
  return rows?.[0] || null;
}

async function getGeofenceForPunch(officeId, geofenceKey) {
  if (geofenceKey) {
    const [rows] = await pool.query(
      `SELECT latitude, longitude, radius_meters
       FROM geofences
       WHERE geofence_key = ? AND office_id = ?
       LIMIT 1`,
      [geofenceKey, officeId]
    );
    return rows?.[0] || null;
  }
  return getOfficeGeofence(officeId);
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function inferPunchType({ employeeId, workdayDate, employeeType, insideGeofence, endWorkday }) {
  if (endWorkday) return 'EXIT';

  const [rows] = await pool.query(
    `SELECT id
     FROM punches
     WHERE user_id = ? AND workday_date = ?
     ORDER BY occurred_at ASC
     LIMIT 1`,
    [employeeId, workdayDate]
  );
  const hasPunchesToday = Boolean(rows?.length);
  if (hasPunchesToday) return 'MOVEMENT';

  if (employeeType === 'DECENTRALIZED') {
    return insideGeofence ? 'MOVEMENT' : 'ENTRY';
  }
  return insideGeofence ? 'ENTRY' : 'MOVEMENT';
}

module.exports = function registerPunchRoutes(app) {
  app.post('/punches', authRequired, async (req, res) => {
    const employeeId = req.user.employeeId;
    const companyId = req.user.companyId;
    const { latitude, longitude, occurredAt, endWorkday = false } = req.body || {};

    const [empRows] = await pool.query(
      'SELECT office_id, geofence_key FROM employees WHERE id = ? LIMIT 1',
      [employeeId]
    );
    const emp = empRows?.[0];
    if (!emp) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    let officeId = emp.office_id;
    if (req.user.role === 'ADMIN' && req.body?.officeId) {
      officeId = req.body.officeId;
    }

    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'latitude and longitude are required numbers' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid latitude/longitude range' });
    }

    if (req.user.role !== 'ADMIN' && officeId !== emp.office_id) {
      return res.status(403).json({ error: 'Forbidden office' });
    }

    const occurredAtDt = parseOccuredAt(occurredAt);
    const workdayDate = toWorkdayDate(occurredAtDt);

    if (Boolean(endWorkday)) {
      const deny = await enforceEmployeeManualWorkdayClose({
        role: req.user.role,
        employeeId,
        companyId,
        occurredAtDt
      });
      if (deny) return res.status(deny.status).json({ error: deny.error });
    }

    const employeeType = await getEmployeeType(employeeId);
    const geofenceKeyForCircle = officeId === emp.office_id ? emp.geofence_key : null;
    const geofence = await getGeofenceForPunch(officeId, geofenceKeyForCircle);
    const insideGeofence = geofence
      ? distanceMeters(geofence.latitude, geofence.longitude, lat, lng) <= Number(geofence.radius_meters)
      : false;

    const punchType = await inferPunchType({
      employeeId,
      workdayDate,
      employeeType,
      insideGeofence,
      endWorkday: Boolean(endWorkday)
    });

    await pool.query(
      `INSERT INTO punches
      (id, company_id, user_id, punch_type, occurred_at, latitude, longitude, office_id, workday_date)
      VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyId, employeeId, punchType, occurredAtDt.toSQL({ includeOffset: false }), lat, lng, officeId, workdayDate]
    );

    await pool.query(
      `INSERT INTO attendance_events
      (id, company_id, office_id, employee_id, event_type, manual_close, source, occurred_at, workday_date, geofence_key)
      VALUES (UUID(), ?, ?, ?, ?, ?, 'GEOFENCE', ?, ?, NULL)`,
      [
        companyId,
        officeId,
        employeeId,
        mapPunchToAttendanceEvent(punchType),
        punchType === 'EXIT' ? 1 : 0,
        occurredAtDt.toSQL({ includeOffset: false }),
        workdayDate
      ]
    );

    return res.status(201).json({
      ok: true,
      punchType,
      employeeType,
      insideGeofence
    });
  });

  app.get('/punches/:employeeId', authRequired, async (req, res) => {
    const { employeeId } = req.params;
    if (req.user.employeeId !== employeeId && !['SUPERVISOR', 'ADMIN'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const [rows] = await pool.query(
      `SELECT id, punch_type, occurred_at, latitude, longitude, office_id, workday_date
       FROM punches
       WHERE user_id = ?
       ORDER BY occurred_at DESC
       LIMIT 200`,
      [employeeId]
    );
    return res.json({
      items: (rows || []).map((r) => ({
        id: r.id,
        type: r.punch_type,
        dateTime: r.occurred_at,
        latitude: r.latitude,
        longitude: r.longitude,
        officeId: r.office_id,
        workdayDate: r.workday_date
      }))
    });
  });
};
