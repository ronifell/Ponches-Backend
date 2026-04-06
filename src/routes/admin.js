const { pool } = require('../db/pool');
const { authRequired, requireRole } = require('../middleware/auth');
const { DateTime } = require('luxon');

const TZ = 'America/Santo_Domingo';

let inspectorDecisionColumnEnsured = false;
async function ensureInspectorDecisionColumn() {
  if (inspectorDecisionColumnEnsured) return;
  try {
    await pool.query(
      `ALTER TABLE qualities ADD COLUMN inspector_decision ENUM('NONE','FE','ERROR','OK') NOT NULL DEFAULT 'NONE'`
    );
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
  inspectorDecisionColumnEnsured = true;
}

function todayWorkdayDate() {
  return DateTime.now().setZone(TZ).toISODate();
}

async function getDashboardSummary(req, res) {
  const companyId = req.user.companyId;
  const workdayDate = todayWorkdayDate();

  const [[empRow]] = await pool.query(
    `SELECT COUNT(*) AS c FROM employees WHERE company_id = ?`,
    [companyId]
  );
  const [[gfRow]] = await pool.query(
    `SELECT COUNT(*) AS c FROM geofences g JOIN offices o ON o.id = g.office_id WHERE o.company_id = ?`,
    [companyId]
  );

  const [[checkInRow]] = await pool.query(
    `SELECT COUNT(DISTINCT employee_id) AS c
     FROM attendance_events
     WHERE company_id = ? AND workday_date = ? AND event_type = 'CHECK_IN'`,
    [companyId, workdayDate]
  );

  const [[lateRow]] = await pool.query(
    `SELECT COUNT(*) AS c
     FROM attendance_events a
     JOIN offices o ON o.id = a.office_id
     WHERE a.company_id = ?
       AND a.workday_date = ?
       AND a.event_type = 'CHECK_IN'
       AND ADDTIME(o.opening_time, SEC_TO_TIME(o.grace_minutes * 60)) < TIME(a.occurred_at)`,
    [companyId, workdayDate]
  );

  return res.json({
    activeEmployees: Number(empRow?.c || 0),
    geofences: Number(gfRow?.c || 0),
    checkInsToday: Number(checkInRow?.c || 0),
    tardinessToday: Number(lateRow?.c || 0),
    workdayDate
  });
}

async function getRecentAttendance(req, res) {
  const companyId = req.user.companyId;
  const limit = Math.min(Number(req.query.limit) || 40, 200);

  const [rows] = await pool.query(
    `SELECT a.id, a.event_type, a.occurred_at, a.workday_date, a.geofence_key,
            e.full_name, e.employee_code, o.opening_time, o.grace_minutes
     FROM attendance_events a
     JOIN employees e ON e.id = a.employee_id
     JOIN offices o ON o.id = a.office_id
     WHERE a.company_id = ?
     ORDER BY a.occurred_at DESC
     LIMIT ?`,
    [companyId, limit]
  );

  const items = (rows || []).map((r) => {
    let onTime = true;
    if (r.event_type === 'CHECK_IN' && r.opening_time) {
      const [hh, mm, ss] = String(r.opening_time).split(':').map((x) => Number(x));
      const grace = Number(r.grace_minutes || 0);
      const open = DateTime.fromISO(`${r.workday_date}T${String(hh).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}:${String(ss || 0).padStart(2, '0')}`, {
        zone: TZ
      }).plus({ minutes: grace });
      const at = DateTime.fromJSDate(new Date(r.occurred_at), { zone: 'utc' }).setZone(TZ);
      onTime = at <= open;
    }
    return {
      id: r.id,
      fullName: r.full_name,
      employeeCode: r.employee_code,
      eventType: r.event_type,
      occurredAt: r.occurred_at,
      workdayDate: r.workday_date,
      geofenceKey: r.geofence_key,
      onTime
    };
  });

  return res.json({ items });
}

async function getRecentActivity(req, res) {
  const companyId = req.user.companyId;
  const limit = Math.min(Number(req.query.limit) || 25, 100);

  const [rows] = await pool.query(
    `SELECT a.id, a.event_type, a.occurred_at, a.workday_date, a.manual_close, a.source,
            e.full_name, e.employee_code, o.name AS office_name
     FROM attendance_events a
     JOIN employees e ON e.id = a.employee_id
     JOIN offices o ON o.id = a.office_id
     WHERE a.company_id = ?
     ORDER BY a.occurred_at DESC
     LIMIT ?`,
    [companyId, limit]
  );

  const items = (rows || []).map((r, i) => ({
    id: r.id,
    kind: 'attendance',
    titleKey: 'activityAttendance',
    eventType: r.event_type,
    occurredAt: r.occurred_at,
    workdayDate: r.workday_date,
    employeeName: r.full_name,
    employeeCode: r.employee_code,
    officeName: r.office_name,
    manualClose: Boolean(r.manual_close),
    source: r.source,
    index: i + 1
  }));

  return res.json({ items });
}

async function listQualityForAdmin(req, res) {
  await ensureInspectorDecisionColumn();
  const companyId = req.user.companyId;
  const [rows] = await pool.query(
    `SELECT q.id, q.user_id, q.order_id, q.work_type, q.stb_count, q.status, q.inspector_decision,
            q.created_at, q.updated_at,
            e.full_name AS technician_name, e.employee_code AS technician_code,
            (SELECT COUNT(*) FROM quality_photos qp WHERE qp.quality_id = q.id) AS photo_count,
            (SELECT MAX(qp.fe) FROM quality_photos qp WHERE qp.quality_id = q.id) AS any_fe,
            (SELECT qp.photo_url FROM quality_photos qp WHERE qp.quality_id = q.id ORDER BY qp.created_at ASC LIMIT 1) AS first_photo_url
     FROM qualities q
     JOIN employees e ON e.id = q.user_id
     WHERE q.company_id = ?
     ORDER BY q.created_at DESC
     LIMIT 300`,
    [companyId]
  );

  const items = (rows || []).map((r) => ({
    id: r.id,
    userId: r.user_id,
    orderId: r.order_id,
    workType: r.work_type,
    stbCount: r.stb_count,
    status: r.status,
    inspectorDecision: r.inspector_decision || 'NONE',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    technicianName: r.technician_name,
    technicianCode: r.technician_code,
    photoCount: Number(r.photo_count || 0),
    anyFe: Boolean(r.any_fe),
    firstPhotoUrl: r.first_photo_url || null
  }));

  return res.json({ items });
}

async function getQualityDetailAdmin(req, res) {
  await ensureInspectorDecisionColumn();
  const { qualityId } = req.params;
  const companyId = req.user.companyId;

  const [rows] = await pool.query(
    `SELECT q.*, e.full_name AS technician_name, e.employee_code AS technician_code
     FROM qualities q
     JOIN employees e ON e.id = q.user_id
     WHERE q.id = ? AND q.company_id = ?
     LIMIT 1`,
    [qualityId, companyId]
  );
  const q = rows?.[0];
  if (!q) return res.status(404).json({ error: 'Quality not found' });

  const [photos] = await pool.query(
    `SELECT id, photo_type, photo_url, fe, fe_comment, created_at
     FROM quality_photos
     WHERE quality_id = ?
     ORDER BY created_at ASC`,
    [qualityId]
  );

  return res.json({
    id: q.id,
    userId: q.user_id,
    orderId: q.order_id,
    workType: q.work_type,
    stbCount: q.stb_count,
    status: q.status,
    inspectorDecision: q.inspector_decision || 'NONE',
    createdAt: q.created_at,
    updatedAt: q.updated_at,
    technicianName: q.technician_name,
    technicianCode: q.technician_code,
    photos: (photos || []).map((p) => ({
      id: p.id,
      photoType: p.photo_type,
      photoUrl: p.photo_url,
      fe: Boolean(p.fe),
      feComment: p.fe_comment,
      createdAt: p.created_at
    }))
  });
}

async function patchQualityReview(req, res) {
  await ensureInspectorDecisionColumn();
  const { qualityId } = req.params;
  const { decision } = req.body || {};
  const companyId = req.user.companyId;

  if (!['FE', 'ERROR', 'OK'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be FE, ERROR, or OK' });
  }

  const [rows] = await pool.query(
    'SELECT id, status FROM qualities WHERE id = ? AND company_id = ? LIMIT 1',
    [qualityId, companyId]
  );
  if (!rows?.length) return res.status(404).json({ error: 'Quality not found' });

  let nextStatus = rows[0].status;
  if (decision === 'OK') nextStatus = 'APPROVED';
  else if (decision === 'ERROR') nextStatus = 'REJECTED';
  else if (decision === 'FE') nextStatus = 'IN_REVIEW';

  await pool.query(
    `UPDATE qualities SET inspector_decision = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?`,
    [decision, nextStatus, qualityId, companyId]
  );

  return res.json({ ok: true, status: nextStatus, inspectorDecision: decision });
}

module.exports = function registerAdminRoutes(app) {
  const adminOnly = [authRequired, requireRole('ADMIN')];

  app.get('/admin/dashboard/summary', ...adminOnly, getDashboardSummary);
  app.get('/admin/attendance/recent', ...adminOnly, getRecentAttendance);
  app.get('/admin/activity/recent', ...adminOnly, getRecentActivity);
  app.get('/admin/quality/items', ...adminOnly, listQualityForAdmin);
  app.get('/admin/quality/:qualityId', ...adminOnly, getQualityDetailAdmin);
  app.patch('/admin/quality/:qualityId/review', ...adminOnly, patchQualityReview);
};
