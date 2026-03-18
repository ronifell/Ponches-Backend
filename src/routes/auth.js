const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');
const env = require('../config/env');

async function login(req, res) {
  const { employeeCode, password } = req.body || {};
  if (!employeeCode || !password) {
    return res.status(400).json({ error: 'employeeCode and password are required' });
  }

  const [rows] = await pool.query(
    'SELECT id, employee_code, company_id, office_id, role, full_name, password_hash FROM employees WHERE employee_code = ? LIMIT 1',
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
      fullName: employee.full_name,
      officeId: employee.office_id,
      companyId: employee.company_id
    }
  });
}

module.exports = { login };

