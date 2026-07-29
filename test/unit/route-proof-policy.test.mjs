import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProofRoute,
  routeRequiresCompletionProof,
  routeRequiresImageVoxelAnchors
} from '../../dist/core/proof/route-proof-policy.js';

test('route proof policy normalizes serious and visual aliases', () => {
  assert.equal(normalizeProofRoute('qa-loop'), '$QA-LOOP');
  assert.equal(normalizeProofRoute('visual-review'), '$Image-UX-Review');
  assert.equal(normalizeProofRoute('$UX-Review'), '$Image-UX-Review');
  assert.equal(normalizeProofRoute('$sks-ux-review'), '$Image-UX-Review');
  assert.equal(normalizeProofRoute('$UI-UX-Review'), '$Image-UX-Review');
  assert.equal(normalizeProofRoute('$Work'), '$Naruto');
  assert.equal(normalizeProofRoute('$sks-work'), '$Naruto');
  assert.equal(normalizeProofRoute('$sks-naruto'), '$Naruto');
  assert.equal(normalizeProofRoute('$Agent'), null);
  assert.equal(normalizeProofRoute('$Team'), null);
  assert.equal(normalizeProofRoute('$MAD-DB'), null);
  assert.equal(normalizeProofRoute('$Swarm'), null);
  assert.equal(normalizeProofRoute('$ShadowClone'), null);
  assert.equal(normalizeProofRoute('$Kagebunshin'), null);
  assert.equal(normalizeProofRoute('$SEO-GEO-OPTIMIZER'), '$SEO-GEO-OPTIMIZER');
  assert.equal(normalizeProofRoute('seo-geo-optimizer'), '$SEO-GEO-OPTIMIZER');
  assert.equal(normalizeProofRoute('$SKS'), '$SKS');
  assert.equal(normalizeProofRoute('$Doctor'), '$Doctor');
  assert.equal(routeRequiresCompletionProof('$Naruto'), true);
  assert.equal(routeRequiresCompletionProof('$SEO-GEO-OPTIMIZER'), true);
  assert.equal(routeRequiresCompletionProof('seo-geo-optimizer'), true);
  assert.equal(routeRequiresCompletionProof('$Work'), true);
  assert.equal(routeRequiresCompletionProof('$sks-naruto'), true);
  assert.equal(routeRequiresCompletionProof('$Team'), false);
  assert.equal(routeRequiresCompletionProof('$Commit'), false);
  assert.equal(routeRequiresImageVoxelAnchors('$Computer-Use'), true);
  assert.equal(routeRequiresImageVoxelAnchors('$sks-computer-use'), true);
  assert.equal(routeRequiresImageVoxelAnchors('$DB'), false);
});
