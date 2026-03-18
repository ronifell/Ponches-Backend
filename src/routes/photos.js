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

module.exports = function registerPhotoRoutes(app) {
  app.post('/photos', authRequired, upload.single('photo'), async (req, res) => {
    const employeeId = req.user.employeeId;
    const companyId = req.user.companyId;
    const officeId = req.user.officeId;

    const {
      orderNumber,
      workType,
      latitude,
      longitude,
      occurredAt
    } = req.body || {};

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

    const order = await getOrderValidation({ orderNumber: String(orderNumber) });
    let validation_result = 'UNKNOWN';
    let validation_distance_meters = null;

    if (order) {
      validation_distance_meters = Math.round(
        haversineDistanceMeters(order.latitude, order.longitude, lat, lng)
      );
      validation_result = validation_distance_meters <= order.radius_meters ? 'APPROVED' : 'REJECTED';
    }

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
        String(orderNumber),
        String(workType),
        lat,
        lng,
        occurredAtDt.toSQL({ includeOffset: false }),
        validation_result,
        validation_distance_meters,
        publicPath
      ]
    );

    if (validation_result === 'REJECTED') {
      const supervisors = await getSupervisorsForOffice(officeId);
      const subject = `Photo validation failed (${orderNumber})`;
      const text = `A photo for order ${orderNumber} was rejected (distance=${validation_distance_meters ?? 'n/a'}m).`;

      // Notify employee (evidence submission feedback).
      const employee = await getEmployeeContacts(employeeId);
      if (employee && (employee.email || employee.fcm_token)) {
        await Promise.all([
          employee.email ? sendEmail({ to: employee.email, subject, text }) : Promise.resolve(),
          employee.fcm_token ? sendFcm({ toToken: employee.fcm_token, title: 'Photo validation failed', body: text }) : Promise.resolve()
        ]);
      }

      await Promise.all(
        supervisors.map(async (s) => {
          if (s.email) await sendEmail({ to: s.email, subject, text });
          if (s.fcm_token) await sendFcm({ toToken: s.fcm_token, title: 'Photo validation failed', body: text });
        })
      );
    } else if (validation_result === 'APPROVED') {
      // Notify employee on success (optional but aligns with “validation alerts”).
      const employee = await getEmployeeContacts(employeeId);
      if (employee && (employee.email || employee.fcm_token)) {
        const subject = `Photo approved (${orderNumber})`;
        const text = `Your photo for order ${orderNumber} was validated successfully.`;
        await Promise.all([
          employee.email ? sendEmail({ to: employee.email, subject, text }) : Promise.resolve(),
          employee.fcm_token ? sendFcm({ toToken: employee.fcm_token, title: 'Photo approved', body: text }) : Promise.resolve()
        ]);
      }
    } else {
      // Unknown order number (cannot validate). Still notify the employee.
      const employee = await getEmployeeContacts(employeeId);
      if (employee && (employee.email || employee.fcm_token)) {
        const subject = `Photo received (${orderNumber})`;
        const text = `We received your photo for order ${orderNumber}. Validation will be performed when the order details are available.`;
        await Promise.all([
          employee.email ? sendEmail({ to: employee.email, subject, text }) : Promise.resolve(),
          employee.fcm_token ? sendFcm({ toToken: employee.fcm_token, title: 'Photo received', body: text }) : Promise.resolve()
        ]);
      }
    }

    return res.status(201).json({ ok: true, validationResult: validation_result });
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

