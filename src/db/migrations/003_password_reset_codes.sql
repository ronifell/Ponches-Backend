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
