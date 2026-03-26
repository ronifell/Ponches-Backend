const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const env = require('../config/env');
const { pool } = require('../db/pool');
const { authRequired } = require('../middleware/auth');
const { parseOccuredAt, toWorkdayDate } = require('../utils/timezone');
const { haversineDistanceMeters } = require('../utils/distance');
const { sendEmail, sendFcm } = require('../services/notify');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dest = path.join(env.uploads.uploadDir, 'incoming');
    ensureDir(dest);
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB per photo (adjust as needed)
});

async function getOrderValidation({ orderNumber }) {
  const [rows] = await pool.query(
    'SELECT order_number, latitude, longitude, radius_meters FROM customer_orders WHERE order_number = ? LIMIT 1',
    [orderNumber]
  );
  return rows?.[0] || null;
}

async function getEmployeeContacts(employeeId) {
  const [rows] = await pool.query('SELECT email, fcm_token FROM employees WHERE id = ? LIMIT 1', [employeeId]);
  return rows?.[0] || null;
}

async function getSupervisorsForOffice(officeId) {
  const [rows] = await pool.query(
    'SELECT email, fcm_token FROM employees WHERE office_id = ? AND role = ? AND email IS NOT NULL',
    [officeId, 'SUPERVISOR']
  );
  return rows || [];
}

// Notifications can be duplicated if the mobile app retries the same upload (or submits twice).
// To make notification sending concurrency-safe, we use a DB guard table with a unique key.
let photoNotificationGuardsEnsured = false;
async function ensurePhotoNotificationGuardsTable() {
  if (photoNotificationGuardsEnsured) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS photo_notification_guards (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      company_id CHAR(36) NOT NULL,
      employee_id CHAR(36) NOT NULL,
      order_number VARCHAR(128) NOT NULL,
      work_type VARCHAR(128) NOT NULL,
      validation_result ENUM('APPROVED','REJECTED','UNKNOWN') NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_photo_notification_guard (
        company_id, employee_id, order_number, work_type, validation_result
      )
    ) ENGINE=InnoDB;`
  );
  photoNotificationGuardsEnsured = true;
}

async function tryAcquirePhotoNotificationGuard({
  companyId,
  employeeId,
  orderNumber,
  workType,
  validationResult
}) {
  await ensurePhotoNotificationGuardsTable();
  const [result] = await pool.query(
    `INSERT IGNORE INTO photo_notification_guards
      (company_id, employee_id, order_number, work_type, validation_result)
     VALUES (?, ?, ?, ?, ?)`,
    [companyId, employeeId, orderNumber, String(workType), validationResult]
  );

  // INSERT IGNORE sets affectedRows to 1 when inserted, 0 when duplicate.
  return result?.affectedRows === 1;
}

async function releasePhotoNotificationGuard({
  companyId,
  employeeId,
  orderNumber,
  workType,
  validationResult
}) {
  await ensurePhotoNotificationGuardsTable();
  await pool.query(
    `DELETE FROM photo_notification_guards
     WHERE company_id = ? AND employee_id = ? AND order_number = ? AND work_type = ? AND validation_result = ?`,
    [companyId, employeeId, orderNumber, String(workType), validationResult]
  );
}

module.exports = function registerPhotoRoutes(app) {
  app.post('/photos', authRequired, upload.single('photo'), async (req, res) => {
    try {
      console.log('POST /photos received', req.file ? `(file: ${req.file.originalname || req.file.filename})` : '(no file)');
      const employeeId = req.user.employeeId;
      const companyId = req.user.companyId;
      const officeId = req.user.officeId;

      const {
        orderNumber: rawOrderNumber,
        workType: rawWorkType,
        latitude,
        longitude,
        occurredAt
      } = req.body || {};

      // Android multipart fields can sometimes arrive as JSON-escaped strings like `"001"`.
      // Normalize by unescaping and stripping wrapping quotes.
      const normalizeField = (v) => {
        if (v === null || v === undefined) return v;
        if (typeof v !== 'string') return v;

        let s = v.trim();
        s = s.replace(/\\"/g, '"');

        // Strip wrapping quotes: "001" or '001'
        if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
          s = s.slice(1, -1);
        }
        return s;
      };

      const orderNumber = normalizeField(rawOrderNumber);
      const workType = normalizeField(rawWorkType);

      if (!req.file) return res.status(400).json({ error: 'Missing photo file' });
      if (!orderNumber || !workType || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'orderNumber, workType, latitude, longitude are required' });
      }

      const lat = Number(latitude);
      const lng = Number(longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: 'Invalid latitude/longitude' });
      }

      const occurredAtDt = parseOccuredAt(occurredAt);
      const occurredAtSql = occurredAtDt.toSQL({ includeOffset: false });

      const normalizedOrderNumberStr = String(orderNumber);
      const order = await getOrderValidation({ orderNumber: normalizedOrderNumberStr });

      if (!order) {
        // `photo_uploads.order_number` has a FK to `customer_orders`, so we must reject unknown order numbers.
        return res.status(400).json({ error: `Unknown orderNumber: ${normalizedOrderNumberStr}` });
      }

      // Idempotency / de-dupe:
      // Mobile clients can retry uploads on flaky networks (or the UI can trigger twice).
      // If the same employee uploads the same order/workType with the same occurredAt, treat it as one logical event.
      // This prevents duplicate DB rows and duplicate emails/FCM.
      const [existingUploads] = await pool.query(
        `SELECT id, validation_result, validation_distance_meters, server_path
         FROM photo_uploads
         WHERE employee_id = ?
           AND order_number = ?
           AND work_type = ?
           AND occurred_at = ?
         ORDER BY occurred_at DESC
         LIMIT 1`,
        [employeeId, normalizedOrderNumberStr, String(workType), occurredAtSql]
      );
      const existing = existingUploads?.[0];
      if (existing) {
        // Best effort: remove the newly uploaded temp file since we won't store it.
        try {
          if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        } catch (e) {
          console.warn('Duplicate photo upload: failed to delete temp file:', e?.message || e);
        }

        console.log(
          `Duplicate photo upload ignored: employee=${employeeId} order=${normalizedOrderNumberStr} workType=${workType} occurredAt=${occurredAtSql} ` +
          `existingId=${existing.id} existingValidation=${existing.validation_result}`
        );
        return res.status(200).json({
          ok: true,
          duplicate: true,
          validationResult: existing.validation_result
        });
      }

      let validation_result = 'UNKNOWN';
      let validation_distance_meters = null;

      validation_distance_meters = Math.round(
        haversineDistanceMeters(order.latitude, order.longitude, lat, lng)
      );
      validation_result = validation_distance_meters <= order.radius_meters ? 'APPROVED' : 'REJECTED';

      // Move uploaded file to a stable location
      const dateStr = occurredAtDt.toFormat('yyyy-LL-dd');
      const finalDir = path.join(env.uploads.uploadDir, companyId, employeeId, dateStr);
      ensureDir(finalDir);
      const finalPath = path.join(finalDir, req.file.filename);
      fs.renameSync(req.file.path, finalPath);

      const publicPath = `/uploads/${companyId}/${employeeId}/${dateStr}/${req.file.filename}`;

      await pool.query(
        `INSERT INTO photo_uploads
        (id, company_id, employee_id, order_number, work_type, latitude, longitude, occurred_at, validation_result, validation_distance_meters, server_path)
        VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          companyId,
          employeeId,
          normalizedOrderNumberStr,
          String(workType),
          lat,
          lng,
          occurredAtSql,
          validation_result,
          validation_distance_meters,
          publicPath
        ]
      );

      // Email/FCM must not fail the upload if SMTP or push is unreachable (e.g. ETIMEDOUT to internal relay).
      try {
        if (validation_result === 'REJECTED') {
          const shouldNotify = await tryAcquirePhotoNotificationGuard({
            companyId,
            employeeId,
            orderNumber: normalizedOrderNumberStr,
            workType: String(workType),
            validationResult: validation_result
          });

          if (shouldNotify) {
            try {
              const supervisors = await getSupervisorsForOffice(officeId);
              const subject = `Photo validation failed (${normalizedOrderNumberStr})`;
              const text = `A photo for order ${normalizedOrderNumberStr} was rejected (distance=${validation_distance_meters ?? 'n/a'}m).`;

              const employee = await getEmployeeContacts(employeeId);
              if (employee && (employee.email || employee.fcm_token)) {
                await Promise.all([
                  employee.email ? sendEmail({ to: employee.email, subject, text }) : Promise.resolve(),
                  employee.fcm_token
                    ? sendFcm({ toToken: employee.fcm_token, title: 'Photo validation failed', body: text })
                    : Promise.resolve()
                ]);
              }

              await Promise.all(
                supervisors.map(async (s) => {
                  if (s.email) await sendEmail({ to: s.email, subject, text });
                  if (s.fcm_token) await sendFcm({ toToken: s.fcm_token, title: 'Photo validation failed', body: text });
                })
              );
            } catch (innerErr) {
              await releasePhotoNotificationGuard({
                companyId,
                employeeId,
                orderNumber: normalizedOrderNumberStr,
                workType: String(workType),
                validationResult: validation_result
              }).catch(() => {});
              throw innerErr;
            }
          }
        } else if (validation_result === 'APPROVED') {
          const employee = await getEmployeeContacts(employeeId);
          if (employee && (employee.email || employee.fcm_token)) {
            const shouldNotify = await tryAcquirePhotoNotificationGuard({
              companyId,
              employeeId,
              orderNumber: normalizedOrderNumberStr,
              workType: String(workType),
              validationResult: validation_result
            });

            if (shouldNotify) {
              try {
                const subject = `Photo approved (${normalizedOrderNumberStr})`;
                const text = `Your photo for order ${normalizedOrderNumberStr} was validated successfully.`;
                await Promise.all([
                  employee.email ? sendEmail({ to: employee.email, subject, text }) : Promise.resolve(),
                  employee.fcm_token
                    ? sendFcm({ toToken: employee.fcm_token, title: 'Photo approved', body: text })
                    : Promise.resolve()
                ]);
              } catch (innerErr) {
                await releasePhotoNotificationGuard({
                  companyId,
                  employeeId,
                  orderNumber: normalizedOrderNumberStr,
                  workType: String(workType),
                  validationResult: validation_result
                }).catch(() => {});
                throw innerErr;
              }
            }
          }
        }
      } catch (notifyErr) {
        console.error('Photo upload saved but notification failed:', notifyErr.message || notifyErr);
      }

      console.log(
        `Photo uploaded: employee=${employeeId} order=${normalizedOrderNumberStr} workType=${workType} ` +
        `validation=${validation_result} distance=${validation_distance_meters ?? 'n/a'}m path=${publicPath}`
      );
      return res.status(201).json({ ok: true, validationResult: validation_result });
    } catch (err) {
      console.error('Photo upload failed:', err);
      return res.status(500).json({ error: 'Photo upload failed' });
    }
  });

  app.get('/photos/:employeeId', authRequired, async (req, res) => {
    const { employeeId } = req.params;

    if (req.user.employeeId !== employeeId) {
      if (!['SUPERVISOR', 'ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
      const [empRows] = await pool.query('SELECT company_id FROM employees WHERE id = ? LIMIT 1', [employeeId]);
      const target = empRows?.[0];
      if (!target) return res.status(404).json({ error: 'Employee not found' });
      if (target.company_id !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });
    }

    const [rows] = await pool.query(
      `SELECT id, order_number, work_type, latitude, longitude, occurred_at, validation_result, validation_distance_meters, server_path
       FROM photo_uploads
       WHERE employee_id = ?
       ORDER BY occurred_at DESC
       LIMIT 200`,
      [employeeId]
    );

    return res.json({ items: rows || [] });
  });
};

