const { pool } = require('../db/pool');

/**
 * Non-empty region on the viewer → same-region employees only (trimmed equality).
 * Empty/NULL viewer region → no filter (legacy company-wide access).
 */
async function viewerRegionParams(viewerEmployeeId, companyId) {
  const [rows] = await pool.query(
    `SELECT TRIM(COALESCE(region, '')) AS r
     FROM employees
     WHERE id = ? AND company_id = ?
     LIMIT 1`,
    [viewerEmployeeId, companyId]
  );
  const r = rows?.[0]?.r;
  if (!r) return { whereSql: '', params: [] };
  return {
    whereSql: " AND TRIM(COALESCE(e.region, '')) = ? ",
    params: [r]
  };
}

module.exports = { viewerRegionParams };
