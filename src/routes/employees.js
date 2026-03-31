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
    geofenceKey,
    role = 'EMPLOYEE',
    email = null,
    employeeType = 'CENTRALIZED',
    supervisorId = null,
    isSupervisor = false
  } = req.body || {};

  if (!employeeCode || !password || !fullName || !companyId || !geofenceKey) {
    return res.status(400).json({ error: 'employeeCode, password, fullName, companyId, geofenceKey are required' });
  }

  if (!['EMPLOYEE', 'SUPERVISOR', 'INSPECTOR', 'ADMIN'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (req.user.role === 'SUPERVISOR' && role !== 'EMPLOYEE') {
    return res.status(403).json({ error: 'Supervisors can only create EMPLOYEE users' });
  }
  if (!['CENTRALIZED', 'DECENTRALIZED'].includes(employeeType)) {
    return res.status(400).json({ error: 'Invalid employeeType' });
  }
  if (req.user.companyId && req.user.companyId !== companyId) {
    return res.status(403).json({ error: 'Forbidden: cannot create employee in another company' });
  }

  const [gfRows] = await pool.query(
    `SELECT g.office_id
     FROM geofences g
     JOIN offices o ON o.id = g.office_id
     WHERE g.geofence_key = ? AND o.company_id = ?
     LIMIT 1`,
    [geofenceKey, companyId]
  );
  const officeId = gfRows?.[0]?.office_id;
  if (!officeId) {
    return res.status(400).json({ error: 'Invalid geofenceKey for this company' });
  }

  let resolvedSupervisorId = supervisorId;
  if (role === 'EMPLOYEE') {
    if (req.user.role === 'SUPERVISOR') {
      // Employees created by a supervisor are always assigned to that supervisor.
      resolvedSupervisorId = req.user.employeeId;
    }
    if (!resolvedSupervisorId) {
      return res.status(400).json({ error: 'supervisorId is required for EMPLOYEE users' });
    }
    const [supRows] = await pool.query(
      `SELECT id
       FROM employees
       WHERE id = ? AND company_id = ? AND role = 'SUPERVISOR'
       LIMIT 1`,
      [resolvedSupervisorId, companyId]
    );
    if (!supRows?.length) {
      return res.status(400).json({ error: 'Invalid supervisorId for this company' });
    }
  } else {
    resolvedSupervisorId = null;
  }

  const employeeId = uuidv4();
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO employees (id, employee_code, company_id, office_id, geofence_key, role, full_name, password_hash, email, employee_type, supervisor_id, is_supervisor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      employeeId,
      employeeCode,
      companyId,
      officeId,
      geofenceKey,
      role,
      fullName,
      passwordHash,
      email,
      employeeType,
      resolvedSupervisorId,
      isSupervisor ? 1 : 0
    ]
  );

  // `insertId` isn't meaningful for explicit UUIDs; return the generated ID.
  return res.status(201).json({ id: employeeId });
}

async function getEmployee(req, res) {
  const { id } = req.params;
  const [rows] = await pool.query(
    'SELECT id, employee_code, company_id, office_id, geofence_key, role, full_name, email, fcm_token, employee_type, supervisor_id, is_supervisor FROM employees WHERE id = ? LIMIT 1',
    [id]
  );
  const employee = rows?.[0];
  if (!employee) return res.status(404).json({ error: 'Employee not found' });

  const requesterCompanyId = req.user?.companyId;
  if (requesterCompanyId && employee.company_id !== requesterCompanyId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.user?.role === 'SUPERVISOR') {
    const isSelf = req.user.employeeId === employee.id;
    const managesEmployee = employee.supervisor_id === req.user.employeeId;
    if (!isSelf && !managesEmployee) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  } else if (req.user?.role !== 'ADMIN' && req.user?.employeeId !== employee.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Map snake_case -> camelCase
  return res.json({
    id: employee.id,
    employeeCode: employee.employee_code,
    companyId: employee.company_id,
    officeId: employee.office_id,
    geofenceKey: employee.geofence_key,
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
  const { fullName, password, fcmToken, email, officeId, geofenceKey, role, employeeType, supervisorId, isSupervisor } = req.body || {};

  const [rows] = await pool.query(
    'SELECT id, company_id, role, supervisor_id FROM employees WHERE id = ? LIMIT 1',
    [id]
  );
  const existing = rows?.[0];
  if (!existing) return res.status(404).json({ error: 'Employee not found' });

  const isSelf = req.user.employeeId === id;
  const isAdminOrSupervisor = ['ADMIN', 'SUPERVISOR'].includes(req.user.role);

  if (!isSelf) {
    if (!isAdminOrSupervisor) return res.status(403).json({ error: 'Forbidden' });
    if (existing.company_id !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });
    if (req.user.role === 'SUPERVISOR' && existing.supervisor_id !== req.user.employeeId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  // Employees can update only their own profile fields; restrict sensitive changes.
  if (isSelf && ['EMPLOYEE', 'SUPERVISOR'].includes(req.user.role)) {
    if (officeId !== undefined || geofenceKey !== undefined || role !== undefined) {
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
  if (geofenceKey !== undefined && isAdminOrSupervisor) {
    if (geofenceKey === null || geofenceKey === '') {
      updates.push('geofence_key = NULL');
    } else {
      const [gf] = await pool.query(
        `SELECT g.office_id, g.geofence_key FROM geofences g
         JOIN offices o ON o.id = g.office_id
         WHERE g.geofence_key = ? AND o.company_id = ? LIMIT 1`,
        [geofenceKey, req.user.companyId]
      );
      if (!gf?.length) {
        return res.status(400).json({ error: 'Invalid geofenceKey for this company' });
      }
      updates.push('office_id = ?');
      params.push(gf[0].office_id);
      updates.push('geofence_key = ?');
      params.push(geofenceKey);
    }
  } else if (officeId) {
    updates.push('office_id = ?');
    params.push(officeId);
  }
  if (role) {
    if (!['EMPLOYEE', 'SUPERVISOR', 'INSPECTOR', 'ADMIN'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (req.user.role === 'SUPERVISOR' && role !== 'EMPLOYEE') {
      return res.status(403).json({ error: 'Forbidden' });
    }
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
    const nextRole = role || existing.role;
    if (nextRole !== 'EMPLOYEE') {
      return res.status(400).json({ error: 'Only EMPLOYEE users can have supervisorId' });
    }
    if (!supervisorId) {
      return res.status(400).json({ error: 'supervisorId is required for EMPLOYEE users' });
    }
    if (req.user.role === 'SUPERVISOR' && supervisorId !== req.user.employeeId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const [supRows] = await pool.query(
      `SELECT id
       FROM employees
       WHERE id = ? AND company_id = ? AND role = 'SUPERVISOR'
       LIMIT 1`,
      [supervisorId, req.user.companyId]
    );
    if (!supRows?.length) {
      return res.status(400).json({ error: 'Invalid supervisorId for this company' });
    }
    updates.push('supervisor_id = ?');
    params.push(supervisorId);
  } else if (role === 'EMPLOYEE' && !existing.supervisor_id) {
    return res.status(400).json({ error: 'supervisorId is required for EMPLOYEE users' });
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
  app.get('/employees', authRequired, requireRole('ADMIN', 'SUPERVISOR'), async (req, res) => {
    const isAdmin = req.user.role === 'ADMIN';
    const [rows] = isAdmin
      ? await pool.query(
        `SELECT id, employee_code, full_name, role
         FROM employees
         WHERE company_id = ?
         ORDER BY full_name ASC`,
        [req.user.companyId]
      )
      : await pool.query(
        `SELECT id, employee_code, full_name, role
         FROM employees
         WHERE company_id = ?
           AND role = 'EMPLOYEE'
           AND supervisor_id = ?
         ORDER BY full_name ASC`,
        [req.user.companyId, req.user.employeeId]
      );
    return res.json({
      items: (rows || []).map((r) => ({
        id: r.id,
        employeeCode: r.employee_code,
        fullName: r.full_name,
        role: r.role
      }))
    });
  });
  app.get('/employees/:id', authRequired, getEmployee);
  app.put('/employees/:id', authRequired, updateEmployee);
};

