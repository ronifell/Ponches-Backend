-- Operational region (text); independent of geofences.

ALTER TABLE employees ADD COLUMN region VARCHAR(128) NULL;
