-- Ponches App schema (MySQL 8+)

CREATE TABLE IF NOT EXISTS companies (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

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
  role ENUM('EMPLOYEE','SUPERVISOR','ADMIN') NOT NULL DEFAULT 'EMPLOYEE',
  full_name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  fcm_token VARCHAR(512) NULL,
  email VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_employees_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_employees_office FOREIGN KEY (office_id) REFERENCES offices(id)
) ENGINE=InnoDB;

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

-- Basic reference data for cron/job logic.
CREATE TABLE IF NOT EXISTS workday_closure_notified (
  employee_id CHAR(36) NOT NULL,
  workday_date DATE NOT NULL,
  notified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (employee_id, workday_date)
) ENGINE=InnoDB;

