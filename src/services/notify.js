const nodemailer = require('nodemailer');
const env = require('../config/env');

async function sendEmail({ to, subject, text, attachments = [] }) {
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
    await transporter.sendMail({
      from: env.mail.mailFrom,
      to,
      subject,
      text,
      ...(Array.isArray(attachments) && attachments.length > 0 ? { attachments } : {})
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

async function sendFcm({ toToken, title, body }) {
  if (!env.fcm.serverKey) return; // optional feature

  // Lazy require to avoid adding extra deps.
  const https = require('https');
  const data = JSON.stringify({
    to: toToken,
    notification: { title, body }
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
          'Content-Length': Buffer.byteLength(data)
        }
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = { sendEmail, sendFcm };

