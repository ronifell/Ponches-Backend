-- Card number was merged with employee_code; remove column if it exists.

ALTER TABLE employees DROP COLUMN card_number;
