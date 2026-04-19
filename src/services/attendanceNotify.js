const { pool } = require('../db/pool');
const { sendEmail, sendFcm } = require('./notify');
const { getAssignedSupervisorContacts } = require('./supervisorRecipients');
const { haversineDistanceMeters } = require('../utils/distance');
const { ZONE } = require('../utils/timezone');

async function computeLateMinutes({ officeId, occurredAtDt }) {
  const [rows] = await pool.query(
    'SELECT opening_time, grace_minutes FROM offices WHERE id = ? LIMIT 1',
    [officeId]
  );
  const office = rows?.[0];
  if (!office) return null;

  const [hh, mm] = String(office.opening_time).split(':').map((x) => Number(x));
  const openingTime = occurredAtDt.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  const deadline = openingTime.plus({ minutes: Number(office.grace_minutes || 0) });

  if (occurredAtDt <= deadline) return 0;
  const diffMinutes = occurredAtDt.diff(deadline, 'minutes').minutes;
  return Math.ceil(diffMinutes);
}

async function getEmployeeContacts(employeeId) {
  const [rows] = await pool.query(
    `SELECT e.email, e.fcm_token, e.full_name, e.employee_code
     FROM employees e WHERE e.id = ? LIMIT 1`,
    [employeeId]
  );
  return rows?.[0] || null;
}

async function getOfficeGeofenceContext(officeId, geofenceKey) {
  const key = geofenceKey != null && String(geofenceKey).trim() !== '' ? String(geofenceKey).trim() : null;
  let row;
  if (key) {
    const [rows] = await pool.query(
      `SELECT o.name AS office_name, g.latitude, g.longitude, g.radius_meters
       FROM offices o
       JOIN geofences g ON g.office_id = o.id
       WHERE o.id = ? AND g.geofence_key = ?
       LIMIT 1`,
      [officeId, key]
    );
    row = rows?.[0];
  }
  if (!row) {
    const [rows] = await pool.query(
      `SELECT o.name AS office_name, g.latitude, g.longitude, g.radius_meters
       FROM offices o
       JOIN geofences g ON g.office_id = o.id
       WHERE o.id = ?
       ORDER BY g.created_at ASC
       LIMIT 1`,
      [officeId]
    );
    row = rows?.[0];
  }
  if (row) {
    return {
      officeName: row.office_name || 'Oficina',
      officeLat: Number(row.latitude),
      officeLng: Number(row.longitude),
      radiusMeters: Number(row.radius_meters) || 0
    };
  }
  const [fallback] = await pool.query('SELECT name AS office_name FROM offices WHERE id = ? LIMIT 1', [officeId]);
  return {
    officeName: fallback?.[0]?.office_name || 'Oficina',
    officeLat: null,
    officeLng: null,
    radiusMeters: 0
  };
}

function mapsUrl(lat, lng) {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}`;
}

function buildLateArrivalSpanishHtml({
  fullName,
  employeeCode,
  occurredAtDt,
  empLat,
  empLng,
  officeName,
  officeLat,
  officeLng,
  radiusMeters
}) {
  const zoned = occurredAtDt.setZone(ZONE);
  const hhmm = zoned.toFormat('HH:mm');
  const fechaHora = zoned.toFormat('yyyy-LL-dd HH:mm:ss');
  const title = `Llegada tardía - ${hhmm}`;

  let empLatUse = empLat;
  let empLngUse = empLng;
  if (
    empLatUse == null ||
    empLngUse == null ||
    !Number.isFinite(Number(empLatUse)) ||
    !Number.isFinite(Number(empLngUse))
  ) {
    empLatUse = officeLat;
    empLngUse = officeLng;
  }

  let distLine = '';
  if (
    officeLat != null &&
    officeLng != null &&
    Number.isFinite(Number(officeLat)) &&
    Number.isFinite(Number(officeLng)) &&
    empLatUse != null &&
    empLngUse != null
  ) {
    const d = haversineDistanceMeters(Number(empLatUse), Number(empLngUse), Number(officeLat), Number(officeLng));
    distLine = `<p><b>Distancia a oficina:</b> ${d.toFixed(1)} m (Radio: ${radiusMeters} m)</p>`;
  }

  const empLoc =
    empLatUse != null && empLngUse != null
      ? `<p><b>Ubicación:</b> ${Number(empLatUse)}, ${Number(empLngUse)}</p>`
      : '';

  const officeLoc =
    officeLat != null && officeLng != null
      ? `<p><b>Oficina:</b> ${officeName} (${Number(officeLat)}, ${Number(officeLng)})</p>`
      : `<p><b>Oficina:</b> ${officeName}</p>`;

  const mapEmp = mapsUrl(Number(empLatUse), Number(empLngUse));
  const mapLink = mapEmp ? `<p><a href="${mapEmp}">Ver en Google Maps</a></p>` : '';

  const nameLine = `${String(fullName || '').trim()} (Tarjeta ${String(employeeCode || '').trim()})`;

  return `<!DOCTYPE html><html><body style="font-family: sans-serif;">
<p><b><u>${title}</u></b></p>
<p><b>${title}</b></p>
<p><b>Tipo:</b> Entrada</p>
<p><b>Empleado:</b> ${nameLine}</p>
<p><b>Fecha/Hora:</b> ${fechaHora}</p>
${empLoc}
${officeLoc}
${distLine}
${mapLink}
</body></html>`;
}

function buildLateArrivalSpanishPlain({
  fullName,
  employeeCode,
  occurredAtDt,
  empLat,
  empLng,
  officeName,
  officeLat,
  officeLng,
  radiusMeters
}) {
  const zoned = occurredAtDt.setZone(ZONE);
  const hhmm = zoned.toFormat('HH:mm');
  const fechaHora = zoned.toFormat('yyyy-LL-dd HH:mm:ss');
  const title = `Llegada tardía - ${hhmm}`;
  let empLatUse = empLat;
  let empLngUse = empLng;
  if (
    empLatUse == null ||
    empLngUse == null ||
    !Number.isFinite(Number(empLatUse)) ||
    !Number.isFinite(Number(empLngUse))
  ) {
    empLatUse = officeLat;
    empLngUse = officeLng;
  }
  const lines = [
    title,
    '',
    `Tipo: Entrada`,
    `Empleado: ${String(fullName || '').trim()} (Tarjeta ${String(employeeCode || '').trim()})`,
    `Fecha/Hora: ${fechaHora}`
  ];
  if (empLatUse != null && empLngUse != null) {
    lines.push(`Ubicación: ${Number(empLatUse)}, ${Number(empLngUse)}`);
  }
  if (officeLat != null && officeLng != null) {
    lines.push(`Oficina: ${officeName} (${Number(officeLat)}, ${Number(officeLng)})`);
  } else {
    lines.push(`Oficina: ${officeName}`);
  }
  if (
    officeLat != null &&
    officeLng != null &&
    empLatUse != null &&
    empLngUse != null &&
    Number.isFinite(Number(officeLat)) &&
    Number.isFinite(Number(officeLng))
  ) {
    const d = haversineDistanceMeters(Number(empLatUse), Number(empLngUse), Number(officeLat), Number(officeLng));
    lines.push(`Distancia a oficina: ${d.toFixed(1)} m (Radio: ${radiusMeters} m)`);
  }
  const mapEmp = mapsUrl(Number(empLatUse), Number(empLngUse));
  if (mapEmp) lines.push(`Ver en Google Maps: ${mapEmp}`);
  return lines.join('\n');
}

/**
 * Late check-in: email + FCM to employee and supervisors (spec).
 */
async function notifyLateArrivalIfNeeded({ employeeId, officeId, occurredAtDt, latitude, longitude, geofenceKey }) {
  const lateMinutes = await computeLateMinutes({ officeId, occurredAtDt });
  if (lateMinutes === null || lateMinutes <= 0) return;

  const ctx = await getOfficeGeofenceContext(officeId, geofenceKey);
  const employee = await getEmployeeContacts(employeeId);
  const supervisors = await getAssignedSupervisorContacts(employeeId);

  const hhmm = occurredAtDt.setZone(ZONE).toFormat('HH:mm');
  const html = buildLateArrivalSpanishHtml({
    fullName: employee?.full_name,
    employeeCode: employee?.employee_code,
    occurredAtDt,
    empLat: latitude != null ? Number(latitude) : null,
    empLng: longitude != null ? Number(longitude) : null,
    officeName: ctx.officeName,
    officeLat: ctx.officeLat,
    officeLng: ctx.officeLng,
    radiusMeters: ctx.radiusMeters
  });
  const textBody = buildLateArrivalSpanishPlain({
    fullName: employee?.full_name,
    employeeCode: employee?.employee_code,
    occurredAtDt,
    empLat: latitude != null ? Number(latitude) : null,
    empLng: longitude != null ? Number(longitude) : null,
    officeName: ctx.officeName,
    officeLat: ctx.officeLat,
    officeLng: ctx.officeLng,
    radiusMeters: ctx.radiusMeters
  });
  const subject = `Llegada tardía - ${hhmm}`;

  const pushTitle = `Llegada tardía - ${hhmm}`;
  const pushBody = `Entrada registrada tarde (${lateMinutes} min después del límite).`;

  const emailRecipients = [];
  if (employee?.email) emailRecipients.push(String(employee.email).trim());
  for (const s of supervisors) {
    const em = String(s?.email || '').trim();
    if (em && !emailRecipients.some((x) => x.toLowerCase() === em.toLowerCase())) emailRecipients.push(em);
  }

  const fcmTargets = [];
  if (employee?.fcm_token) fcmTargets.push(employee.fcm_token);
  for (const s of supervisors) {
    const t = String(s?.fcm_token || '').trim();
    if (t && !fcmTargets.includes(t)) fcmTargets.push(t);
  }

  await Promise.all([
    ...emailRecipients.map((to) => sendEmail({ to, subject, text: textBody, html })),
    ...fcmTargets.map((toToken) => sendFcm({ toToken, title: pushTitle, body: pushBody }))
  ]);
}

/**
 * Auto workday closure: employee email + push; supervisor email only (no supervisor push).
 */
async function notifyWorkdayAutoClosed({ employeeId, officeId, occurredAtDt }) {
  const employee = await getEmployeeContacts(employeeId);
  const supervisors = await getAssignedSupervisorContacts(employeeId);
  const [ctxRows] = await pool.query(
    `SELECT o.name AS office_name FROM offices o WHERE o.id = ? LIMIT 1`,
    [officeId]
  );
  const officeName = ctxRows?.[0]?.office_name || 'la oficina';

  const who = `${String(employee?.full_name || '').trim()} (${String(employee?.employee_code || '').trim()})`.trim();
  const fecha = occurredAtDt.setZone(ZONE).toFormat('yyyy-LL-dd HH:mm');

  const subjectEmp = `Jornada cerrada automáticamente - ${fecha}`;
  const bodyEmp =
    `El sistema cerró tu jornada laboral el ${fecha} porque no se registró salida manual antes del cierre automático.\n` +
    `Oficina: ${officeName}\n`;

  const subjectSup = `Cierre automático de jornada - ${who}`;
  const bodySup =
    `El sistema cerró automáticamente la jornada del empleado ${who} el ${fecha}.\n` +
    `Oficina: ${officeName}.\n`;

  await Promise.all([
    ...(employee?.email
      ? [sendEmail({ to: String(employee.email).trim(), subject: subjectEmp, text: bodyEmp })]
      : []),
    ...(employee?.fcm_token
      ? [
          sendFcm({
            toToken: employee.fcm_token,
            title: 'Jornada cerrada automáticamente',
            body: `Sin cierre manual — ${officeName}`
          })
        ]
      : []),
    ...supervisors.map((s) => {
      const em = String(s?.email || '').trim();
      return em ? sendEmail({ to: em, subject: subjectSup, text: bodySup }) : Promise.resolve();
    })
  ]);
}

module.exports = {
  notifyLateArrivalIfNeeded,
  notifyWorkdayAutoClosed
};
