import test from 'node:test';
import assert from 'node:assert/strict';
import { capturedInventory, importDist, mockGeneratedReviewImage, realGeneratedReviewImage, tempImageRoot } from '../helpers/ux-review-1-0-8-fixtures.mjs';

test('UX-Review gate v2 passes only with real generated callout evidence and honest closeout', async () => {
  const imageUx = await importDist('core/image-ux-review.js');
  const { root, imagePath } = await tempImageRoot();
  const { contract, inventory } = await capturedInventory(imageUx, root, imagePath);
  const generated = imageUx.buildImageUxGeneratedReviewLedger(contract, inventory, { generated_review_images: [realGeneratedReviewImage()] }, { root });
  const issueLedger = imageUx.buildImageUxIssueLedger(contract, generated);
  const gate = imageUx.defaultImageUxReviewGate(contract, {
    inventory,
    generatedReviewLedger: generated,
    issueLedger,
    imageVoxelRelationsCreated: true,
    wrongnessChecked: true,
    honestModeComplete: true
  });
  assert.equal(gate.passed, true);

  const mockGenerated = imageUx.buildImageUxGeneratedReviewLedger(contract, inventory, { generated_review_images: [mockGeneratedReviewImage()] }, { root });
  assert.equal(imageUx.defaultImageUxReviewGate(contract, { inventory, generatedReviewLedger: mockGenerated }).passed, false);
});

test('UX-Review gate v2 cannot pass full verification from generated-image metadata without file evidence', async () => {
  const imageUx = await importDist('core/image-ux-review.js');
  const { root, imagePath } = await tempImageRoot();
  const { contract, inventory } = await capturedInventory(imageUx, root, imagePath);
  const generated = imageUx.buildImageUxGeneratedReviewLedger(contract, inventory, {
    generated_review_images: [realGeneratedReviewImage({
      path: undefined,
      sha256: undefined,
      width: undefined,
      height: undefined
    })]
  }, { root });
  const issueLedger = imageUx.buildImageUxIssueLedger(contract, generated);
  const gate = imageUx.defaultImageUxReviewGate(contract, {
    inventory,
    generatedReviewLedger: generated,
    issueLedger,
    imageVoxelRelationsCreated: true,
    wrongnessChecked: true,
    honestModeComplete: true
  });

  assert.equal(generated.real_generated_count, 0);
  assert.equal(generated.passed, false);
  assert.ok(generated.blockers.includes('generated_review_image_missing'));
  assert.equal(gate.passed, false);
  assert.equal(gate.full_review_passed, false);
  assert.notEqual(gate.verified_level, 'verified');
});

test('UX-Review gate v2 allows reference-only partial closeout when generated image is unavailable', async () => {
  const imageUx = await importDist('core/image-ux-review.js');
  const { root, imagePath } = await tempImageRoot();
  const { contract, inventory } = await capturedInventory(imageUx, root, imagePath);
  const generated = imageUx.buildImageUxGeneratedReviewLedger(contract, inventory);
  const issueLedger = imageUx.buildImageUxIssueLedger(contract, generated);
  const gate = imageUx.defaultImageUxReviewGate(contract, {
    inventory,
    generatedReviewLedger: generated,
    issueLedger,
    imageVoxelReferenceAnchorCreated: true,
    wrongnessChecked: true,
    honestModeComplete: true
  });

  assert.equal(gate.passed, true);
  assert.equal(gate.status, 'verified_partial_reference');
  assert.equal(gate.verified_level, 'verified_partial');
  assert.equal(gate.full_review_passed, false);
  assert.equal(gate.reference_only, true);
  assert.equal(gate.gpt_image_2_callout_generated, false);
  assert.equal(gate.generated_image_ingested, false);
  assert.equal(gate.issue_ledger_from_generated_callout, false);
  assert.deepEqual(gate.blockers, []);
  assert.ok(gate.full_verification_blockers.includes('missing_generated_annotated_review_images'));
  assert.ok(gate.full_verification_blockers.includes('generated_review_image_missing'));
});

test('three-stage review completion succeeds while risky optional patches remain human-blocked', async () => {
  const imageUx = await importDist('core/image-ux-review.js');
  const { planImageUxFixTasks } = await importDist('core/image-ux-review/fix-task-planner.js');
  const { runImageUxFixLoop } = await importDist('core/image-ux-review/fix-loop.js');
  const { buildRecapturePlan } = await importDist('core/image-ux-review/recapture.js');
  const { root, imagePath } = await tempImageRoot();
  const { contract, inventory } = await capturedInventory(imageUx, root, imagePath);
  const generated = imageUx.buildImageUxGeneratedReviewLedger(contract, inventory, {
    generated_review_images: [realGeneratedReviewImage({
      callouts: [{
        id: 'callout-open-p1',
        severity: 'P1',
        bbox: [0, 0, 1, 1],
        title: 'Visible hierarchy issue',
        detail: 'The generated review image marks a visible hierarchy issue.',
        likely_cause: 'hierarchy',
        fix_action: 'Rework the hierarchy after a human identifies the owning UI file.',
        status: 'open',
        confidence: 0.92,
        candidate_files: []
      }]
    })]
  }, { root });
  const issueLedger = imageUx.buildImageUxIssueLedger(contract, generated);
  const fixTaskPlan = planImageUxFixTasks(issueLedger);
  const fixLoop = runImageUxFixLoop(issueLedger, fixTaskPlan);
  const recapturePlan = buildRecapturePlan(fixLoop);
  const iterationReport = imageUx.buildImageUxIterationReport(
    contract,
    imageUx.buildImageUxReviewPolicy(contract),
    generated,
    issueLedger,
    fixTaskPlan,
    fixLoop,
    recapturePlan
  );
  const gate = imageUx.defaultImageUxReviewGate(contract, {
    inventory,
    generatedReviewLedger: generated,
    issueLedger,
    fixTaskPlan,
    fixLoop,
    recapturePlan,
    iterationReport,
    imageVoxelRelationsCreated: true,
    wrongnessChecked: true,
    honestModeComplete: true
  });
  const outcome = imageUx.imageUxReviewCommandOutcome(gate, false, { allowReviewOnlyCompletion: true });
  const explicitFixOutcome = imageUx.imageUxReviewCommandOutcome(gate, false, { allowReviewOnlyCompletion: false });

  assert.equal(iterationReport.review_report_completed, true);
  assert.equal(iterationReport.full_review_passed, false);
  assert.equal(iterationReport.requires_human_review, true);
  assert.equal(gate.review_report_completed, true);
  assert.equal(gate.status, 'review_completed');
  assert.equal(gate.passed, false);
  assert.equal(gate.full_review_passed, false);
  assert.equal(gate.requires_human_review, true);
  assert.equal(gate.unresolved_p0_p1_count, 1);
  assert.ok(gate.blockers.includes('risky_patch_requires_human_review'));
  assert.ok(gate.full_verification_blockers.includes('risky_patch_requires_human_review'));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'review_completed');
  assert.equal(outcome.completion_scope, 'capture_imagegen_ocr_and_ux_report');
  assert.equal(outcome.review_report_completed, true);
  assert.equal(outcome.review_only_completion_allowed, true);
  assert.equal(outcome.full_review_passed, false);
  assert.equal(outcome.requires_human_review, true);
  assert.equal(outcome.unresolved_p0_p1_count, 1);
  assert.equal(outcome.proof_ok, false);
  assert.ok(outcome.safety_blockers.includes('risky_patch_requires_human_review'));
  assert.equal(explicitFixOutcome.ok, false);
  assert.equal(explicitFixOutcome.status, 'blocked');
  assert.equal(explicitFixOutcome.review_report_completed, true);
  assert.equal(explicitFixOutcome.review_only_completion_allowed, false);
  assert.equal(explicitFixOutcome.full_review_passed, false);
  assert.ok(explicitFixOutcome.safety_blockers.includes('risky_patch_requires_human_review'));
});
