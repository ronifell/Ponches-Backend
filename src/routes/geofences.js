const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db/pool');
const { authRequired, requireRole } = require('../middleware/auth');

function validateGeoBody(latitude, longitude, radiusMeters) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  const radius = Number(radiusMeters);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius)) {
    return { error: 'latitude, longitude and radiusMeters must be valid numbers' };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { error: 'Invalid latitude/longitude range' };
  }
  if (radius < 10 || radius > 5000) {
    return { error: 'radiusMeters must be between 10 and 5000' };
  }
  return { lat, lng, radius: Math.round(radius) };
}

module.exports = function registerGeofenceRoutes(app) {
  app.put('/geofences/:geofenceKey', authRequired, async (req, res) => {
    const { geofenceKey } = req.params;
    const { latitude, longitude, radiusMeters } = req.body || {};

    const parsed = validateGeoBody(latitude, longitude, radiusMeters);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    const { lat, lng, radius } = parsed;

    const [rows] = await pool.query(
      `SELECT g.office_id, o.company_id
       FROM geofences g
       JOIN offices o ON o.id = g.office_id
       WHERE g.geofence_key = ?
       LIMIT 1`,
      [geofenceKey]
    );
    const row = rows?.[0];
    if (!row) {
      return res.status(404).json({ error: 'Geofence not found' });
    }

    const isAdminOrSupervisor = ['ADMIN', 'SUPERVISOR'].includes(req.user.role);
    if (isAdminOrSupervisor) {
      if (row.company_id !== req.user.companyId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else {
      const [empRows] = await pool.query(
        'SELECT office_id, geofence_key FROM employees WHERE id = ? LIMIT 1',
        [req.user.employeeId]
      );
      const emp = empRows?.[0];
      if (!emp) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (emp.geofence_key) {
        if (geofenceKey !== emp.geofence_key) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      } else if (row.office_id !== emp.office_id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    await pool.query(
      `UPDATE geofences SET latitude = ?, longitude = ?, radius_meters = ? WHERE geofence_key = ?`,
      [lat, lng, radius, geofenceKey]
    );

    const [out] = await pool.query(
      `SELECT g.geofence_key, g.latitude, g.longitude, g.radius_meters, g.office_id, o.name AS office_name
       FROM geofences g
       JOIN offices o ON o.id = g.office_id
       WHERE g.geofence_key = ?
       LIMIT 1`,
      [geofenceKey]
    );
    const g = out?.[0];
    return res.json({
      ok: true,
      item: {
        geofenceKey: g.geofence_key,
        latitude: g.latitude,
        longitude: g.longitude,
        radiusMeters: g.radius_meters,
        officeId: g.office_id,
        officeName: g.office_name
      }
    });
  });

  app.get('/geofences', authRequired, async (req, res) => {
    const isAdminOrSupervisor = ['ADMIN', 'SUPERVISOR'].includes(req.user.role);
    const { officeId, companyId } = req.user;

    const [rows] = await pool.query(
      isAdminOrSupervisor
        ? `SELECT g.geofence_key, g.latitude, g.longitude, g.radius_meters, g.office_id, o.name AS office_name
           FROM geofences g
           JOIN offices o ON o.id = g.office_id
           WHERE o.company_id = ?
           ORDER BY o.name ASC, g.geofence_key ASC`
        : `SELECT g.geofence_key, g.latitude, g.longitude, g.radius_meters, g.office_id, o.name AS office_name
           FROM geofences g
           JOIN offices o ON o.id = g.office_id
           JOIN employees e ON e.id = ?
           WHERE o.company_id = e.company_id
             AND (
               (e.geofence_key IS NOT NULL AND g.geofence_key = e.geofence_key)
               OR (e.geofence_key IS NULL AND g.office_id = e.office_id)
             )
           ORDER BY g.geofence_key ASC`,
      isAdminOrSupervisor ? [companyId] : [req.user.employeeId]
    );

    return res.json({
      items: (rows || []).map((g) => ({
        geofenceKey: g.geofence_key,
        latitude: g.latitude,
        longitude: g.longitude,
        radiusMeters: g.radius_meters,
        officeId: g.office_id,
        officeName: g.office_name
      }))
    });
  });

  /**
   * Creates a new office for the company and its geofence circle.
   * Body: { officeName, geofenceKey?, latitude, longitude, radiusMeters }
   */
  app.post('/geofences', authRequired, requireRole('ADMIN', 'SUPERVISOR'), async (req, res) => {
    const companyId = req.user.companyId;
    const { officeName, geofenceKey, latitude, longitude, radiusMeters } = req.body || {};

    const name = String(officeName || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'officeName is required' });
    }

    const parsed = validateGeoBody(latitude, longitude, radiusMeters);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    const { lat, lng, radius } = parsed;

    let key = geofenceKey != null ? String(geofenceKey).trim() : '';
    if (!key) {
      key = `gf-${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    } else {
      const [dup] = await pool.query('SELECT id FROM geofences WHERE geofence_key = ? LIMIT 1', [key]);
      if (dup?.length) {
        return res.status(400).json({ error: 'geofenceKey already in use' });
      }
    }

    const officeId = uuidv4();
    const geofenceId = uuidv4();

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('INSERT INTO offices (id, company_id, name) VALUES (?, ?, ?)', [officeId, companyId, name]);
      await conn.query(
        'INSERT INTO geofences (id, office_id, geofence_key, latitude, longitude, radius_meters) VALUES (?, ?, ?, ?, ?, ?)',
        [geofenceId, officeId, key, lat, lng, radius]
      );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    return res.status(201).json({
      ok: true,
      item: {
        geofenceKey: key,
        latitude: lat,
        longitude: lng,
        radiusMeters: radius,
        officeId,
        officeName: name
      }
    });
  });

  app.get('/testing/geofence', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Geofence Testing - Ponches</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; max-width: 700px; margin: 32px auto; padding: 0 16px; }
    h1 { margin-bottom: 8px; }
    p { color: #555; margin-top: 0; }
    section { border: 1px solid #ddd; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
    label { display: block; margin: 10px 0 4px; font-weight: 600; }
    input { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 8px; }
    button { margin-top: 12px; padding: 10px 14px; border: none; border-radius: 8px; cursor: pointer; background: #0d6efd; color: #fff; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .ok { color: #0a7a31; }
    .error { color: #b42318; }
    .muted { color: #666; font-size: 0.95rem; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  </style>
</head>
<body>
  <h1>Geofence testing page</h1>
  <p>Login, then update your office geofence coordinates for testing.</p>

  <section>
    <h3>1) Login</h3>
    <form id="loginForm">
      <label for="employeeCode">Employee code</label>
      <input id="employeeCode" required placeholder="EMP001" />
      <label for="password">Password</label>
      <input id="password" type="password" required placeholder="******" />
      <button id="loginBtn" type="submit">Login</button>
    </form>
    <div id="loginStatus" class="muted"></div>
  </section>

  <section>
    <h3>2) Update geofence</h3>
    <form id="geoForm">
      <label for="geofenceKey">Geofence key</label>
      <input id="geofenceKey" required />
      <div class="grid">
        <div>
          <label for="latitude">Latitude</label>
          <input id="latitude" required />
        </div>
        <div>
          <label for="longitude">Longitude</label>
          <input id="longitude" required />
        </div>
      </div>
      <label for="radiusMeters">Radius (meters)</label>
      <input id="radiusMeters" required />
      <button id="saveBtn" type="submit" disabled>Save geofence</button>
    </form>
    <div id="geoStatus" class="muted"></div>
  </section>

  <script>
    let token = null;
    let geofences = [];

    const loginStatus = document.getElementById('loginStatus');
    const geoStatus = document.getElementById('geoStatus');
    const saveBtn = document.getElementById('saveBtn');

    function setStatus(el, msg, kind) {
      el.textContent = msg;
      el.className = kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : 'muted';
    }

    async function fetchGeofences() {
      const r = await fetch('/geofences', {
        headers: { Authorization: 'Bearer ' + token }
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to load geofences');
      geofences = data.items || [];
      if (!geofences.length) {
        setStatus(geoStatus, 'No geofence found for this office.', 'error');
        return;
      }
      const g = geofences[0];
      document.getElementById('geofenceKey').value = g.geofenceKey;
      document.getElementById('latitude').value = g.latitude;
      document.getElementById('longitude').value = g.longitude;
      document.getElementById('radiusMeters').value = g.radiusMeters;
      setStatus(geoStatus, 'Loaded current geofence. You can edit and save.', 'ok');
      saveBtn.disabled = false;
    }

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const employeeCode = document.getElementById('employeeCode').value.trim();
      const password = document.getElementById('password').value;
      const btn = document.getElementById('loginBtn');
      btn.disabled = true;
      setStatus(loginStatus, 'Logging in...', 'muted');
      try {
        const r = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ employeeCode, password })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Login failed');
        token = data.token;
        setStatus(loginStatus, 'Login successful as ' + (data.employee?.fullName || employeeCode), 'ok');
        await fetchGeofences();
      } catch (err) {
        setStatus(loginStatus, err.message || 'Login failed', 'error');
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('geoForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!token) {
        setStatus(geoStatus, 'Please login first.', 'error');
        return;
      }
      const geofenceKey = document.getElementById('geofenceKey').value.trim();
      const latitude = Number(document.getElementById('latitude').value);
      const longitude = Number(document.getElementById('longitude').value);
      const radiusMeters = Number(document.getElementById('radiusMeters').value);
      setStatus(geoStatus, 'Saving geofence...', 'muted');
      try {
        const r = await fetch('/geofences/' + encodeURIComponent(geofenceKey), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token
          },
          body: JSON.stringify({ latitude, longitude, radiusMeters })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Failed to save geofence');
        setStatus(
          geoStatus,
          'Saved. New values: lat=' + data.item.latitude + ', lng=' + data.item.longitude + ', radius=' + data.item.radiusMeters + 'm',
          'ok'
        );
      } catch (err) {
        setStatus(geoStatus, err.message || 'Failed to save geofence', 'error');
      }
    });
  </script>
</body>
</html>`;
    res.type('html').send(html);
  });
};
