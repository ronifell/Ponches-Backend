/**
 * Temporarily marks a quality photo ERROR, runs notifyQualityInspectionError, restores photo.
 * Validates FCM + email wiring without requiring a region-eligible admin JWT.
 *
 *   PONCHES_TEST_EMP_CODE=EMP135 node scripts/simulate-quality-error-notify.cjs
 */
process.chdir(require('path').join(__dirname, '..'));
const { pool } = require('../src/db/pool');
const { notifyQualityInspectionError } = require('../src/services/qualityInspectionNotify');
const {
  ensureInspectorDecisionColumn,
  recomputeQualityFromPhotos
} = require('../src/services/qualityRollup');
const { ensureQualityPhotosInspectorDecisionColumn } = require('../src/db/ensureQualityPhotoInspector');

const EMP_CODE = process.env.PONCHES_TEST_EMP_CODE || 'EMP135';

(async () => {
  await ensureInspectorDecisionColumn();
  await ensureQualityPhotosInspectorDecisionColumn();

  const [[tech]] = await pool.query(
    `SELECT id, company_id FROM employees WHERE employee_code = ? LIMIT 1`,
    [EMP_CODE]
  );
  if (!tech) {
    console.error('No employee', EMP_CODE);
    process.exit(1);
  }

  const [qrows] = await pool.query(
    `SELECT q.id AS quality_id, q.order_id, qp.id AS photo_id, qp.inspector_decision, qp.inspector_comment
     FROM qualities q
     JOIN quality_photos qp ON qp.quality_id = q.id
     WHERE q.company_id = ? AND q.user_id = ?
       AND COALESCE(TRIM(qp.photo_url), '') <> ''
     ORDER BY q.updated_at DESC
     LIMIT 1`,
    [tech.company_id, tech.id]
  );
  const row = qrows?.[0];
  if (!row) {
    console.error('No quality with photo for', EMP_CODE);
    process.exit(1);
  }

  const prevDecision = row.inspector_decision || 'NONE';
  const prevComment = row.inspector_comment;

  const qualityId = row.quality_id;
  const photoId = row.photo_id;
  const orderId = row.order_id;
  const companyId = tech.company_id;

  console.log('Simulating ERROR notify for qualityId=', qualityId, 'photoId=', photoId);

  await pool.query(
    `UPDATE quality_photos SET inspector_decision = 'ERROR', inspector_comment = ? WHERE id = ? AND quality_id = ?`,
    ['[simulation] error notify test', photoId, qualityId]
  );
  await recomputeQualityFromPhotos(qualityId, companyId);

  try {
    await notifyQualityInspectionError({
      companyId,
      qualityId,
      technicianId: tech.id,
      orderId
    });
    console.log('notifyQualityInspectionError finished (see logs for [quality-inspection-notify], [fcm], mail).');
  } finally {
    await pool.query(
      `UPDATE quality_photos SET inspector_decision = ?, inspector_comment = ? WHERE id = ? AND quality_id = ?`,
      [prevDecision, prevComment, photoId, qualityId]
    );
    await recomputeQualityFromPhotos(qualityId, companyId);
    console.log('Restored photo inspector_decision to', prevDecision);
  }

  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
