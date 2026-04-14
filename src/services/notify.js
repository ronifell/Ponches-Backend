const nodemailer = require('nodemailer');
const env = require('../config/env');

// Business requirement: always show this sender address in outgoing notifications.
const FORCED_FROM_ADDRESS = 'uasdt@vozsrl.net';
const FORCED_FROM_DISPLAY = `Flupy Time Alerts <${FORCED_FROM_ADDRESS}>`;

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
    const info = await transporter.sendMail({
      // Keep SMTP auth user for login, but force the visible From header.
      from: FORCED_FROM_DISPLAY,
      sender: FORCED_FROM_ADDRESS,
      replyTo: FORCED_FROM_ADDRESS,
      envelope: {
        from: FORCED_FROM_ADDRESS,
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
      forcedFrom: FORCED_FROM_ADDRESS,
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

async function sendFcm({ toToken, title, body }) {
  if (!env.fcm.serverKey) return; // optional feature

  // Lazy require to avoid adding extra deps.
  const https = require('https');
  // Data-only so Android always delivers to onMessageReceived (foreground/background). A `notification`
  // payload is shown by the system with defaults that often hide content on the lock screen.
  const data = JSON.stringify({
    to: toToken,
    priority: 'high',
    data: {
      title: String(title || ''),
      body: String(body || '')
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

