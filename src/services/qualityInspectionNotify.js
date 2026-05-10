const { pool } = require('../db/pool');
const { sendEmail, sendFcm } = require('./notify');
const { getCustomerContactSuffixForQuality } = require('../lib/customerContactEmail');

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
 * Admin marked one or more quality photos as ERROR:
 * - Push (FCM): technician only — employee code, order, slot(s), validator comment(s).
 * - Email: technician, assigned supervisor, and every company ADMIN (supervisor resolved by id, not role filter).
 */
async function notifyQualityInspectionError({ companyId, qualityId, technicianId, orderId }) {
  const [errPhotos] = await pool.query(
    `SELECT photo_type, inspector_comment FROM quality_photos
     WHERE quality_id = ? AND inspector_decision = 'ERROR'
     ORDER BY photo_type`,
    [qualityId]
  );
  const lines = (errPhotos || [])
    .map((p) => {
      const slot = String(p.photo_type || '').trim();
      if (!slot) return '';
      const note = String(p.inspector_comment || '').trim();
      return note ? `${slot}: ${note}` : slot;
    })
    .filter(Boolean);
  const detailBlock = lines.length > 0 ? lines.join('\n') : 'Revisar imagen(es) marcadas con ERROR.';

  const [techRows] = await pool.query(
    `SELECT email, fcm_token, full_name, employee_code, supervisor_id
     FROM employees WHERE id = ? AND company_id = ? LIMIT 1`,
    [technicianId, companyId]
  );
  const t = techRows?.[0];

  const [adminRows] = await pool.query(
    `SELECT email FROM employees WHERE company_id = ? AND role = 'ADMIN'`,
    [companyId]
  );
  const [coRows] = await pool.query(
    'SELECT notification_email FROM companies WHERE id = ? LIMIT 1',
    [companyId]
  );
  const companyFrom = String(coRows?.[0]?.notification_email || '').trim() || null;

  let supEmail = null;
  if (t?.supervisor_id) {
    const [s] = await pool.query(
      `SELECT email FROM employees WHERE id = ? AND company_id = ? LIMIT 1`,
      [t.supervisor_id, companyId]
    );
    supEmail = String(s?.[0]?.email || '').trim() || null;
  }

  const orderStr = String(orderId);
  const empCode = String(t?.employee_code || '').trim() || 'N/A';
  const techName = String(t?.full_name || '').trim();
  const subject = `[Calidad] Orden ${orderStr} — error en foto(s)`;
  const contactSuffix = await getCustomerContactSuffixForQuality(qualityId, companyId);
  const body =
    `Se marcaron errores en fotos de la orden ${orderStr}.\n\n` +
    `Detalle (elemento y comentario del validador):\n${detailBlock}\n\n` +
    `Código empleado (técnico): ${empCode}\n` +
    (techName ? `Nombre: ${techName}\n` : '') +
    `\nRevise la orden en el panel de calidad.` +
    contactSuffix;

  const compactDetail = detailBlock.replace(/\s+/g, ' ').trim();
  const corePush = `${empCode} · Orden ${orderStr} · ${compactDetail}`;
  const pushBody =
    corePush.length > 380 ? `${corePush.slice(0, 377)}...` : corePush;
  const pushTitle = `Error calidad · ${empCode} · ${orderStr}`;

  const emailByLower = new Map();
  offerEmail(emailByLower, t?.email);
  offerEmail(emailByLower, supEmail);
  for (const a of adminRows || []) {
    offerEmail(emailByLower, a.email);
  }

  const technicianFcm = String(t?.fcm_token || '').trim();

  if (!technicianFcm) {
    console.warn(
      `[quality-inspection-notify] no FCM token for technician employeeId=${technicianId} qualityId=${qualityId} (login on phone + notification permission)`
    );
  }
  if (emailByLower.size === 0) {
    console.warn(
      `[quality-inspection-notify] no email recipients (technician/supervisor/admins need addresses) company=${companyId} qualityId=${qualityId}`
    );
  }

  const deliveries = await Promise.allSettled([
    ...[...emailByLower.values()].map((to) => sendEmail({ to, subject, text: body, from: companyFrom })),
    ...(technicianFcm
      ? [
          sendFcm({
            toToken: technicianFcm,
            title: pushTitle,
            body: pushBody
          })
        ]
      : [])
  ]);
  const failed = deliveries.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    console.warn(
      `[quality-inspection-notify] ${failed.length} delivery(ies) failed for qualityId=${qualityId}:`,
      failed.map((f) => String(f.reason?.message || f.reason || 'unknown'))
    );
  }
}

module.exports = { notifyQualityInspectionError };
