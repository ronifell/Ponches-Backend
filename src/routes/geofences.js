const { pool } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

module.exports = function registerGeofenceRoutes(app) {
  app.get('/geofences', authRequired, async (req, res) => {
    const { companyId, officeId } = req.user;
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
};

