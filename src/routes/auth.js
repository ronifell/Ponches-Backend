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
    `SELECT e.id, e.employee_code, e.company_id, e.office_id, e.role, e.full_name, e.password_hash, e.employee_type, e.supervisor_id, e.is_supervisor, o.name AS office_name
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
      officeName: employee.office_name || 'Office',
      companyId: employee.company_id
    }
  });
}

module.exports = { login };

