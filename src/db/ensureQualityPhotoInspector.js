const { pool } = require('./pool');

let photoInspectorDecisionColumnEnsured = false;

/** Adds quality_photos.inspector_decision and backfills from legacy qualities.inspector_decision once. */
async function ensureQualityPhotosInspectorDecisionColumn() {
  if (photoInspectorDecisionColumnEnsured) return;
  try {
    await pool.query(
      `ALTER TABLE quality_photos ADD COLUMN inspector_decision ENUM('NONE','FE','ERROR','OK') NOT NULL DEFAULT 'NONE'`
    );
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
  await pool.query(
    `UPDATE quality_photos qp
     INNER JOIN qualities q ON q.id = qp.quality_id
     SET qp.inspector_decision = q.inspector_decision
     WHERE q.inspector_decision IN ('OK', 'FE', 'ERROR')
       AND qp.inspector_decision = 'NONE'`
  );
  photoInspectorDecisionColumnEnsured = true;
}

module.exports = { ensureQualityPhotosInspectorDecisionColumn };
