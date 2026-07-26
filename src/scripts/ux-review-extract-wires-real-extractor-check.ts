#!/usr/bin/env node
// @ts-nocheck
import { emitGate, requireContains } from './real-execution-check-lib.js';

requireContains('ux-review:extract-wires-real-extractor', 'src/core/commands/image-ux-review-command.ts', [
  'extractIssuesImageUxReview',
  'extractRealCallouts',
  'IMAGE_UX_REVIEW_CALLOUT_EXTRACTION_REPORT_ARTIFACT'
]);
requireContains('ux-review:extract-wires-real-extractor', 'src/core/image-ux-review.ts', [
  'sks.image-ux-callout-extraction-report.v1',
  'bbox_validation_issues',
  'verified_cap'
]);

emitGate('ux-review:extract-wires-real-extractor', { artifact: 'image-ux-callout-extraction-report.json' });
