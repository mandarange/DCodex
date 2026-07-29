import test from 'node:test';
import assert from 'node:assert/strict';
import { capturedInventory, importDist, realGeneratedReviewImage, tempImageRoot } from '../helpers/ux-review-1-0-8-fixtures.mjs';

test('generated callout image ledger validates real gpt-image-2 evidence', async () => {
  const imageUx = await importDist('core/image-ux-review.js');
  const { root, imagePath } = await tempImageRoot();
  const { contract, inventory } = await capturedInventory(imageUx, root, imagePath);
  const ledger = imageUx.buildImageUxGeneratedReviewLedger(contract, inventory, { generated_review_images: [realGeneratedReviewImage()] }, { root });
  assert.equal(ledger.generated_count, 1);
  assert.equal(ledger.real_generated_count, 1);
  assert.equal(ledger.passed, true);
  assert.equal(ledger.generated_review_images[0].image_size_relation.coordinate_transform, 'identity');
});

test('one consolidated generated review can truthfully cover multiple captured screens', async () => {
  const imageUx = await importDist('core/image-ux-review.js');
  const { root, imagePath } = await tempImageRoot();
  const contract = {
    prompt: 'Consolidated multi-screen review',
    answers: { IMAGE_UX_REVIEW_SOURCE_IMAGES: [imagePath, imagePath] }
  };
  const inventory = await imageUx.hydrateImageUxScreenInventory(
    root,
    imageUx.buildImageUxScreenInventory(contract)
  );
  const ledger = imageUx.buildImageUxGeneratedReviewLedger(contract, inventory, {
    generated_review_images: [realGeneratedReviewImage({
      source_screen_ids: ['screen-1', 'screen-2']
    })]
  }, { root });

  assert.equal(ledger.generated_count, 1);
  assert.equal(ledger.real_generated_count, 1);
  assert.equal(ledger.covered_source_screen_count, 2);
  assert.deepEqual(ledger.covered_source_screen_ids, ['screen-1', 'screen-2']);
  assert.equal(ledger.passed, true);
});

test('generated callout image ledger blocks claimed real evidence when file evidence is unchecked', async () => {
  const imageUx = await importDist('core/image-ux-review.js');
  const { root, imagePath } = await tempImageRoot();
  const { contract, inventory } = await capturedInventory(imageUx, root, imagePath);
  const ledger = imageUx.buildImageUxGeneratedReviewLedger(contract, inventory, { generated_review_images: [realGeneratedReviewImage()] });
  assert.equal(ledger.real_generated_count, 0);
  assert.equal(ledger.passed, false);
  assert.equal(ledger.generated_review_images[0].file_evidence_checked, false);
  assert.ok(ledger.blockers.includes('generated_review_image_file_evidence_unchecked'));
});

test('source mjs generated image ledger matches strict file-evidence semantics', async () => {
  const imageUx = await import('../../dist/core/image-ux-review.js');
  const { root, imagePath } = await tempImageRoot();
  const contract = {
    prompt: 'UX-Review 1.0.8 source mjs fixture',
    answers: { IMAGE_UX_REVIEW_SOURCE_IMAGES: [imagePath] }
  };
  const inventory = imageUx.buildImageUxScreenInventory(contract);
  const unchecked = imageUx.buildImageUxGeneratedReviewLedger(contract, inventory, { generated_review_images: [realGeneratedReviewImage()] });
  const checked = imageUx.buildImageUxGeneratedReviewLedger(contract, inventory, { generated_review_images: [realGeneratedReviewImage()] }, { root });

  assert.equal(unchecked.real_generated_count, 0);
  assert.equal(unchecked.passed, false);
  assert.ok(unchecked.blockers.includes('generated_review_image_file_evidence_unchecked'));
  assert.equal(checked.real_generated_count, 1);
  assert.equal(checked.passed, true);
});
