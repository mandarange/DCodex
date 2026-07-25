#!/usr/bin/env node
// @ts-nocheck
import { emitGate, requireContains } from './real-execution-check-lib.js';

requireContains('ppt:real-imagegen-wiring', 'src/core/ppt-review/slide-imagegen-review.ts', [
  'generateGptImage2CalloutReview',
  'PPT_SLIDE_IMAGEGEN_REQUEST_ARTIFACT',
  'PPT_SLIDE_IMAGEGEN_RESPONSE_ARTIFACT',
  'buildSlideImagegenEvidence',
  'evidence_class',
  'output_sha256',
  'extraction_pending_count',
  'callout_extraction_status'
]);
requireContains('ppt:real-imagegen-wiring', 'src/core/ppt-review/index.ts', [
  'buildSlideImagegenRequestArtifact',
  'buildSlideImagegenResponseArtifact',
  'imagegen_evidence'
]);

emitGate('ppt:real-imagegen-wiring', { adapter: 'shared UX generateGptImage2CalloutReview' });
