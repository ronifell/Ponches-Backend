const mysql = require('mysql2/promise');
const env = require('../config/env');

const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.name,
  connectionLimit: env.db.connLimit,
  // Attendance/punch DATETIME values are stored in Dominican local time.
  // Use a fixed -04:00 offset when reading/writing through mysql2 to avoid
  // a 4-hour UTC shift in API responses/UI.
  timezone: '-04:00'
});

module.exports = { pool };

