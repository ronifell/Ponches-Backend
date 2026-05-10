const { pool } = require('../db/pool');

let inspectorDecisionColumnEnsured = false;

async function ensureInspectorDecisionColumn() {
  if (inspectorDecisionColumnEnsured) return;
  try {
    await pool.query(
      `ALTER TABLE qualities ADD COLUMN inspector_decision ENUM('NONE','FE','ERROR','OK') NOT NULL DEFAULT 'NONE'`
    );
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
  inspectorDecisionColumnEnsured = true;
}

/** Roll up per-photo inspector decisions into qualities.status / inspector_decision for list filters. */
async function recomputeQualityFromPhotos(qualityId, companyId) {
  const [qrows] = await pool.query(
    'SELECT id FROM qualities WHERE id = ? AND company_id = ? LIMIT 1',
    [qualityId, companyId]
  );
  if (!qrows?.length) return;

  const [photos] = await pool.query(
    `SELECT COALESCE(inspector_decision, 'NONE') AS d FROM quality_photos WHERE quality_id = ?`,
    [qualityId]
  );
  if (!photos?.length) {
    await pool.query(
      `UPDATE qualities SET status = 'PENDING', inspector_decision = 'NONE', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [qualityId, companyId]
    );
    return;
  }

  const decisions = photos.map((p) => String(p.d || 'NONE').toUpperCase());
  const anyError = decisions.some((d) => d === 'ERROR');
  const allOk = decisions.every((d) => d === 'OK');
  const anyFe = decisions.some((d) => d === 'FE');

  let status;
  let inspectorDecision;
  if (anyError) {
    status = 'REJECTED';
    inspectorDecision = 'ERROR';
  } else if (allOk) {
    status = 'APPROVED';
    inspectorDecision = 'OK';
  } else if (anyFe) {
    status = 'IN_REVIEW';
    inspectorDecision = 'FE';
  } else {
    status = 'IN_REVIEW';
    inspectorDecision = 'NONE';
  }

  await pool.query(
    `UPDATE qualities SET status = ?, inspector_decision = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ?`,
    [status, inspectorDecision, qualityId, companyId]
  );
}

/**
 * After a technician uploads/replaces a photo: reset per-photo inspector fields via INSERT defaults,
 * then roll up order-level status/decision for admin lists — except while the job is still in PENDING
 * (photos not yet submitted with Complete work), where changing status would break the workflow.
 */
async function rollupQualityAfterTechnicianPhotoUpload(qualityId, companyId) {
  await ensureInspectorDecisionColumn();
  const [rows] = await pool.query(
    `SELECT UPPER(TRIM(COALESCE(status, ''))) AS st FROM qualities WHERE id = ? AND company_id = ? LIMIT 1`,
    [qualityId, companyId]
  );
  const st = String(rows?.[0]?.st || '');
  if (st === 'PENDING') return;
  await recomputeQualityFromPhotos(qualityId, companyId);
}

module.exports = {
  ensureInspectorDecisionColumn,
  recomputeQualityFromPhotos,
  rollupQualityAfterTechnicianPhotoUpload
};
