const { pool } = require('../db/pool');

/** Plain-text lines appended when this notification is not tied to an order/work quality record. */
const CUSTOMER_EMAIL_SUFFIX_NOT_APPLICABLE =
  '\n---\n' +
  'Cliente — móvil: No aplica a esta notificación\n' +
  'Cliente — coordenadas (pedido): No aplica a esta notificación\n';

/** Short HTML block for the same (password reset, attendance, etc.). */
const CUSTOMER_EMAIL_SUFFIX_NOT_APPLICABLE_HTML =
  '<hr style="border:none;border-top:1px solid #ccc;margin:16px 0;" />' +
  '<p><b>Cliente — móvil:</b> No aplica a esta notificación<br/>' +
  '<b>Cliente — coordenadas (pedido):</b> No aplica a esta notificación</p>';

function formatCoordPair(lat, lng) {
  if (
    lat == null ||
    lng == null ||
    !Number.isFinite(Number(lat)) ||
    !Number.isFinite(Number(lng))
  ) {
    return null;
  }
  return `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
}

/**
 * Customer mobile from `qualities`, coordinates from `customer_orders` for the same order id + company.
 */
async function getCustomerContactSuffixForQuality(qualityId, companyId) {
  const [rows] = await pool.query(
    `SELECT TRIM(COALESCE(q.customer_mobile, '')) AS customer_mobile,
            o.latitude AS order_lat,
            o.longitude AS order_lng
     FROM qualities q
     LEFT JOIN customer_orders o
       ON o.order_number = q.order_id AND o.company_id = q.company_id
     WHERE q.id = ? AND q.company_id = ?
     LIMIT 1`,
    [qualityId, companyId]
  );
  const r = rows?.[0];
  const mobile = String(r?.customer_mobile || '').trim() || 'No registrado';
  const coords = formatCoordPair(r?.order_lat, r?.order_lng) || 'No registrado';
  return (
    '\n---\n' +
    `Cliente — móvil: ${mobile}\n` +
    `Cliente — coordenadas (pedido): ${coords}\n`
  );
}

/**
 * Used by generic photo upload emails: resolve order coordinates + latest quality mobile for that order.
 */
async function getCustomerContactSuffixForOrderNumber(orderNumber, companyId) {
  const ord = String(orderNumber || '').trim();
  if (!ord) {
    return (
      '\n---\n' +
      'Cliente — móvil: No registrado\n' +
      'Cliente — coordenadas (pedido): No registrado\n'
    );
  }
  const [rows] = await pool.query(
    `SELECT co.latitude AS order_lat,
            co.longitude AS order_lng,
            (SELECT TRIM(COALESCE(customer_mobile, ''))
             FROM qualities
             WHERE company_id = ? AND order_id = ?
             ORDER BY updated_at DESC LIMIT 1) AS customer_mobile
     FROM customer_orders co
     WHERE co.order_number = ? AND co.company_id = ?
     LIMIT 1`,
    [companyId, ord, ord, companyId]
  );
  const r = rows?.[0];
  const mobile = String(r?.customer_mobile || '').trim() || 'No registrado';
  const coords = formatCoordPair(r?.order_lat, r?.order_lng) || 'No registrado';
  return (
    '\n---\n' +
    `Cliente — móvil: ${mobile}\n` +
    `Cliente — coordenadas (pedido): ${coords}\n`
  );
}

module.exports = {
  CUSTOMER_EMAIL_SUFFIX_NOT_APPLICABLE,
  CUSTOMER_EMAIL_SUFFIX_NOT_APPLICABLE_HTML,
  getCustomerContactSuffixForQuality,
  getCustomerContactSuffixForOrderNumber
};
