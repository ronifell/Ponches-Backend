const nodemailer = require('nodemailer');
const env = require('../config/env');

function trimEmail(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (m?.[1]) return m[1].trim();
  return s.includes('@') ? s : null;
}

function resolveHeaderFrom(from) {
  const COMPANY_SENDER_FALLBACK = 'suadt@vozsrl.net';
  const raw =
    String(from || '').trim() ||
    COMPANY_SENDER_FALLBACK ||
    String(env.mail.mailFrom || '').trim() ||
    String(env.mail.smtpUser || '').trim();
  const parsed = trimEmail(raw);
  if (!raw && parsed) return parsed;
  if (!raw) return parsed || 'no-reply@example.com';
  return raw;
}

async function sendEmail({ to, subject, text, html = null, attachments = [], from = null }) {
  if (!env.mail.smtpHost || !env.mail.smtpUser || !env.mail.smtpPass) {
    // Avoid crashing if not configured; useful for local dev.
    console.warn('SMTP not configured, skipping email:', { to, subject });
    return;
  }

  const transporter = nodemailer.createTransport({
    host: env.mail.smtpHost,
    port: env.mail.smtpPort,
    secure: env.mail.smtpPort === 465,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 15_000,
    auth: {
      user: env.mail.smtpUser,
      pass: env.mail.smtpPass
    }
  });

  try {
    const headerFrom = resolveHeaderFrom(from);
    const senderEmail =
      trimEmail(headerFrom) ||
      trimEmail(env.mail.smtpUser) ||
      'no-reply@example.com';
    // Keep SMTP envelope tied to authenticated mailbox for better deliverability.
    const envelopeFrom = trimEmail(env.mail.smtpUser) || senderEmail;
    const info = await transporter.sendMail({
      // Keep SMTP auth user for login, while allowing per-company sender when provided.
      from: headerFrom,
      sender: senderEmail,
      replyTo: senderEmail,
      envelope: {
        from: envelopeFrom,
        to: Array.isArray(to) ? to : [to]
      },
      to,
      subject,
      text,
      ...(html ? { html } : {}),
      ...(Array.isArray(attachments) && attachments.length > 0 ? { attachments } : {})
    });
    console.log('[mail] sent', {
      to,
      subject,
      from: headerFrom,
      sender: senderEmail,
      smtpUser: env.mail.smtpUser,
      envelopeFrom: info?.envelope?.from || null,
      messageId: info?.messageId || null
    });
  } catch (e) {
    const hint =
      e.code === 'ESOCKET' || e.code === 'ETIMEDOUT'
        ? ' (unreachable host/port: fix SMTP_HOST, firewall, VPN, or DNS — e.g. corporate DNS may resolve smtp.gmail.com to an internal relay)'
        : '';
    const msg = e.message || String(e);
    throw new Error(`SMTP ${env.mail.smtpHost}:${env.mail.smtpPort} — ${msg}${hint}`);
  }
}

/** Matches `PonchesFirebaseMessagingService` channel so system-tray notifications use the same channel. */
const ANDROID_FCM_CHANNEL_ID = 'ponches_fcm_alerts_v2';

/** Lazily initialized Firebase Admin messaging (HTTP v1). `null` = not configured or init failed. */
let fcmV1Messaging = undefined;

function resolveServiceAccountPath() {
  const p = String(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim();
  if (p) return p;
  return String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
}

function tryGetFcmV1Messaging() {
  if (fcmV1Messaging !== undefined) return fcmV1Messaging;

  const jsonInline = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  const keyPath = resolveServiceAccountPath();
  if (!jsonInline && !keyPath) {
    fcmV1Messaging = null;
    return null;
  }

  try {
    const fs = require('fs');
    const path = require('path');
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      if (jsonInline) {
        admin.initializeApp({ credential: admin.credential.cert(JSON.parse(jsonInline)) });
      } else {
        const resolved = path.isAbsolute(keyPath) ? keyPath : path.join(process.cwd(), keyPath);
        if (!fs.existsSync(resolved)) {
          console.warn(`[fcm] HTTP v1: service account file not found (${resolved}); falling back to legacy key if set`);
          fcmV1Messaging = null;
          return null;
        }
        const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(parsed) });
      }
    }
    fcmV1Messaging = admin.messaging();
  } catch (e) {
    console.warn('[fcm] HTTP v1 init failed:', e.message || e);
    fcmV1Messaging = null;
  }
  return fcmV1Messaging;
}

async function sendFcmLegacy({ toToken, title, body }) {
  const https = require('https');
  const t = String(title || '');
  const b = String(body || '');
  const payload = JSON.stringify({
    to: toToken,
    priority: 'high',
    notification: {
      title: t,
      body: b,
      sound: 'default'
    },
    data: {
      title: t,
      body: b
    },
    android: {
      priority: 'high',
      notification: {
        channel_id: ANDROID_FCM_CHANNEL_ID,
        sound: 'default'
      }
    }
  });

  await new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        hostname: 'fcm.googleapis.com',
        path: '/fcm/send',
        headers: {
          Authorization: `key=${env.fcm.serverKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`FCM legacy HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
            return;
          }
          try {
            const j = JSON.parse(raw);
            if (j.error) {
              reject(new Error(`FCM: ${j.error}`));
              return;
            }
            const fail = Number(j.failure || 0);
            if (fail > 0) {
              const first = Array.isArray(j.results) ? j.results[0] : null;
              const err = first?.error || j.error || raw.slice(0, 300);
              reject(new Error(`FCM delivery failed: ${err}`));
              return;
            }
          } catch (_) {
            /* non-JSON body */
          }
          resolve();
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendFcm({ toToken, title, body }) {
  const token = String(toToken || '').trim();
  if (!token) {
    console.warn('[fcm] missing device token; push skipped');
    return;
  }

  const t = String(title || '');
  const b = String(body || '');
  const messaging = tryGetFcmV1Messaging();
  if (messaging) {
    await messaging.send({
      token,
      notification: { title: t, body: b },
      data: { title: t, body: b },
      android: {
        priority: 'high',
        notification: {
          channelId: ANDROID_FCM_CHANNEL_ID,
          sound: 'default'
        }
      }
    });
    console.log('[fcm] sent (HTTP v1)', { tokenLen: token.length });
    return;
  }

  if (env.fcm.serverKey) {
    await sendFcmLegacy({ toToken: token, title: t, body: b });
    console.log('[fcm] sent (legacy)', { tokenLen: token.length });
    return;
  }

  console.warn(
    '[fcm] push skipped: set FIREBASE_SERVICE_ACCOUNT_PATH, GOOGLE_APPLICATION_CREDENTIALS, or FIREBASE_SERVICE_ACCOUNT_JSON for HTTP v1, or FCM_SERVER_KEY for legacy'
  );
}

module.exports = { sendEmail, sendFcm };

