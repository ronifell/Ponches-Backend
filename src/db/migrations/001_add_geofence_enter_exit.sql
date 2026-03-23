-- Add GEOFENCE_ENTER and GEOFENCE_EXIT to distinguish entering vs leaving the office.
-- Run this if your database was created before this change.
ALTER TABLE attendance_events MODIFY COLUMN event_type ENUM(
  'CHECK_IN',
  'MOVEMENT',
  'GEOFENCE_ENTER',
  'GEOFENCE_EXIT',
  'WORKDAY_CLOSED'
) NOT NULL;
