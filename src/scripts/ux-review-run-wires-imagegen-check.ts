#!/usr/bin/env node
// @ts-nocheck
import { emitGate, requireContains } from './real-execution-check-lib.js';

requireContains('ux-review:run-wires-imagegen', 'src/core/commands/image-ux-review-command.ts', [
  'const shouldGenerateCallouts = flag(args, \'--generate-callouts\') || flag(args, \'--fix\')',
  'requireCodexImagegen',
  'generateGptImage2CalloutReview',
  'evidence_class',
  'output_sha256',
  // The evidence taxonomy lives in imagegen-evidence.ts; the route must consult
  // it rather than restating which classes count.
  'imagegenEvidenceClassBlockers',
  'isFullImagegenOutputSource',
  'extractRealCallouts',
  'buildImageUxCalloutExtractionReport'
]);

requireContains('ux-review:run-wires-imagegen', 'src/core/imagegen/imagegen-evidence.ts', [
  '_non_codex_api_fallback_not_full_evidence',
  '_mock_fixture_not_full_evidence',
  'CODEX_LB_PROVIDER_IMAGEGEN_EVIDENCE_CLASS',
  'FULL_IMAGEGEN_EVIDENCE_CLASSES'
]);

emitGate('ux-review:run-wires-imagegen', { command_path: 'sks ux-review run', imagegen_adapter: 'generateGptImage2CalloutReview' });
