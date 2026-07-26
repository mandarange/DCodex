import test from 'node:test';
import { sourceIncludes } from '../helpers/real-execution-closure.mjs';

test('ux-review extraction report records provider, hashes, validation, bbox, and cap', () => {
  sourceIncludes('src/core/image-ux-review.ts', [
    'sks.image-ux-callout-extraction-report.v1',
    "analysis_input: 'generated_annotated_review_image'",
    'source_screenshot_used_for_extraction: false',
    'generated_image_sha256',
    'source_screenshot_sha256',
    'bbox_validation_issues',
    'verified_cap'
  ]);
});
