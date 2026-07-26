import test from 'node:test';
import assert from 'node:assert/strict';
import { imageUxReviewProofEvidence } from '../../dist/core/image-ux-review.js';

test('UX-Review Completion Proof evidence summarizes only verified image-voxel relations', () => {
  const artifacts = {
    inventory: { source_screens: [{ id: 'screen-1' }] },
    generated_review_ledger: { generated_count: 1, real_generated_count: 1, generated_review_images: [{ real_generated: true, mock: false, image_voxel_relation: 'generated_callout_review_of' }] },
    issue_ledger: { validation: { ok: true }, blocking_issue_count: 0, issues: [{ severity: 'P1', status: 'fixed' }] },
    recapture_plan: { changed_screens_rechecked_or_not_applicable: true }
  };
  const evidence = imageUxReviewProofEvidence({ passed: true, blockers: [], image_voxel_relations_created: true }, artifacts);
  assert.equal(evidence.status, 'verified');
  assert.equal(evidence.image_voxel_relation_count, 1);
  assert.equal(evidence.claims.ux_review_image_voxel_relations_verified, true);

  const metadataOnly = imageUxReviewProofEvidence({ passed: false, blockers: [], image_voxel_relations_created: false }, artifacts);
  assert.equal(metadataOnly.image_voxel_relation_count, 0);
  assert.equal(metadataOnly.claims.ux_review_image_voxel_relations_verified, false);
});
