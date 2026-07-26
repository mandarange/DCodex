import test from 'node:test';
import { sourceIncludes } from '../helpers/real-execution-closure.mjs';

test('ux-review run wires generate-callouts and fix to imagegen/extraction', () => {
  sourceIncludes('src/core/commands/image-ux-review-command.ts', [
    'shouldGenerateCallouts',
    'buildCalloutPrompt',
    'generateGptImage2CalloutReview',
    'extractRealCallouts',
    'extractAndWriteGeneratedReview',
    'imageUxReviewCommandOutcome',
    "allowReviewOnlyCompletion: !flag(args, '--fix')",
    'allowReviewOnlyCompletion: false',
    'buildImageUxCalloutExtractionReport'
  ]);
});
