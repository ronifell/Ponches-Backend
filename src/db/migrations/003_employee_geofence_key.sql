-- Assign each employee to a specific geofence (circle) for clock-in/out validation.
-- office_id remains the office; geofence_key points to geofences.geofence_key (unique).

ALTER TABLE employees
  ADD COLUMN geofence_key VARCHAR(64) NULL,
  ADD CONSTRAINT fk_employees_geofence FOREIGN KEY (geofence_key) REFERENCES geofences (geofence_key);

-- Backfill: pick one geofence per employee's office (deterministic order).
UPDATE employees e
INNER JOIN (
  SELECT g.office_id, MIN(g.geofence_key) AS geofence_key
  FROM geofences g
  GROUP BY g.office_id
) x ON x.office_id = e.office_id
SET e.geofence_key = x.geofence_key
WHERE e.geofence_key IS NULL;
