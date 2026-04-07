const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const { pool } = require('../db/pool');
const { ensureQualityPhotosInspectorDecisionColumn } = require('../db/ensureQualityPhotoInspector');
const { authRequired } = require('../middleware/auth');
const { sendEmail, sendFcm } = require('../services/notify');
const {
  clampStbCount,
  allowedPhotoTypes,
  normalizeWorkType
} = require('../config/qualityPhotoCatalog');

/** Multer text fields sometimes arrive quoted or JSON-escaped (same as /photos). */
function normalizeMultipartScalar(v) {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'string') return v;
  let s = v.trim();
  s = s.replace(/\\"/g, '"');
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function destination(req, file, cb) {
    const dest = path.join(env.uploads.uploadDir, 'quality');
    ensureDir(dest);
    cb(null, dest);
  },
  filename: function filename(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

let qualitiesStbColumnEnsured = false;
async function ensureQualitiesStbCountColumn() {
  if (qualitiesStbColumnEnsured) return;
  try {
    await pool.query(
      'ALTER TABLE qualities ADD COLUMN stb_count TINYINT UNSIGNED NOT NULL DEFAULT 1'
    );
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
  qualitiesStbColumnEnsured = true;
}

function requiredPhotoTypesForWorkType(workType, stbCount) {
  const wt = normalizeWorkType(workType);
  const sc = clampStbCount(wt, stbCount);
  const list = allowedPhotoTypes(wt, sc);
  return list.length > 0 ? list : [];
}

function normalizePhotoType(photoType) {
  return String(photoType || 'GENERAL').trim().toUpperCase();
}

function trimEmail(value) {
  if (value == null) return null;
  const t = String(value).trim();
  return t.length ? t : null;
}

/** When the technician completes all required photos: admin emails (same region) + supervisor push only. */
async function notifyQualityOrderComplete({ companyId, qualityId, orderId, uploaderId, workType }) {
  const [feRow] = await pool.query(
    'SELECT MAX(fe) AS any_fe FROM quality_photos WHERE quality_id = ?',
    [qualityId]
  );
  const anyFe = Boolean(Number(feRow?.[0]?.any_fe || 0));

  const [uploaderRows] = await pool.query(
    `SELECT employee_code, full_name, supervisor_id, TRIM(COALESCE(region, '')) AS region
     FROM employees
     WHERE id = ? AND company_id = ?
     LIMIT 1`,
    [uploaderId, companyId]
  );
  const uploader = uploaderRows?.[0];
  const uploaderRegion = String(uploader?.region || '').trim();

  let adminSql = `SELECT email FROM employees WHERE company_id = ? AND role = 'ADMIN' AND email IS NOT NULL`;
  const adminParams = [companyId];
  if (uploaderRegion) {
    adminSql += ` AND TRIM(COALESCE(region, '')) = ?`;
    adminParams.push(uploaderRegion);
  }
  const [adminRows] = await pool.query(adminSql, adminParams);

  let supervisorToken = null;
  if (uploader?.supervisor_id) {
    const [sup] = await pool.query(
      `SELECT fcm_token FROM employees WHERE id = ? AND company_id = ? LIMIT 1`,
      [uploader.supervisor_id, companyId]
    );
    supervisorToken = String(sup?.[0]?.fcm_token || '').trim() || null;
  } else {
    const [sup] = await pool.query(
      `SELECT fcm_token FROM employees WHERE company_id = ? AND role = 'SUPERVISOR' LIMIT 1`,
      [companyId]
    );
    supervisorToken = String(sup?.[0]?.fcm_token || '').trim() || null;
  }

  const [coRows] = await pool.query('SELECT notification_email FROM companies WHERE id = ? LIMIT 1', [companyId]);
  const corpFrom = trimEmail(coRows?.[0]?.notification_email);

  const orderStr = String(orderId);
  const subject = anyFe ? `FE ${orderStr}` : orderStr;
  const uploaderLabel = uploader?.employee_code || uploader?.full_name || uploaderId;
  const body =
    `Orden de calidad completada por el técnico.\n\n` +
    `Técnico: ${uploaderLabel}\n` +
    `Orden: ${orderStr}\n` +
    `Tipo de trabajo: ${workType}\n` +
    `Marcada fuera de estándar (FE): ${anyFe ? 'Sí' : 'No'}\n` +
    `ID calidad: ${qualityId}`;

  const adminEmails = [...new Set((adminRows || []).map((r) => trimEmail(r.email)).filter(Boolean))];

  await Promise.all([
    ...adminEmails.map((to) =>
      sendEmail({
        to,
        subject,
        text: body,
        ...(corpFrom ? { from: corpFrom } : {})
      })
    ),
    ...(supervisorToken
      ? [
          sendFcm({
            toToken: supervisorToken,
            title: 'Orden de calidad completada',
            body: `Orden ${orderStr}`
          })
        ]
      : [])
  ]);
}

module.exports = function registerQualityRoutes(app) {
  app.post('/quality', authRequired, async (req, res) => {
    await ensureQualitiesStbCountColumn();
    const { orderId, workType, status = 'PENDING', stbCount: stbCountRaw } = req.body || {};
    if (!orderId || !workType) return res.status(400).json({ error: 'orderId and workType are required' });
    if (!['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const wt = normalizeWorkType(workType);
    const stbCount = clampStbCount(wt, stbCountRaw);
    const slots = allowedPhotoTypes(wt, stbCount);
    if (slots.length === 0) {
      return res.status(400).json({
        error:
          'Unknown workType for quality photos. Use a catalog code (e.g. DTH_REPAIR) or legacy A.'
      });
    }

    const id = uuidv4();
    await pool.query(
      `INSERT INTO qualities
      (id, company_id, user_id, order_id, work_type, status, stb_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.companyId, req.user.employeeId, String(orderId), wt, status, stbCount]
    );
    return res.status(201).json({ id, ok: true, stbCount, requiredPhotoTypes: slots });
  });

  app.post('/quality/:qualityId/photos', authRequired, upload.single('photo'), async (req, res) => {
    await ensureQualitiesStbCountColumn();
    const { qualityId } = req.params;
    const body = req.body || {};
    const photoTypeRaw = normalizeMultipartScalar(body.photoType ?? body['photo-type']);
    const feRaw = body.fe;
    const feCommentRaw = normalizeMultipartScalar(body.feComment ?? body.fe_comment);
    if (!req.file) return res.status(400).json({ error: 'Missing photo file' });

    const [qualityRows] = await pool.query(
      'SELECT id, company_id, user_id, order_id, work_type, stb_count FROM qualities WHERE id = ? LIMIT 1',
      [qualityId]
    );
    const quality = qualityRows?.[0];
    if (!quality) return res.status(404).json({ error: 'Quality not found' });
    if (quality.company_id !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });

    const feOn =
      feRaw === true ||
      feRaw === 'true' ||
      feRaw === '1' ||
      String(feRaw || '').toLowerCase() === 'true';
    const normalizedComment = String(feCommentRaw || '').trim();
    if (feOn && !normalizedComment) {
      return res.status(400).json({
        error: 'Comment is required when the photo is marked out of standard (FE)'
      });
    }

    const normalizedPhotoType = normalizePhotoType(photoTypeRaw);
    const stbCount = Number(quality.stb_count) || 1;
    const required = requiredPhotoTypesForWorkType(quality.work_type, stbCount);
    if (required.length > 0 && !required.includes(normalizedPhotoType)) {
      return res.status(400).json({
        error: `photoType must be one of: ${required.join(', ')}`,
        requiredPhotoTypes: required
      });
    }

    const photoId = uuidv4();
    const photoUrl = `/uploads/quality/${req.file.filename}`;
    await pool.query(
      `INSERT INTO quality_photos
      (id, quality_id, photo_type, photo_url, fe, fe_comment)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [photoId, qualityId, normalizedPhotoType, photoUrl, feOn ? 1 : 0, normalizedComment || null]
    );

    return res.status(201).json({ id: photoId, photoUrl, ok: true });
  });

  app.post('/quality/:qualityId/complete', authRequired, async (req, res) => {
    await ensureQualitiesStbCountColumn();
    const { qualityId } = req.params;

    const [qualityRows] = await pool.query(
      'SELECT id, company_id, user_id, order_id, work_type, stb_count, status FROM qualities WHERE id = ? LIMIT 1',
      [qualityId]
    );
    const quality = qualityRows?.[0];
    if (!quality) return res.status(404).json({ error: 'Quality not found' });
    if (quality.company_id !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });
    if (String(quality.status || '').toUpperCase() !== 'PENDING') {
      return res.status(400).json({ error: 'Order was already submitted for review' });
    }

    const required = requiredPhotoTypesForWorkType(quality.work_type, Number(quality.stb_count) || 1);
    if (required.length === 0) {
      return res.status(400).json({ error: 'No required photo catalog found for this work type' });
    }

    const [uploadedRows] = await pool.query(
      `SELECT DISTINCT photo_type
       FROM quality_photos
       WHERE quality_id = ?`,
      [qualityId]
    );
    const uploadedSet = new Set((uploadedRows || []).map((r) => String(r.photo_type || '').trim().toUpperCase()));
    const missing = required.filter((slot) => !uploadedSet.has(String(slot).trim().toUpperCase()));
    if (missing.length > 0) {
      return res.status(400).json({
        error: 'Missing required photos before completing the order',
        missingPhotoTypes: missing
      });
    }

    await pool.query(
      `UPDATE qualities
       SET status = 'IN_REVIEW', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [qualityId]
    );

    notifyQualityOrderComplete({
      companyId: req.user.companyId,
      qualityId,
      orderId: quality.order_id,
      uploaderId: quality.user_id,
      workType: quality.work_type
    }).catch((e) => console.warn('Quality complete notification failed:', e.message || e));

    return res.json({ ok: true, status: 'IN_REVIEW' });
  });

  app.get('/quality', authRequired, async (req, res) => {
    await ensureQualitiesStbCountColumn();
    const [rows] = await pool.query(
      `SELECT id, user_id, order_id, work_type, stb_count, status, created_at, updated_at
       FROM qualities
       WHERE company_id = ?
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.user.companyId]
    );
    return res.json({ items: rows || [] });
  });

  app.get('/quality/:qualityId', authRequired, async (req, res) => {
    await ensureQualitiesStbCountColumn();
    await ensureQualityPhotosInspectorDecisionColumn();
    const { qualityId } = req.params;
    const [rows] = await pool.query(
      `SELECT id, user_id, order_id, work_type, stb_count, status, created_at, updated_at
       FROM qualities
       WHERE id = ? AND company_id = ?
       LIMIT 1`,
      [qualityId, req.user.companyId]
    );
    const quality = rows?.[0];
    if (!quality) return res.status(404).json({ error: 'Quality not found' });

    const [photos] = await pool.query(
      `SELECT id, photo_type, photo_url, fe, fe_comment, COALESCE(inspector_decision, 'NONE') AS inspector_decision, created_at
       FROM quality_photos
       WHERE quality_id = ?
       ORDER BY created_at ASC`,
      [qualityId]
    );
    return res.json({
      ...quality,
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
  });
};
