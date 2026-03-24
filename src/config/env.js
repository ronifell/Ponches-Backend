const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Environment loading priority (highest -> lowest):
// 1) `.env` (what the user configures)
// 2) `env.local` / `backend/env.local`
// 3) example files (fallback only)
const envPathCandidates = [
  // When running commands from the `backend/` folder, process.cwd() is `backend/`
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), 'env.local'),
  path.join(process.cwd(), 'env.example'),

  // When running commands from the repo root, process.cwd() is the repo root
  // IMPORTANT: backend/.env was missing—when run from root, env.example was loaded instead!
  path.join(process.cwd(), 'backend', '.env'),
  path.join(process.cwd(), 'backend', 'env.local'),
  path.join(process.cwd(), 'backend', 'env.example'),

  // Extra safety: old root example
  path.join(process.cwd(), 'env.example') // repo root fallback
];

let loadedEnvPath = null;
for (const p of envPathCandidates) {
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    dotenv.config({ path: p, override: false });
    loadedEnvPath = p;
    break;
  }
}

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

module.exports = {
  port: Number(process.env.PORT || 3001),
  nodeEnv: process.env.NODE_ENV || 'development',

  db: {
    host: must('DB_HOST'),
    port: Number(process.env.DB_PORT || 3306),
    user: must('DB_USER'),
    password: process.env.DB_PASSWORD || '',
    name: must('DB_NAME'),
    connLimit: Number(process.env.DB_CONN_LIMIT || 10)
  },

  jwt: {
    secret: must('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '8h'
  },

  mail: {
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: Number(process.env.SMTP_PORT || 587),
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    mailFrom: process.env.MAIL_FROM || 'Ponches App <no-reply@example.com>'
  },

  fcm: {
    serverKey: process.env.FCM_SERVER_KEY || ''
  },

  uploads: {
    uploadDir: process.env.UPLOAD_DIR || path.join(process.cwd(), 'backend', 'uploads')
  },

  // Base URL for invite links (e.g. https://api.ponches.com). Leave empty to use request Host.
  inviteBaseUrl: process.env.INVITE_BASE_URL || '',

  // For debugging env loading (which file was used)
  _loadedEnvPath: loadedEnvPath
};

