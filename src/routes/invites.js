const bcrypt = require('bcrypt');
const { pool } = require('../db/pool');
const { authRequired, requireRole } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');

const INVITE_VALID_HOURS = 72;
const crypto = require('crypto');

function generateSecureToken() {
  return uuidv4();
}

function getInviteBaseUrl(req) {
  if (env.inviteBaseUrl) return env.inviteBaseUrl.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3001';
  return `${proto}://${host}`;
}

/**
 * POST /invites - Admin creates an invite.
 * Body: { employeeCode, fullName, companyId, officeId, role?, email? }
 * Returns: { inviteUrl, token, expiresAt, employeeId }
 */
async function createInvite(req, res) {
  const { employeeCode, fullName, companyId, officeId, role = 'EMPLOYEE', email = null } = req.body || {};

  if (!employeeCode || !fullName || !companyId || !officeId) {
    return res.status(400).json({
      error: 'employeeCode, fullName, companyId, officeId are required'
    });
  }

  if (!['EMPLOYEE', 'SUPERVISOR', 'ADMIN'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  // Ensure requester has access to this company
  if (req.user.companyId && req.user.companyId !== companyId) {
    return res.status(403).json({ error: 'Forbidden: cannot invite to another company' });
  }

  const [existingCode] = await pool.query(
    'SELECT id FROM employees WHERE employee_code = ? LIMIT 1',
    [employeeCode]
  );
  if (existingCode?.length > 0) {
    return res.status(400).json({ error: 'employeeCode already in use' });
  }

  const [officeRows] = await pool.query(
    'SELECT id FROM offices WHERE id = ? AND company_id = ? LIMIT 1',
    [officeId, companyId]
  );
  if (!officeRows?.length) {
    return res.status(400).json({ error: 'Invalid office or company' });
  }

  const employeeId = uuidv4();
  const tempPassword = crypto.randomBytes(24).toString('base64url');
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + INVITE_VALID_HOURS * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO employees (id, employee_code, company_id, office_id, role, full_name, password_hash, email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [employeeId, employeeCode, companyId, officeId, role, fullName, passwordHash, email]
  );

  await pool.query(
    'INSERT INTO employee_invites (token, employee_id, expires_at) VALUES (?, ?, ?)',
    [token, employeeId, expiresAt.toISOString().slice(0, 23)]
  );

  const baseUrl = getInviteBaseUrl(req);
  const inviteUrl = `${baseUrl}/invite/${token}`;

  return res.status(201).json({
    inviteUrl,
    token,
    expiresAt: expiresAt.toISOString(),
    employeeId
  });
}

/**
 * GET /invites/:token - Public. Validate token and return employee info for the setup form.
 */
async function getInviteInfo(req, res) {
  const { token } = req.params;
  const [rows] = await pool.query(
    `SELECT i.token, i.expires_at, i.used_at, e.id AS employee_id, e.employee_code, e.full_name
     FROM employee_invites i
     JOIN employees e ON e.id = i.employee_id
     WHERE i.token = ? LIMIT 1`,
    [token]
  );
  const row = rows?.[0];
  if (!row) {
    return res.status(404).json({ error: 'Invalid or expired invite' });
  }
  if (row.used_at) {
    return res.status(400).json({ error: 'Invite already used' });
  }
  const expiresAt = new Date(row.expires_at);
  if (expiresAt < new Date()) {
    return res.status(400).json({ error: 'Invite expired' });
  }
  return res.json({
    employeeCode: row.employee_code,
    fullName: row.full_name
  });
}

/**
 * POST /invites/:token/complete - Public. User sets password and optional email.
 * Body: { password, email? }
 */
async function completeInvite(req, res) {
  const { token } = req.params;
  const { password, email } = req.body || {};

  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const [rows] = await pool.query(
    `SELECT i.token, i.employee_id, i.used_at, i.expires_at
     FROM employee_invites i
     WHERE i.token = ? LIMIT 1`,
    [token]
  );
  const row = rows?.[0];
  if (!row) {
    return res.status(404).json({ error: 'Invalid or expired invite' });
  }
  if (row.used_at) {
    return res.status(400).json({ error: 'Invite already used' });
  }
  const expiresAt = new Date(row.expires_at);
  if (expiresAt < new Date()) {
    return res.status(400).json({ error: 'Invite expired' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date().toISOString().slice(0, 23);

  await pool.query(
    'UPDATE employees SET password_hash = ?, email = COALESCE(?, email) WHERE id = ?',
    [passwordHash, email || null, row.employee_id]
  );
  await pool.query('UPDATE employee_invites SET used_at = ? WHERE token = ?', [now, token]);

  return res.json({ ok: true, message: 'Setup complete. You can now log in.' });
}

/**
 * GET /invite/:token - Serves HTML page for web-based invite completion.
 */
function invitePage(req, res) {
  const { token } = req.params;
  const baseUrl = getInviteBaseUrl(req);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Complete Setup - Ponches</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; max-width: 400px; margin: 40px auto; padding: 20px; }
    h1 { font-size: 1.25rem; margin-bottom: 8px; }
    p { color: #666; font-size: 0.9rem; margin-bottom: 20px; }
    label { display: block; font-weight: 500; margin-bottom: 4px; font-size: 0.9rem; }
    input { width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; margin-bottom: 16px; }
    button { width: 100%; padding: 12px; background: #1976d2; color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #1565c0; }
    .error { color: #c62828; font-size: 0.9rem; margin-bottom: 12px; }
    .success { color: #2e7d32; font-size: 0.9rem; margin-bottom: 12px; }
  </style>
</head>
<body>
  <h1>Complete your account</h1>
  <p id="info">Loading...</p>
  <div id="form" style="display:none;">
    <form id="setupForm">
      <label for="password">New password (min 6 characters)</label>
      <input type="password" id="password" name="password" required minlength="6" autocomplete="new-password">
      <label for="email">Email (optional)</label>
      <input type="email" id="email" name="email" placeholder="your@email.com" autocomplete="email">
      <button type="submit">Complete setup</button>
    </form>
  </div>
  <p id="result" class="error" style="display:none;"></p>
  <script>
    const token = ${JSON.stringify(token)};
    const baseUrl = ${JSON.stringify(baseUrl)};

    fetch(baseUrl + '/invites/' + token)
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error);
        document.getElementById('info').textContent = 'Set your password for ' + (data.fullName || data.employeeCode) + '.';
        document.getElementById('form').style.display = 'block';
      })
      .catch(err => {
        document.getElementById('info').textContent = err.message || 'Invalid or expired invite.';
      });

    document.getElementById('setupForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const email = document.getElementById('email').value.trim() || null;
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        const r = await fetch(baseUrl + '/invites/' + token + '/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password, email })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Failed');
        document.getElementById('form').style.display = 'none';
        const el = document.getElementById('result');
        el.textContent = 'Setup complete! You can now log in with your employee code and password in the Ponches app.';
        el.className = 'success';
        el.style.display = 'block';
      } catch (err) {
        document.getElementById('result').textContent = err.message || 'Failed. Please try again.';
        document.getElementById('result').className = 'error';
        document.getElementById('result').style.display = 'block';
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;

  res.type('html').send(html);
}

module.exports = function registerInviteRoutes(app) {
  app.post('/invites', authRequired, requireRole('ADMIN', 'SUPERVISOR'), createInvite);
  app.get('/invites/:token', getInviteInfo);
  app.post('/invites/:token/complete', completeInvite);
  app.get('/invite/:token', invitePage);
};
