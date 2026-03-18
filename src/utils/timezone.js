const { DateTime } = require('luxon');

const ZONE = 'America/Santo_Domingo';

function nowSantoDomingo() {
  return DateTime.now().setZone(ZONE);
}

function toWorkdayDate(dateTime) {
  // Workday date is computed in Dominican Republic local time.
  return dateTime.setZone(ZONE).toISODate(); // YYYY-MM-DD
}

function parseOccuredAt(occurredAt) {
  // Accept ISO strings or Date objects.
  if (!occurredAt) return nowSantoDomingo();
  if (occurredAt instanceof Date) return DateTime.fromJSDate(occurredAt).setZone(ZONE);
  const asIsoZoned = DateTime.fromISO(occurredAt, { zone: ZONE });
  if (asIsoZoned.isValid) return asIsoZoned;
  return DateTime.fromISO(occurredAt).setZone(ZONE);
}

module.exports = { ZONE, nowSantoDomingo, toWorkdayDate, parseOccuredAt };

