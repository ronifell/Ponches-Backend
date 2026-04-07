const { pool } = require('../db/pool');
const { sendEmail, sendFcm } = require('./notify');

/**
 * Admin marked one or more quality photos as ERROR — notify technician and supervisor (email + push).
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

  let supEmail = null;
  let supToken = null;
  if (t?.supervisor_id) {
    const [s] = await pool.query(
      `SELECT email, fcm_token FROM employees WHERE id = ? AND company_id = ? LIMIT 1`,
      [t.supervisor_id, companyId]
    );
    supEmail = String(s?.[0]?.email || '').trim() || null;
    supToken = String(s?.[0]?.fcm_token || '').trim() || null;
  } else {
    const [s] = await pool.query(
      `SELECT email, fcm_token FROM employees WHERE company_id = ? AND role = 'SUPERVISOR' LIMIT 1`,
      [companyId]
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

  await Promise.all([
    t?.email ? sendEmail({ to: String(t.email).trim(), subject, text: body }) : Promise.resolve(),
    t?.fcm_token
      ? sendFcm({
          toToken: t.fcm_token,
          title: subject,
          body: `Fotos: ${photoList}`
        })
      : Promise.resolve(),
    supEmail ? sendEmail({ to: supEmail, subject, text: body }) : Promise.resolve(),
    supToken
      ? sendFcm({
          toToken: supToken,
          title: subject,
          body: `Orden ${orderStr} · ${photoList}`
        })
      : Promise.resolve()
  ]);
}

module.exports = { notifyQualityInspectionError };
