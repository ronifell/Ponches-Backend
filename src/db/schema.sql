-- Ponches App schema (MySQL 8+)

CREATE TABLE IF NOT EXISTS companies (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  notification_email VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Existing DBs need this added without failing.
ALTER TABLE companies ADD COLUMN notification_email VARCHAR(255) NULL;

CREATE TABLE IF NOT EXISTS offices (
  id CHAR(36) PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  opening_time TIME NOT NULL DEFAULT '09:00:00',
  grace_minutes INT NOT NULL DEFAULT 15,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_offices_company FOREIGN KEY (company_id) REFERENCES companies(id)
) ENGINE=InnoDB;

-- Geofence circle for each office
CREATE TABLE IF NOT EXISTS geofences (
  id CHAR(36) PRIMARY KEY,
  office_id CHAR(36) NOT NULL,
  geofence_key VARCHAR(64) NOT NULL UNIQUE, -- used as geofence requestId in Android
  latitude DOUBLE NOT NULL,
  longitude DOUBLE NOT NULL,
  radius_meters INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_geofences_office FOREIGN KEY (office_id) REFERENCES offices(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS employees (
  id CHAR(36) PRIMARY KEY,
  employee_code VARCHAR(64) NOT NULL UNIQUE, -- "Employee ID" used by the app
  company_id CHAR(36) NOT NULL,
  office_id CHAR(36) NOT NULL,
  geofence_key VARCHAR(64) NULL,
  role ENUM('EMPLOYEE','SUPERVISOR','INSPECTOR','ADMIN') NOT NULL DEFAULT 'EMPLOYEE',
  full_name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  fcm_token VARCHAR(512) NULL,
  email VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_employees_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_employees_office FOREIGN KEY (office_id) REFERENCES offices(id),
  CONSTRAINT fk_employees_geofence FOREIGN KEY (geofence_key) REFERENCES geofences(geofence_key)
) ENGINE=InnoDB;

ALTER TABLE employees
  ADD COLUMN employee_type ENUM('CENTRALIZED','DECENTRALIZED') NOT NULL DEFAULT 'CENTRALIZED',
  ADD COLUMN supervisor_id CHAR(36) NULL,
  ADD COLUMN is_supervisor TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE employees
  MODIFY COLUMN role ENUM('EMPLOYEE','SUPERVISOR','INSPECTOR','ADMIN') NOT NULL DEFAULT 'EMPLOYEE';

ALTER TABLE employees ADD COLUMN region VARCHAR(128) NULL;

-- Orders represent a customer location used for photo validation.
CREATE TABLE IF NOT EXISTS customer_orders (
  order_number VARCHAR(128) PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  latitude DOUBLE NOT NULL,
  longitude DOUBLE NOT NULL,
  radius_meters INT NOT NULL DEFAULT 150,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_company FOREIGN KEY (company_id) REFERENCES companies(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS attendance_events (
  id CHAR(36) PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  office_id CHAR(36) NOT NULL,
  employee_id CHAR(36) NOT NULL,
  event_type ENUM(
    'CHECK_IN',
    'MOVEMENT',
    'GEOFENCE_ENTER',
    'GEOFENCE_EXIT',
    'WORKDAY_CLOSED'
  ) NOT NULL,
  -- Whether workday was ended manually by employee; used for notifications
  manual_close TINYINT(1) NOT NULL DEFAULT 0,
  -- Source of event: geofence transitions, or manual/auto close
  source ENUM('GEOFENCE','MANUAL','AUTO') NOT NULL DEFAULT 'GEOFENCE',
  occurred_at DATETIME(3) NOT NULL,
  workday_date DATE NOT NULL, -- computed in America/Santo_Domingo timezone
  geofence_key VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_attendance_employee FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_attendance_office FOREIGN KEY (office_id) REFERENCES offices(id),
  CONSTRAINT fk_attendance_company FOREIGN KEY (company_id) REFERENCES companies(id),
  INDEX idx_attendance_employee_workday (employee_id, workday_date),
  INDEX idx_attendance_company_date (company_id, workday_date)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS photo_uploads (
  id CHAR(36) PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  employee_id CHAR(36) NOT NULL,
  order_number VARCHAR(128) NOT NULL,
  work_type VARCHAR(128) NOT NULL,
  latitude DOUBLE NOT NULL,
  longitude DOUBLE NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  validation_result ENUM('APPROVED','REJECTED','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  validation_distance_meters INT NULL,
  server_path VARCHAR(512) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_photo_employee FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_photo_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_photo_order FOREIGN KEY (order_number) REFERENCES customer_orders(order_number),
  INDEX idx_photos_employee (employee_id, occurred_at)
) ENGINE=InnoDB;

-- Punches table for business-facing Entry/Movement/Exit flow.
CREATE TABLE IF NOT EXISTS punches (
  id CHAR(36) PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  punch_type ENUM('ENTRY','MOVEMENT','EXIT') NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  latitude DOUBLE NOT NULL,
  longitude DOUBLE NOT NULL,
  office_id CHAR(36) NOT NULL,
  workday_date DATE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_punches_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_punches_user FOREIGN KEY (user_id) REFERENCES employees(id),
  CONSTRAINT fk_punches_office FOREIGN KEY (office_id) REFERENCES offices(id),
  INDEX idx_punches_user_workday (user_id, workday_date),
  INDEX idx_punches_company_date (company_id, workday_date)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS qualities (
  id CHAR(36) PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  order_id VARCHAR(128) NOT NULL,
  work_type VARCHAR(128) NOT NULL,
  stb_count TINYINT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('PENDING','IN_REVIEW','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  inspector_decision ENUM('NONE','FE','ERROR','OK') NOT NULL DEFAULT 'NONE',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_qualities_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_qualities_user FOREIGN KEY (user_id) REFERENCES employees(id),
  INDEX idx_qualities_user_created (user_id, created_at)
) ENGINE=InnoDB;

ALTER TABLE qualities ADD COLUMN inspector_decision ENUM('NONE','FE','ERROR','OK') NOT NULL DEFAULT 'NONE';

CREATE TABLE IF NOT EXISTS quality_photos (
  id CHAR(36) PRIMARY KEY,
  quality_id CHAR(36) NOT NULL,
  photo_type VARCHAR(64) NOT NULL,
  photo_url VARCHAR(512) NOT NULL,
  fe TINYINT(1) NOT NULL DEFAULT 0,
  fe_comment VARCHAR(1024) NULL,
  inspector_decision ENUM('NONE','FE','ERROR','OK') NOT NULL DEFAULT 'NONE',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_quality_photos_quality FOREIGN KEY (quality_id) REFERENCES qualities(id) ON DELETE CASCADE,
  INDEX idx_quality_photos_quality (quality_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS non_operational_causes (
  id CHAR(36) PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  cause_name VARCHAR(128) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_non_operational_causes_company FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_non_operational_cause_name (company_id, cause_name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS employee_work_schedules (
  id CHAR(36) PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  employee_id CHAR(36) NOT NULL,
  schedule_date DATE NOT NULL,
  day_type ENUM('WORKDAY','DAY_OFF','HALF_DAY','NON_OPERATIONAL') NOT NULL DEFAULT 'WORKDAY',
  non_operational_cause_id CHAR(36) NULL,
  notes VARCHAR(512) NULL,
  created_by CHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_schedule_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_schedule_employee FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_schedule_cause FOREIGN KEY (non_operational_cause_id) REFERENCES non_operational_causes(id),
  CONSTRAINT fk_schedule_creator FOREIGN KEY (created_by) REFERENCES employees(id),
  UNIQUE KEY uq_employee_schedule_date (employee_id, schedule_date),
  INDEX idx_schedule_company_date (company_id, schedule_date)
) ENGINE=InnoDB;

-- Employee invites: admin sends link; user sets password + optional email
CREATE TABLE IF NOT EXISTS employee_invites (
  token CHAR(36) PRIMARY KEY,
  employee_id CHAR(36) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_invites_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  INDEX idx_invites_employee (employee_id),
  INDEX idx_invites_expires (expires_at)
) ENGINE=InnoDB;

-- Password reset verification codes (email + code onboarding flow).
CREATE TABLE IF NOT EXISTS password_reset_codes (
  id CHAR(36) PRIMARY KEY,
  employee_id CHAR(36) NOT NULL,
  code_hash VARCHAR(255) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_password_reset_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  INDEX idx_password_reset_employee (employee_id),
  INDEX idx_password_reset_expires (expires_at)
) ENGINE=InnoDB;

-- Basic reference data for cron/job logic.
CREATE TABLE IF NOT EXISTS workday_closure_notified (
  employee_id CHAR(36) NOT NULL,
  workday_date DATE NOT NULL,
  notified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (employee_id, workday_date)
) ENGINE=InnoDB;

