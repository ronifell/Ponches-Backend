const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const { pool } = require('../db/pool');
const { authRequired } = require('../middleware/auth');
const { sendEmail, sendFcm } = require('../services/notify');

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

const REQUIRED_PHOTO_TYPES_BY_WORK_TYPE = {
  A: ['BEFORE', 'DURING', 'AFTER']
};

function requiredPhotoTypesForWorkType(workType) {
  return REQUIRED_PHOTO_TYPES_BY_WORK_TYPE[String(workType || '').trim().toUpperCase()] || [];
}

function normalizePhotoType(photoType) {
  return String(photoType || 'GENERAL').trim().toUpperCase();
}

async function notifyQualityUpload({ companyId, uploaderId, qualityId, orderId, workType, photoType, fe }) {
  const [uploaderRows] = await pool.query(
    `SELECT employee_code, full_name, supervisor_id
     FROM employees
     WHERE id = ? AND company_id = ?
     LIMIT 1`,
    [uploaderId, companyId]
  );
  const uploader = uploaderRows?.[0];

  const [adminRows] = await pool.query(
    `SELECT email, fcm_token
     FROM employees
     WHERE company_id = ? AND role = 'ADMIN'`,
    [companyId]
  );

  let supervisorRows = [];
  if (uploader?.supervisor_id) {
    const [rows] = await pool.query(
      `SELECT email, fcm_token
       FROM employees
       WHERE id = ? AND company_id = ?
       LIMIT 1`,
      [uploader.supervisor_id, companyId]
    );
    supervisorRows = rows || [];
  } else {
    const [rows] = await pool.query(
      `SELECT email, fcm_token
       FROM employees
       WHERE company_id = ? AND role = 'SUPERVISOR'`,
      [companyId]
    );
    supervisorRows = rows || [];
  }

  const targets = [...(adminRows || []), ...supervisorRows];
  const seenEmails = new Set();
  const seenTokens = new Set();
  const emailTargets = [];
  const pushTargets = [];

  for (const t of targets) {
    const email = String(t?.email || '').trim().toLowerCase();
    if (email && !seenEmails.has(email)) {
      seenEmails.add(email);
      emailTargets.push(email);
    }
    const token = String(t?.fcm_token || '').trim();
    if (token && !seenTokens.has(token)) {
      seenTokens.add(token);
      pushTargets.push(token);
    }
  }

  if (emailTargets.length === 0 && pushTargets.length === 0) return;

  const uploaderLabel = uploader?.employee_code || uploader?.full_name || uploaderId;
  const subject = `Quality upload completed · Order ${orderId}`;
  const body =
    `A quality photo upload was completed.\n\n` +
    `Uploader: ${uploaderLabel}\n` +
    `Order: ${orderId}\n` +
    `Work Type: ${workType}\n` +
    `Photo Type: ${photoType}\n` +
    `FE: ${fe ? 'Yes' : 'No'}\n` +
    `Quality ID: ${qualityId}`;

  await Promise.all([
    ...emailTargets.map((to) => sendEmail({ to, subject, text: body })),
    ...pushTargets.map((toToken) =>
      sendFcm({
        toToken,
        title: 'Quality upload completed',
        body: `Order ${orderId} · ${workType} · ${photoType}`
      })
    )
  ]);
}

module.exports = function registerQualityRoutes(app) {
  app.post('/quality', authRequired, async (req, res) => {
    const { orderId, workType, status = 'PENDING' } = req.body || {};
    if (!orderId || !workType) return res.status(400).json({ error: 'orderId and workType are required' });
    if (!['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const id = uuidv4();
    await pool.query(
      `INSERT INTO qualities
      (id, company_id, user_id, order_id, work_type, status)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.user.companyId, req.user.employeeId, String(orderId), String(workType), status]
    );
    return res.status(201).json({ id, ok: true });
  });

  app.post('/quality/:qualityId/photos', authRequired, upload.single('photo'), async (req, res) => {
    const { qualityId } = req.params;
    const { photoType = 'GENERAL', fe = false, feComment = null } = req.body || {};
    if (!req.file) return res.status(400).json({ error: 'Missing photo file' });

    const [qualityRows] = await pool.query(
      'SELECT id, company_id, user_id, order_id, work_type FROM qualities WHERE id = ? LIMIT 1',
      [qualityId]
    );
    const quality = qualityRows?.[0];
    if (!quality) return res.status(404).json({ error: 'Quality not found' });
    if (quality.company_id !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });

    const feOn = fe === true || fe === 'true';
    const normalizedComment = String(feComment || '').trim();
    if (feOn && !normalizedComment) {
      return res.status(400).json({ error: 'feComment is required when FE is true' });
    }

    const normalizedPhotoType = normalizePhotoType(photoType);
    const required = requiredPhotoTypesForWorkType(quality.work_type);
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

    // Best effort: notifications must not fail the upload API response.
    notifyQualityUpload({
      companyId: req.user.companyId,
      uploaderId: req.user.employeeId,
      qualityId,
      orderId: quality.order_id,
      workType: quality.work_type,
      photoType: normalizedPhotoType,
      fe: feOn
    }).catch((e) => console.warn('Quality upload notification failed:', e.message || e));

    return res.status(201).json({ id: photoId, photoUrl, ok: true });
  });

  app.get('/quality', authRequired, async (req, res) => {
    const [rows] = await pool.query(
      `SELECT id, user_id, order_id, work_type, status, created_at, updated_at
       FROM qualities
       WHERE company_id = ?
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.user.companyId]
    );
    return res.json({ items: rows || [] });
  });

  app.get('/quality/:qualityId', authRequired, async (req, res) => {
    const { qualityId } = req.params;
    const [rows] = await pool.query(
      `SELECT id, user_id, order_id, work_type, status, created_at, updated_at
       FROM qualities
       WHERE id = ? AND company_id = ?
       LIMIT 1`,
      [qualityId, req.user.companyId]
    );
    const quality = rows?.[0];
    if (!quality) return res.status(404).json({ error: 'Quality not found' });

    const [photos] = await pool.query(
      `SELECT id, photo_type, photo_url, fe, fe_comment, created_at
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
        createdAt: p.created_at
      }))
    });
  });
};
