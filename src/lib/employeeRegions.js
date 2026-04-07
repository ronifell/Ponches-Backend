/** Operational regions stored on employees (must match app/admin pickers). */
const ALLOWED_EMPLOYEE_REGIONS = Object.freeze(['Este', 'Norte', 'Sur']);
const SET = new Set(ALLOWED_EMPLOYEE_REGIONS);

function isAllowedEmployeeRegion(value) {
  if (value == null || value === '') return true;
  return SET.has(String(value).trim());
}

module.exports = {
  ALLOWED_EMPLOYEE_REGIONS,
  isAllowedEmployeeRegion
};
