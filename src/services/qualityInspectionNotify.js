const { pool } = require('../db/pool');
const { sendEmail, sendFcm } = require('./notify');

function offerEmail(map, raw) {
  const o = String(raw || '').trim();
  if (!o || !o.includes('@')) return;
  const k = o.toLowerCase();
  if (!map.has(k)) map.set(k, o);
}

function offerToken(set, raw) {
  const t = String(raw || '').trim();
  if (t) set.add(t);
}

/**
 * Admin marked one or more quality photos as ERROR — notify technician, assigned supervisor, and all admins (email + FCM).
 */
async function notifyQualityInspectionError({ companyId, qualityId, technicianId, orderId }) {
  const [errPhotos] = await pool.query(
    `SELECT photo_type FROM quality_photos
     WHERE quality_id = ? AND inspector_decision = 'ERROR'
     ORDER BY photo_type`,
    [qualityId]
  );
  const names = (errPhotos || []).map((p) => String(p.photo_type || '').trim()).filter(Boolean);
  if (names.length === 0) return;

  const [techRows] = await pool.query(
    `SELECT email, fcm_token, full_name, employee_code, supervisor_id
     FROM employees WHERE id = ? AND company_id = ? LIMIT 1`,
    [technicianId, companyId]
  );
  const t = techRows?.[0];

  const [adminRows] = await pool.query(
    `SELECT email, fcm_token FROM employees WHERE company_id = ? AND role = 'ADMIN'`,
    [companyId]
  );

  let supEmail = null;
  let supToken = null;
  if (t?.supervisor_id) {
    const [s] = await pool.query(
      `SELECT email, fcm_token FROM employees WHERE id = ? AND company_id = ? AND role = 'SUPERVISOR' LIMIT 1`,
      [t.supervisor_id, companyId]
    );
    supEmail = String(s?.[0]?.email || '').trim() || null;
    supToken = String(s?.[0]?.fcm_token || '').trim() || null;
  }

  const orderStr = String(orderId);
  const subject = `Orden ${orderStr} — error en fotos`;
  const photoList = names.join(', ');
  const body =
    `Se marcaron errores en fotos de la orden ${orderStr}.\n` +
    `Fotos con error: ${photoList}\n` +
    `Técnico: ${String(t?.full_name || '').trim()} (${String(t?.employee_code || '').trim() || technicianId})\n`;

  const pushBody = `Orden ${orderStr} · ${photoList}`;

  const emailByLower = new Map();
  const fcmTokens = new Set();

  offerEmail(emailByLower, t?.email);
  offerToken(fcmTokens, t?.fcm_token);
  offerEmail(emailByLower, supEmail);
  offerToken(fcmTokens, supToken);

  for (const a of adminRows || []) {
    offerEmail(emailByLower, a.email);
    offerToken(fcmTokens, a.fcm_token);
  }

  await Promise.all([
    ...[...emailByLower.values()].map((to) => sendEmail({ to, subject, text: body })),
    ...[...fcmTokens].map((toToken) =>
      sendFcm({
        toToken,
        title: subject,
        body: pushBody
      })
    )
  ]);
}

module.exports = { notifyQualityInspectionError };
