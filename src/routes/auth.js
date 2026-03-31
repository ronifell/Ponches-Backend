const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const env = require('../config/env');
const { sendEmail } = require('../services/notify');

async function ensurePasswordResetTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS password_reset_codes (
      id CHAR(36) PRIMARY KEY,
      employee_id CHAR(36) NOT NULL,
      code_hash VARCHAR(255) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_password_reset_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
      INDEX idx_password_reset_employee (employee_id),
      INDEX idx_password_reset_expires (expires_at)
    ) ENGINE=InnoDB`
  );
}

async function login(req, res) {
  const { employeeCode, password } = req.body || {};
  if (!employeeCode || !password) {
    return res.status(400).json({ error: 'employeeCode and password are required' });
  }

  const [rows] = await pool.query(
    `SELECT e.id, e.employee_code, e.company_id, e.office_id, e.geofence_key, e.role, e.full_name, e.password_hash, e.employee_type, e.supervisor_id, e.is_supervisor, o.name AS office_name
     FROM employees e
     LEFT JOIN offices o ON o.id = e.office_id
     WHERE e.employee_code = ? LIMIT 1`,
    [employeeCode]
  );
  const employee = rows?.[0];
  if (!employee) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, employee.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    {
      employeeId: employee.id,
      companyId: employee.company_id,
      officeId: employee.office_id,
      geofenceKey: employee.geofence_key || null,
      role: employee.role
    },
    env.jwt.secret,
    { expiresIn: env.jwt.expiresIn }
  );

  return res.json({
    token,
    employee: {
      id: employee.id,
      employeeCode: employee.employee_code,
      role: employee.role,
      employeeType: employee.employee_type,
      supervisorId: employee.supervisor_id,
      isSupervisor: Boolean(employee.is_supervisor),
      fullName: employee.full_name,
      officeId: employee.office_id,
      geofenceKey: employee.geofence_key || null,
      officeName: employee.office_name || 'Office',
      companyId: employee.company_id
    }
  });
}

function buildCodeEmail({ code, employeeCode, fullName }) {
  const greetingName = fullName || employeeCode || 'there';
  return {
    subject: 'Ponches password reset verification code',
    text: `Hello ${greetingName},

Use this verification code to reset your password in Ponches App: ${code}

This code expires in 10 minutes.
If you did not request a reset, you can ignore this email.`,
    html: `<p>Hello ${greetingName},</p>
<p>Use this verification code to reset your password in Ponches App:</p>
<p style="font-size: 22px; font-weight: 700; letter-spacing: 3px;">${code}</p>
<p>This code expires in 10 minutes.</p>
<p>If you did not request a reset, you can ignore this email.</p>`
  };
}

async function requestPasswordReset(req, res) {
  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    return res.status(400).json({ error: 'email is required' });
  }

  const [rows] = await pool.query(
    `SELECT id, employee_code, full_name, email
     FROM employees
     WHERE LOWER(email) = ?
     LIMIT 1`,
    [normalizedEmail]
  );
  const employee = rows?.[0];

  // Always return success to avoid account enumeration.
  if (!employee) return res.json({ ok: true });

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await ensurePasswordResetTable();
  await pool.query('DELETE FROM password_reset_codes WHERE employee_id = ?', [employee.id]);
  await pool.query(
    `INSERT INTO password_reset_codes (id, employee_id, code_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), employee.id, codeHash, expiresAt]
  );

  const mail = buildCodeEmail({ code, employeeCode: employee.employee_code, fullName: employee.full_name });
  await sendEmail({
    to: employee.email,
    subject: mail.subject,
    text: mail.text,
    html: mail.html
  });

  return res.json({ ok: true });
}

async function verifyPasswordResetCode(req, res) {
  const { email, code } = req.body || {};
  if (!email || !code) {
    return res.status(400).json({ error: 'email and code are required' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedCode = String(code).trim();
  if (!normalizedEmail || normalizedCode.length !== 6) {
    return res.status(400).json({ error: 'Invalid verification code' });
  }

  await ensurePasswordResetTable();
  const [rows] = await pool.query(
    `SELECT pr.id, pr.code_hash, pr.expires_at, e.email
     FROM password_reset_codes pr
     JOIN employees e ON e.id = pr.employee_id
     WHERE LOWER(e.email) = ?
     ORDER BY pr.created_at DESC
     LIMIT 1`,
    [normalizedEmail]
  );
  const resetRow = rows?.[0];
  if (!resetRow) return res.status(400).json({ error: 'Invalid verification code' });

  const expiresAt = new Date(resetRow.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    return res.status(400).json({ error: 'Verification code expired' });
  }

  const ok = await bcrypt.compare(normalizedCode, resetRow.code_hash);
  if (!ok) return res.status(400).json({ error: 'Invalid verification code' });

  return res.json({ ok: true });
}

async function resetPassword(req, res) {
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: 'email, code and newPassword are required' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedCode = String(code).trim();
  if (!normalizedEmail || normalizedCode.length !== 6) {
    return res.status(400).json({ error: 'Invalid verification code' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  await ensurePasswordResetTable();
  const [rows] = await pool.query(
    `SELECT pr.id, pr.employee_id, pr.code_hash, pr.expires_at
     FROM password_reset_codes pr
     JOIN employees e ON e.id = pr.employee_id
     WHERE LOWER(e.email) = ?
     ORDER BY pr.created_at DESC
     LIMIT 1`,
    [normalizedEmail]
  );
  const resetRow = rows?.[0];
  if (!resetRow) return res.status(400).json({ error: 'Invalid verification code' });

  const expiresAt = new Date(resetRow.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    return res.status(400).json({ error: 'Verification code expired' });
  }

  const ok = await bcrypt.compare(normalizedCode, resetRow.code_hash);
  if (!ok) return res.status(400).json({ error: 'Invalid verification code' });

  const passwordHash = await bcrypt.hash(String(newPassword), 10);
  await pool.query('UPDATE employees SET password_hash = ? WHERE id = ?', [passwordHash, resetRow.employee_id]);
  await pool.query('DELETE FROM password_reset_codes WHERE employee_id = ?', [resetRow.employee_id]);

  return res.json({ ok: true });
}

module.exports = { login, requestPasswordReset, verifyPasswordResetCode, resetPassword };

