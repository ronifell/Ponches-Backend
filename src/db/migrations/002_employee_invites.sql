-- Employee invites for admin-initiated onboarding
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
