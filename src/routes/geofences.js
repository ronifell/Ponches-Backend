const { pool } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

module.exports = function registerGeofenceRoutes(app) {
  app.put('/geofences/:geofenceKey', authRequired, async (req, res) => {
    const { officeId } = req.user;
    const { geofenceKey } = req.params;
    const { latitude, longitude, radiusMeters } = req.body || {};

    const lat = Number(latitude);
    const lng = Number(longitude);
    const radius = Number(radiusMeters);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius)) {
      return res.status(400).json({ error: 'latitude, longitude and radiusMeters must be valid numbers' });
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid latitude/longitude range' });
    }

    if (radius < 10 || radius > 5000) {
      return res.status(400).json({ error: 'radiusMeters must be between 10 and 5000' });
    }

    const [result] = await pool.query(
      `UPDATE geofences
       SET latitude = ?, longitude = ?, radius_meters = ?
       WHERE geofence_key = ? AND office_id = ?`,
      [lat, lng, Math.round(radius), geofenceKey, officeId]
    );

    if (!result?.affectedRows) {
      return res.status(404).json({ error: 'Geofence not found for your office' });
    }

    const [rows] = await pool.query(
      `SELECT geofence_key, latitude, longitude, radius_meters, office_id
       FROM geofences
       WHERE geofence_key = ? AND office_id = ?
       LIMIT 1`,
      [geofenceKey, officeId]
    );
    const g = rows?.[0];
    return res.json({
      ok: true,
      item: {
        geofenceKey: g.geofence_key,
        latitude: g.latitude,
        longitude: g.longitude,
        radiusMeters: g.radius_meters,
        officeId: g.office_id
      }
    });
  });

  app.get('/geofences', authRequired, async (req, res) => {
    const { officeId } = req.user;
    // For MVP, return only the authenticated office geofence.
    const [rows] = await pool.query(
      `SELECT geofence_key, latitude, longitude, radius_meters, office_id
       FROM geofences g
       WHERE g.office_id = ?`,
      [officeId]
    );
    return res.json({
      items: (rows || []).map((g) => ({
        geofenceKey: g.geofence_key,
        latitude: g.latitude,
        longitude: g.longitude,
        radiusMeters: g.radius_meters,
        officeId: g.office_id
      }))
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

