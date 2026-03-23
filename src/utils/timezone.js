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

  // Android sends ISO strings (often with an offset). Try to parse as-is first,
  // then fall back to a best-effort parse in the target zone.
  const asIsoZoned = DateTime.fromISO(occurredAt, { zone: ZONE });
  if (asIsoZoned.isValid) return asIsoZoned;

  const bestEffort = DateTime.fromISO(occurredAt).setZone(ZONE);
  return bestEffort.isValid ? bestEffort : nowSantoDomingo();
}

module.exports = { ZONE, nowSantoDomingo, toWorkdayDate, parseOccuredAt };

