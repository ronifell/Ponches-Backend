/**
 * Integration check: employee login + admin JWT + PATCH .../review ERROR
 * triggers notifyQualityInspectionError (push + emails). Requires running API (see BASE_URL).
 *
 * Usage (from repo root or backend):
 *   PONCHES_TEST_PASSWORD=... node backend/scripts/test-quality-error-notify-flow.cjs
 *
 * Optional: PONCHES_TEST_EMP_CODE=EMP135  BASE_URL=http://127.0.0.1:3101
 */
const path = require('path');

process.chdir(path.join(__dirname, '..'));

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const env = require('../src/config/env');
const { pool } = require('../src/db/pool');

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const EMP_CODE = process.env.PONCHES_TEST_EMP_CODE || 'EMP135';
const PASSWORD = process.env.PONCHES_TEST_PASSWORD || '';

async function main() {
  if (!PASSWORD) {
    console.error('Set PONCHES_TEST_PASSWORD (employee password) in the environment.');
    process.exit(1);
  }

  const [techRows] = await pool.query(
    `SELECT e.id, e.company_id, e.office_id, e.geofence_key, e.role, e.employee_type,
            e.password_hash, TRIM(COALESCE(e.region, '')) AS region
     FROM employees e WHERE e.employee_code = ? LIMIT 1`,
    [EMP_CODE]
  );
  const tech = techRows?.[0];
  if (!tech) {
    console.error(`No employee with code ${EMP_CODE}`);
    process.exit(1);
  }
  const pwOk = await bcrypt.compare(PASSWORD, tech.password_hash);
  if (!pwOk) {
    console.error('Employee password does not match (invalid credentials).');
    process.exit(1);
  }
  console.log('OK: employee login credentials verified for', EMP_CODE);

  const techRegion = String(tech.region || '').trim();
  // Scoped admins only see qualities in their region (or company-wide if region is empty).
  // Never pick a different-region admin: PATCH returns 404 on region mismatch.
  const [adminRows] = await pool.query(
    `SELECT id, company_id, office_id, geofence_key, role, employee_type, region
     FROM employees
     WHERE company_id = ? AND role = 'ADMIN'
       AND (
         TRIM(COALESCE(region, '')) = ''
         OR TRIM(COALESCE(region, '')) = ?
       )
     ORDER BY CASE WHEN TRIM(COALESCE(region, '')) = '' THEN 0 ELSE 1 END
     LIMIT 1`,
    [tech.company_id, techRegion]
  );
  const admin = adminRows?.[0];
  if (!admin) {
    console.error(
      'No usable ADMIN for this technician: need an ADMIN in the same company with empty region (company-wide) ' +
        `or region matching the technician (${techRegion || '(empty)'}).`
    );
    process.exit(1);
  }
  console.log('Using admin employee id', admin.id, 'for JWT.');

  const adminToken = jwt.sign(
    {
      employeeId: admin.id,
      companyId: admin.company_id,
      officeId: admin.office_id,
      geofenceKey: admin.geofence_key || null,
      role: admin.role,
      employeeType: admin.employee_type || 'CENTRALIZED'
    },
    env.jwt.secret,
    { expiresIn: '15m' }
  );

  const [qrows] = await pool.query(
    `SELECT q.id AS quality_id, q.order_id, qp.id AS photo_id
     FROM qualities q
     JOIN quality_photos qp ON qp.quality_id = q.id
     WHERE q.company_id = ? AND q.user_id = ?
       AND COALESCE(TRIM(qp.photo_url), '') <> ''
     ORDER BY q.updated_at DESC
     LIMIT 1`,
    [tech.company_id, tech.id]
  );
  const row = qrows?.[0];
  if (!row) {
    console.error('No quality row with at least one photo for this employee — create/upload in app first.');
    process.exit(1);
  }
  const { quality_id: qualityId, photo_id: photoId, order_id: orderId } = row;
  console.log('PATCH target qualityId=', qualityId, 'photoId=', photoId, 'orderId=', orderId);

  const url = `${BASE_URL}/admin/quality/${qualityId}/review`;
  const body = JSON.stringify({
    photoId,
    decision: 'ERROR',
    comment: 'Integration test: slot marked ERROR from script.'
  });

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body
  });
  const text = await res.text();
  console.log('PATCH status', res.status, text.slice(0, 500));

  if (!res.ok) {
    console.error('PATCH failed — notifications may not have run.');
    process.exit(1);
  }

  console.log(
    'OK: PATCH succeeded. Check server logs for [quality-inspection-notify], [fcm], [mail]. ' +
      'Actual push/email delivery requires FCM_SERVER_KEY + SMTP + valid emails/fcm_token.'
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end().catch(() => {}));
