-- Operational region (text) and optional physical card number; independent of geofences.

ALTER TABLE employees ADD COLUMN region VARCHAR(128) NULL;
ALTER TABLE employees ADD COLUMN card_number VARCHAR(64) NULL;
