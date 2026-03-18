const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('./pool');

const DEFAULT_EMPLOYEE_CODE = process.env.SEED_EMPLOYEE_CODE || 'EMP001';
const DEFAULT_PASSWORD = process.env.SEED_EMPLOYEE_PASSWORD || '123456';

async function seedOnce() {
  const conn = await pool.getConnection();
  try {
    // If we already have data, don't re-seed.
    const [existing] = await conn.query('SELECT COUNT(*) AS c FROM companies;');
    if (existing?.[0]?.c > 0) {
      console.log('Seed skipped: companies already exist.');
      return;
    }

    const companyId = uuidv4();
    const officeId = uuidv4();
    const geofenceId = uuidv4();

    await conn.query(
      'INSERT INTO companies (id, name) VALUES (?, ?)',
      [companyId, 'Demo Company']
    );

    await conn.query(
      'INSERT INTO offices (id, company_id, name, opening_time, grace_minutes) VALUES (?, ?, ?, ?, ?)',
      [officeId, companyId, 'Main Office', '09:00:00', 15]
    );

    await conn.query(
      'INSERT INTO geofences (id, office_id, geofence_key, latitude, longitude, radius_meters) VALUES (?, ?, ?, ?, ?, ?)',
      [geofenceId, officeId, 'office-demo', 18.4861, -69.9312, 200]
    );

    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

    const supervisorId = uuidv4();
    const employeeId = uuidv4();

    await conn.query(
      'INSERT INTO employees (id, employee_code, company_id, office_id, role, full_name, password_hash, email, fcm_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        supervisorId,
        'SUP001',
        companyId,
        officeId,
        'SUPERVISOR',
        'Demo Supervisor',
        await bcrypt.hash('sup123456', 10),
        'supervisor@example.com',
        null
      ]
    );

    await conn.query(
      'INSERT INTO employees (id, employee_code, company_id, office_id, role, full_name, password_hash, email, fcm_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        employeeId,
        DEFAULT_EMPLOYEE_CODE,
        companyId,
        officeId,
        'EMPLOYEE',
        'Demo Employee',
        passwordHash,
        'employee@example.com',
        null
      ]
    );

    await conn.query(
      'INSERT INTO customer_orders (order_number, company_id, latitude, longitude, radius_meters) VALUES (?, ?, ?, ?, ?)',
      ['ORD001', companyId, 18.4861, -69.9312, 150]
    );

    console.log('Seed completed.');
  } finally {
    conn.release();
  }
}

seedOnce()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

