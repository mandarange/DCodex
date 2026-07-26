import test from 'node:test';
import { sourceIncludes } from '../helpers/real-execution-closure.mjs';

test('ux-review extract-issues invokes the real callout extractor', () => {
  sourceIncludes('src/core/commands/image-ux-review-command.ts', [
    'extractIssuesImageUxReview',
    'extractRealCallouts',
    'continueExistingMissionWithGeneratedImage',
    'IMAGE_UX_REVIEW_CALLOUT_EXTRACTION_REPORT_ARTIFACT'
  ]);
});
