const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');
const { ensureEmployeeRegionColumns } = require('../db/ensureEmployeeRegion');
const { ensureQualityPhotosInspectorDecisionColumn } = require('../db/ensureQualityPhotoInspector');
const { viewerRegionParams } = require('../lib/regionScope');
const { authRequired, requireRole } = require('../middleware/auth');
const { DateTime } = require('luxon');
const { notifyQualityInspectionError } = require('../services/qualityInspectionNotify');
const env = require('../config/env');

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

/** Roll up per-photo inspector decisions into qualities.status / inspector_decision for list filters. */
async function recomputeQualityFromPhotos(qualityId, companyId) {
  const [qrows] = await pool.query(
    'SELECT id FROM qualities WHERE id = ? AND company_id = ? LIMIT 1',
    [qualityId, companyId]
  );
  if (!qrows?.length) return;

  const [photos] = await pool.query(
    `SELECT COALESCE(inspector_decision, 'NONE') AS d FROM quality_photos WHERE quality_id = ?`,
    [qualityId]
  );
  if (!photos?.length) {
    await pool.query(
      `UPDATE qualities SET status = 'PENDING', inspector_decision = 'NONE', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [qualityId, companyId]
    );
    return;
  }

  const decisions = photos.map((p) => String(p.d || 'NONE').toUpperCase());
  const anyError = decisions.some((d) => d === 'ERROR');
  const allOk = decisions.every((d) => d === 'OK');
  const anyFe = decisions.some((d) => d === 'FE');

  let status;
  let inspectorDecision;
  if (anyError) {
    status = 'REJECTED';
    inspectorDecision = 'ERROR';
  } else if (allOk) {
    status = 'APPROVED';
    inspectorDecision = 'OK';
  } else if (anyFe) {
    status = 'IN_REVIEW';
    inspectorDecision = 'FE';
  } else {
    status = 'IN_REVIEW';
    inspectorDecision = 'NONE';
  }

  await pool.query(
    `UPDATE qualities SET status = ?, inspector_decision = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ?`,
    [status, inspectorDecision, qualityId, companyId]
  );
}

function todayWorkdayDate() {
  return DateTime.now().setZone(TZ).toISODate();
}

async function getDashboardSummary(req, res) {
  await ensureEmployeeRegionColumns();
  const companyId = req.user.companyId;
  const workdayDate = todayWorkdayDate();
  const regionFrag = await viewerRegionParams(req.user.employeeId, companyId);

  const empSql = regionFrag.params.length
    ? `SELECT COUNT(*) AS c FROM employees WHERE company_id = ? AND TRIM(COALESCE(region, '')) = ?`
    : `SELECT COUNT(*) AS c FROM employees WHERE company_id = ?`;
  const empParams = regionFrag.params.length ? [companyId, regionFrag.params[0]] : [companyId];
  const [[empRow]] = await pool.query(empSql, empParams);

  const [[gfRow]] = await pool.query(
    `SELECT COUNT(*) AS c FROM geofences g JOIN offices o ON o.id = g.office_id WHERE o.company_id = ?`,
    [companyId]
  );

  const checkInSql = regionFrag.params.length
    ? `SELECT COUNT(DISTINCT a.employee_id) AS c
       FROM attendance_events a
       JOIN employees e ON e.id = a.employee_id
       WHERE a.company_id = ? AND a.workday_date = ? AND a.event_type = 'CHECK_IN'
         AND TRIM(COALESCE(e.region, '')) = ?`
    : `SELECT COUNT(DISTINCT employee_id) AS c
       FROM attendance_events
       WHERE company_id = ? AND workday_date = ? AND event_type = 'CHECK_IN'`;
  const checkInParams = regionFrag.params.length
    ? [companyId, workdayDate, regionFrag.params[0]]
    : [companyId, workdayDate];
  const [[checkInRow]] = await pool.query(checkInSql, checkInParams);

  const lateSql = regionFrag.params.length
    ? `SELECT COUNT(*) AS c
       FROM attendance_events a
       JOIN offices o ON o.id = a.office_id
       JOIN employees e ON e.id = a.employee_id
       WHERE a.company_id = ?
         AND a.workday_date = ?
         AND a.event_type = 'CHECK_IN'
         AND TRIM(COALESCE(e.region, '')) = ?
         AND ADDTIME(o.opening_time, SEC_TO_TIME(o.grace_minutes * 60)) < TIME(a.occurred_at)`
    : `SELECT COUNT(*) AS c
       FROM attendance_events a
       JOIN offices o ON o.id = a.office_id
       WHERE a.company_id = ?
         AND a.workday_date = ?
         AND a.event_type = 'CHECK_IN'
         AND ADDTIME(o.opening_time, SEC_TO_TIME(o.grace_minutes * 60)) < TIME(a.occurred_at)`;
  const lateParams = regionFrag.params.length
    ? [companyId, workdayDate, regionFrag.params[0]]
    : [companyId, workdayDate];
  const [[lateRow]] = await pool.query(lateSql, lateParams);

  return res.json({
    activeEmployees: Number(empRow?.c || 0),
    geofences: Number(gfRow?.c || 0),
    checkInsToday: Number(checkInRow?.c || 0),
    tardinessToday: Number(lateRow?.c || 0),
    workdayDate
  });
}

async function getRecentAttendance(req, res) {
  await ensureEmployeeRegionColumns();
  const companyId = req.user.companyId;
  const limit = Math.min(Number(req.query.limit) || 40, 200);
  const fromDate = firstQueryParam(req.query.fromDate);
  const toDate = firstQueryParam(req.query.toDate);
  const lateOnlyRaw = firstQueryParam(req.query.lateOnly);
  const lateOnly =
    lateOnlyRaw === true ||
    lateOnlyRaw === 'true' ||
    lateOnlyRaw === '1' ||
    String(lateOnlyRaw || '').toLowerCase() === 'true';

  const regionFrag = await viewerRegionParams(req.user.employeeId, companyId);

  const conditions = ['a.company_id = ?'];
  const params = [companyId];

  if (regionFrag.params.length) {
    conditions.push(`TRIM(COALESCE(e.region, '')) = ?`);
    params.push(regionFrag.params[0]);
  }

  if (isIsoDateOnly(fromDate)) {
    conditions.push('a.workday_date >= ?');
    params.push(fromDate);
  }
  if (isIsoDateOnly(toDate)) {
    conditions.push('a.workday_date <= ?');
    params.push(toDate);
  }

  if (lateOnly) {
    conditions.push(`a.event_type = 'CHECK_IN'`);
    conditions.push(
      `ADDTIME(o.opening_time, SEC_TO_TIME(o.grace_minutes * 60)) < TIME(a.occurred_at)`
    );
  }

  const whereSql = conditions.join(' AND ');
  params.push(limit);

  const [rows] = await pool.query(
    `SELECT a.id, a.event_type, a.occurred_at, a.workday_date, a.geofence_key,
            e.full_name, e.employee_code, o.opening_time, o.grace_minutes
     FROM attendance_events a
     JOIN employees e ON e.id = a.employee_id
     JOIN offices o ON o.id = a.office_id
     WHERE ${whereSql}
     ORDER BY a.occurred_at DESC
     LIMIT ?`,
    params
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
  await ensureEmployeeRegionColumns();
  const companyId = req.user.companyId;
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const regionFrag = await viewerRegionParams(req.user.employeeId, companyId);

  const actConditions = ['a.company_id = ?'];
  const actParams = [companyId];
  if (regionFrag.params.length) {
    actConditions.push(`TRIM(COALESCE(e.region, '')) = ?`);
    actParams.push(regionFrag.params[0]);
  }
  actParams.push(limit);

  const [rows] = await pool.query(
    `SELECT a.id, a.event_type, a.occurred_at, a.workday_date, a.manual_close, a.source,
            e.full_name, e.employee_code, o.name AS office_name
     FROM attendance_events a
     JOIN employees e ON e.id = a.employee_id
     JOIN offices o ON o.id = a.office_id
     WHERE ${actConditions.join(' AND ')}
     ORDER BY a.occurred_at DESC
     LIMIT ?`,
    actParams
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

function firstQueryParam(v) {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

function isIsoDateOnly(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isUuidLike(s) {
  return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s.trim());
}

/** Calendar-day bounds in TZ → UTC Date for TIMESTAMP compare (avoids MySQL DATE() TZ drift). */
function zonedDayStartUtc(dateStr) {
  return DateTime.fromISO(String(dateStr), { zone: TZ }).startOf('day').toUTC().toJSDate();
}

function zonedDayEndExclusiveUtc(dateStr) {
  return DateTime.fromISO(String(dateStr), { zone: TZ }).startOf('day').plus({ days: 1 }).toUTC().toJSDate();
}

async function listQualityForAdmin(req, res) {
  await ensureInspectorDecisionColumn();
  await ensureQualityPhotosInspectorDecisionColumn();
  await ensureEmployeeRegionColumns();
  const companyId = req.user.companyId;
  const fromDate = firstQueryParam(req.query.fromDate);
  const toDate = firstQueryParam(req.query.toDate);
  const userIdFilter =
    firstQueryParam(req.query.userId) || firstQueryParam(req.query.employeeId);
  const employeeCodeFilter = String(firstQueryParam(req.query.employeeCode) || '').trim();
  const orderIdFilter = String(firstQueryParam(req.query.orderId) || '').trim();

  const conditions = ['q.company_id = ?'];
  const params = [companyId];

  const qr = await viewerRegionParams(req.user.employeeId, companyId);
  if (qr.params.length) {
    conditions.push(`TRIM(COALESCE(e.region, '')) = ?`);
    params.push(qr.params[0]);
  }

  if (isIsoDateOnly(fromDate)) {
    conditions.push('q.created_at >= ?');
    params.push(zonedDayStartUtc(fromDate));
  }
  if (isIsoDateOnly(toDate)) {
    conditions.push('q.created_at < ?');
    params.push(zonedDayEndExclusiveUtc(toDate));
  }
  if (isUuidLike(userIdFilter)) {
    conditions.push('q.user_id = ?');
    params.push(String(userIdFilter).trim());
  }
  if (employeeCodeFilter) {
    conditions.push('e.employee_code = ?');
    params.push(employeeCodeFilter);
  }
  if (orderIdFilter) {
    conditions.push('q.order_id = ?');
    params.push(orderIdFilter);
  }

  const uiStatus = String(firstQueryParam(req.query.uiStatus) || '')
    .trim()
    .toUpperCase();
  const feExistsSql =
    'EXISTS (SELECT 1 FROM quality_photos qp_fe WHERE qp_fe.quality_id = q.id AND qp_fe.fe = 1)';
  if (uiStatus === 'OK') {
    conditions.push(`(q.status = 'APPROVED' OR q.inspector_decision = 'OK')`);
  } else if (uiStatus === 'ERROR') {
    conditions.push(`(q.status = 'REJECTED' OR q.inspector_decision = 'ERROR')`);
  } else if (uiStatus === 'FE') {
    conditions.push(
      `( (q.inspector_decision = 'FE' OR ${feExistsSql}) AND NOT (q.status = 'APPROVED' OR q.inspector_decision = 'OK') AND NOT (q.status = 'REJECTED' OR q.inspector_decision = 'ERROR') )`
    );
  } else if (uiStatus === 'IN_PROGRESS') {
    conditions.push(
      `( NOT (q.status = 'APPROVED' OR q.inspector_decision = 'OK') AND NOT (q.status = 'REJECTED' OR q.inspector_decision = 'ERROR') AND NOT (q.inspector_decision = 'FE' OR ${feExistsSql}) )`
    );
  }

  const whereSql = conditions.join(' AND ');
  const limit = Math.min(Number(req.query.limit) || 300, 500);

  const [rows] = await pool.query(
    `SELECT q.id, q.user_id, q.order_id, q.work_type, q.stb_count, q.status, q.inspector_decision,
            q.created_at, q.updated_at,
            e.full_name AS technician_name, e.employee_code AS technician_code,
            (SELECT COUNT(*) FROM quality_photos qp WHERE qp.quality_id = q.id) AS photo_count,
            (SELECT MAX(qp.fe) FROM quality_photos qp WHERE qp.quality_id = q.id) AS any_fe
     FROM qualities q
     JOIN employees e ON e.id = q.user_id
     WHERE ${whereSql}
     ORDER BY q.created_at DESC
     LIMIT ?`,
    [...params, limit]
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
    anyFe: Boolean(r.any_fe)
  }));

  return res.json({ items });
}

async function getQualityDetailAdmin(req, res) {
  await ensureInspectorDecisionColumn();
  await ensureQualityPhotosInspectorDecisionColumn();
  await ensureEmployeeRegionColumns();
  const { qualityId } = req.params;
  const companyId = req.user.companyId;

  const [rows] = await pool.query(
    `SELECT q.*, e.full_name AS technician_name, e.employee_code AS technician_code,
            e.region AS technician_region
     FROM qualities q
     JOIN employees e ON e.id = q.user_id
     WHERE q.id = ? AND q.company_id = ?
     LIMIT 1`,
    [qualityId, companyId]
  );
  const q = rows?.[0];
  if (!q) return res.status(404).json({ error: 'Quality not found' });

  const vr = await viewerRegionParams(req.user.employeeId, companyId);
  if (vr.params.length) {
    const tr = String(q.technician_region || '').trim();
    if (tr !== vr.params[0]) return res.status(404).json({ error: 'Quality not found' });
  }

  const [photos] = await pool.query(
    `SELECT id, photo_type, photo_url, fe, fe_comment, COALESCE(inspector_decision, 'NONE') AS inspector_decision, created_at
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
      inspectorDecision: String(p.inspector_decision || 'NONE').toUpperCase(),
      createdAt: p.created_at
    }))
  });
}

async function patchQualityReview(req, res) {
  await ensureInspectorDecisionColumn();
  await ensureQualityPhotosInspectorDecisionColumn();
  await ensureEmployeeRegionColumns();
  const { qualityId } = req.params;
  const { photoId, decision } = req.body || {};
  const companyId = req.user.companyId;

  if (!photoId || typeof photoId !== 'string') {
    return res.status(400).json({ error: 'photoId is required' });
  }
  if (!['FE', 'ERROR', 'OK'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be FE, ERROR, or OK' });
  }

  const [qrows] = await pool.query(
    `SELECT q.id, TRIM(COALESCE(e.region, '')) AS tech_region
     FROM qualities q
     JOIN employees e ON e.id = q.user_id
     WHERE q.id = ? AND q.company_id = ?
     LIMIT 1`,
    [qualityId, companyId]
  );
  if (!qrows?.length) return res.status(404).json({ error: 'Quality not found' });
  const vr = await viewerRegionParams(req.user.employeeId, companyId);
  if (vr.params.length && String(qrows[0].tech_region || '') !== vr.params[0]) {
    return res.status(404).json({ error: 'Quality not found' });
  }

  const [prows] = await pool.query(
    'SELECT id FROM quality_photos WHERE id = ? AND quality_id = ? LIMIT 1',
    [photoId, qualityId]
  );
  if (!prows?.length) return res.status(404).json({ error: 'Photo not found' });

  await pool.query(
    `UPDATE quality_photos SET inspector_decision = ? WHERE id = ? AND quality_id = ?`,
    [decision, photoId, qualityId]
  );

  await recomputeQualityFromPhotos(qualityId, companyId);

  if (decision === 'ERROR') {
    const [qinfo] = await pool.query(
      'SELECT order_id, user_id FROM qualities WHERE id = ? AND company_id = ? LIMIT 1',
      [qualityId, companyId]
    );
    const qi = qinfo?.[0];
    if (qi) {
      notifyQualityInspectionError({
        companyId,
        qualityId,
        technicianId: qi.user_id,
        orderId: qi.order_id
      }).catch((e) => console.warn('Quality inspection error notification failed:', e.message || e));
    }
  }

  const [updated] = await pool.query(
    'SELECT status, inspector_decision FROM qualities WHERE id = ? LIMIT 1',
    [qualityId]
  );
  const row = updated?.[0];
  return res.json({
    ok: true,
    status: row?.status,
    inspectorDecision: row?.inspector_decision || 'NONE',
    photoInspectorDecision: decision
  });
}

/** Resolve `/uploads/...` public URL to absolute path under uploadDir (no traversal). */
function absolutePathForUploadPublicUrl(publicUrl) {
  const u = String(publicUrl || '').trim();
  const parts = u.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length < 2 || parts[0] !== 'uploads') return null;
  const abs = path.resolve(path.join(env.uploads.uploadDir, ...parts.slice(1)));
  const root = path.resolve(env.uploads.uploadDir);
  const safe = abs === root || abs.startsWith(root + path.sep);
  return safe ? abs : null;
}

/** Stream file bytes — `<img>` cannot send Bearer tokens; admin UI fetches this URL with auth. */
async function getQualityPhotoImage(req, res) {
  await ensureQualityPhotosInspectorDecisionColumn();
  await ensureEmployeeRegionColumns();
  const { qualityId, photoId } = req.params;
  const companyId = req.user.companyId;

  const [rows] = await pool.query(
    `SELECT qp.photo_url, TRIM(COALESCE(e.region, '')) AS technician_region
     FROM quality_photos qp
     INNER JOIN qualities q ON q.id = qp.quality_id
     INNER JOIN employees e ON e.id = q.user_id
     WHERE qp.id = ? AND qp.quality_id = ? AND q.company_id = ?
     LIMIT 1`,
    [photoId, qualityId, companyId]
  );
  const row = rows?.[0];
  if (!row) {
    return res.status(404).end();
  }

  const vr = await viewerRegionParams(req.user.employeeId, companyId);
  if (vr.params.length) {
    const tr = String(row.technician_region || '').trim();
    if (tr !== vr.params[0]) {
      return res.status(404).end();
    }
  }

  const abs = absolutePathForUploadPublicUrl(row.photo_url);
  if (!abs || !fs.existsSync(abs)) {
    return res.status(404).end();
  }

  return res.sendFile(abs, (err) => {
    if (err && !res.headersSent) {
      res.status(404).end();
    }
  });
}

module.exports = function registerAdminRoutes(app) {
  const adminOnly = [authRequired, requireRole('ADMIN')];

  app.get('/admin/dashboard/summary', ...adminOnly, getDashboardSummary);
  app.get('/admin/attendance/recent', ...adminOnly, getRecentAttendance);
  app.get('/admin/activity/recent', ...adminOnly, getRecentActivity);
  app.get('/admin/quality/items', ...adminOnly, listQualityForAdmin);
  app.get('/admin/quality/:qualityId/photos/:photoId/image', ...adminOnly, getQualityPhotoImage);
  app.get('/admin/quality/:qualityId', ...adminOnly, getQualityDetailAdmin);
  app.patch('/admin/quality/:qualityId/review', ...adminOnly, patchQualityReview);
};
