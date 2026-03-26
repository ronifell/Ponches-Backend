const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db/pool');
const { authRequired, requireRole } = require('../middleware/auth');

module.exports = function registerScheduleRoutes(app) {
  app.get('/calendar/causes', authRequired, async (req, res) => {
    const [rows] = await pool.query(
      `SELECT id, cause_name, active, created_at
       FROM non_operational_causes
       WHERE company_id = ?
       ORDER BY cause_name ASC`,
      [req.user.companyId]
    );
    return res.json({
      items: (rows || []).map((r) => ({
        id: r.id,
        name: r.cause_name,
        active: Boolean(r.active),
        createdAt: r.created_at
      }))
    });
  });

  app.post('/calendar/causes', authRequired, requireRole('ADMIN', 'SUPERVISOR'), async (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = uuidv4();
    await pool.query(
      'INSERT INTO non_operational_causes (id, company_id, cause_name) VALUES (?, ?, ?)',
      [id, req.user.companyId, String(name)]
    );
    return res.status(201).json({ ok: true, id });
  });

  app.put('/calendar/employees/:employeeId/schedule', authRequired, requireRole('ADMIN', 'SUPERVISOR'), async (req, res) => {
    const { employeeId } = req.params;
    const {
      date,
      dayType = 'WORKDAY',
      nonOperationalCauseId = null,
      notes = null
    } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
    if (!['WORKDAY', 'DAY_OFF', 'HALF_DAY', 'NON_OPERATIONAL'].includes(dayType)) {
      return res.status(400).json({ error: 'Invalid dayType' });
    }

    const [empRows] = await pool.query('SELECT company_id FROM employees WHERE id = ? LIMIT 1', [employeeId]);
    const employee = empRows?.[0];
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    if (employee.company_id !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });

    const [existingRows] = await pool.query(
      `SELECT id
       FROM employee_work_schedules
       WHERE employee_id = ? AND schedule_date = ?
       LIMIT 1`,
      [employeeId, date]
    );

    const existing = existingRows?.[0];
    if (existing) {
      await pool.query(
        `UPDATE employee_work_schedules
         SET day_type = ?, non_operational_cause_id = ?, notes = ?, created_by = ?
         WHERE id = ?`,
        [dayType, nonOperationalCauseId, notes, req.user.employeeId, existing.id]
      );
      return res.json({ ok: true, id: existing.id });
    }

    const id = uuidv4();
    await pool.query(
      `INSERT INTO employee_work_schedules
      (id, company_id, employee_id, schedule_date, day_type, non_operational_cause_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.companyId, employeeId, date, dayType, nonOperationalCauseId, notes, req.user.employeeId]
    );
    return res.status(201).json({ ok: true, id });
  });

  app.get('/calendar/employees/:employeeId/schedule', authRequired, async (req, res) => {
    const { employeeId } = req.params;
    const { from, to } = req.query || {};
    if (!from || !to) return res.status(400).json({ error: 'from and to query params are required' });

    if (
      req.user.employeeId !== employeeId &&
      !['ADMIN', 'SUPERVISOR'].includes(req.user.role)
    ) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const [rows] = await pool.query(
      `SELECT s.id, s.schedule_date, s.day_type, s.notes, c.id AS cause_id, c.cause_name
       FROM employee_work_schedules s
       LEFT JOIN non_operational_causes c ON c.id = s.non_operational_cause_id
       WHERE s.employee_id = ?
         AND s.company_id = ?
         AND s.schedule_date BETWEEN ? AND ?
       ORDER BY s.schedule_date ASC`,
      [employeeId, req.user.companyId, from, to]
    );

    return res.json({
      items: (rows || []).map((r) => ({
        id: r.id,
        date: r.schedule_date,
        dayType: r.day_type,
        notes: r.notes,
        causeId: r.cause_id,
        causeName: r.cause_name
      }))
    });
  });
};
