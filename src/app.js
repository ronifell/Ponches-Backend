const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const env = require('./config/env');

const { login } = require('./routes/auth');
const registerEmployeeRoutes = require('./routes/employees');
const registerAttendanceRoutes = require('./routes/attendance');
const registerPhotoRoutes = require('./routes/photos');
const registerGeofenceRoutes = require('./routes/geofences');
const registerOrderRoutes = require('./routes/orders');
const registerInviteRoutes = require('./routes/invites');
const registerPunchRoutes = require('./routes/punches');
const registerQualityRoutes = require('./routes/quality');
const registerScheduleRoutes = require('./routes/schedule');

function createApp() {
  const app = express();

  app.use(cors());
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl || req.url}`);
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  // Serve uploaded images so the Android client can render them.
  fs.mkdirSync(env.uploads.uploadDir, { recursive: true });
  app.use('/uploads', express.static(env.uploads.uploadDir));

  app.post('/auth/login', login);

  registerEmployeeRoutes(app);
  registerAttendanceRoutes(app);
  registerPhotoRoutes(app);
  registerGeofenceRoutes(app);
  registerOrderRoutes(app);
  registerInviteRoutes(app);
  registerPunchRoutes(app);
  registerQualityRoutes(app);
  registerScheduleRoutes(app);

  app.get('/health', (req, res) => res.json({ ok: true }));

  // Basic error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };

