const bcrypt = require('bcrypt');
const { pool } = require('../db/pool');
const { authRequired, requireRole } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

async function createEmployee(req, res) {
  const {
    employeeCode,
    password,
    fullName,
    companyId,
    officeId,
    role = 'EMPLOYEE',
    email = null,
    employeeType = 'CENTRALIZED',
    supervisorId = null,
    isSupervisor = false
  } = req.body || {};

  if (!employeeCode || !password || !fullName || !companyId || !officeId) {
    return res.status(400).json({ error: 'employeeCode, password, fullName, companyId, officeId are required' });
  }

  if (!['EMPLOYEE', 'SUPERVISOR', 'ADMIN'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (!['CENTRALIZED', 'DECENTRALIZED'].includes(employeeType)) {
    return res.status(400).json({ error: 'Invalid employeeType' });
  }

  const employeeId = uuidv4();
  const passwordHash = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    'INSERT INTO employees (id, employee_code, company_id, office_id, role, full_name, password_hash, email, employee_type, supervisor_id, is_supervisor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [employeeId, employeeCode, companyId, officeId, role, fullName, passwordHash, email, employeeType, supervisorId, isSupervisor ? 1 : 0]
  );

  // `insertId` isn't meaningful for explicit UUIDs; return the generated ID.
  return res.status(201).json({ id: employeeId });
}

async function getEmployee(req, res) {
  const { id } = req.params;
  const [rows] = await pool.query(
    'SELECT id, employee_code, company_id, office_id, role, full_name, email, fcm_token, employee_type, supervisor_id, is_supervisor FROM employees WHERE id = ? LIMIT 1',
    [id]
  );
  const employee = rows?.[0];
  if (!employee) return res.status(404).json({ error: 'Employee not found' });

  const requesterCompanyId = req.user?.companyId;
  if (req.user?.role !== 'ADMIN' && requesterCompanyId && employee.company_id !== requesterCompanyId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Map snake_case -> camelCase
  return res.json({
    id: employee.id,
    employeeCode: employee.employee_code,
    companyId: employee.company_id,
    officeId: employee.office_id,
    role: employee.role,
    employeeType: employee.employee_type,
    supervisorId: employee.supervisor_id,
    isSupervisor: Boolean(employee.is_supervisor),
    fullName: employee.full_name,
    email: employee.email,
    fcmToken: employee.fcm_token
  });
}

async function updateEmployee(req, res) {
  const { id } = req.params;
  const { fullName, password, fcmToken, email, officeId, role, employeeType, supervisorId, isSupervisor } = req.body || {};

  const [rows] = await pool.query('SELECT id, company_id FROM employees WHERE id = ? LIMIT 1', [id]);
  const existing = rows?.[0];
  if (!existing) return res.status(404).json({ error: 'Employee not found' });

  const isSelf = req.user.employeeId === id;
  const isAdminOrSupervisor = ['ADMIN', 'SUPERVISOR'].includes(req.user.role);

  if (!isSelf) {
    if (!isAdminOrSupervisor) return res.status(403).json({ error: 'Forbidden' });
    if (existing.company_id !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });
  }

  // Employees can update only their own profile fields; restrict sensitive changes.
  if (isSelf && req.user.role === 'EMPLOYEE') {
    if (officeId !== undefined || role !== undefined) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  const updates = [];
  const params = [];

  if (fullName) {
    updates.push('full_name = ?');
    params.push(fullName);
  }
  if (email !== undefined) {
    updates.push('email = ?');
    params.push(email);
  }
  if (fcmToken !== undefined) {
    updates.push('fcm_token = ?');
    params.push(fcmToken);
  }
  if (officeId) {
    updates.push('office_id = ?');
    params.push(officeId);
  }
  if (role) {
    if (!['EMPLOYEE', 'SUPERVISOR', 'ADMIN'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    updates.push('role = ?');
    params.push(role);
  }
  if (employeeType) {
    if (!['CENTRALIZED', 'DECENTRALIZED'].includes(employeeType)) {
      return res.status(400).json({ error: 'Invalid employeeType' });
    }
    updates.push('employee_type = ?');
    params.push(employeeType);
  }
  if (supervisorId !== undefined) {
    updates.push('supervisor_id = ?');
    params.push(supervisorId);
  }
  if (isSupervisor !== undefined) {
    updates.push('is_supervisor = ?');
    params.push(isSupervisor ? 1 : 0);
  }
  if (password) {
    updates.push('password_hash = ?');
    params.push(await bcrypt.hash(password, 10));
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  params.push(id);
  await pool.query(`UPDATE employees SET ${updates.join(', ')} WHERE id = ?`, params);
  return res.json({ ok: true });
}

module.exports = function registerEmployeeRoutes(app) {
  app.post('/employees', authRequired, requireRole('ADMIN', 'SUPERVISOR'), createEmployee);
  app.get('/employees/:id', authRequired, getEmployee);
  app.put('/employees/:id', authRequired, updateEmployee);
};

