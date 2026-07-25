#!/usr/bin/env node
// @ts-nocheck
import { emitGate, requireContains } from './real-execution-check-lib.js';

requireContains('ux-review:run-wires-imagegen', 'src/core/commands/image-ux-review-command.ts', [
  'const shouldGenerateCallouts = flag(args, \'--generate-callouts\') || flag(args, \'--fix\')',
  'requireCodexImagegen',
  'generateGptImage2CalloutReview',
  'evidence_class',
  'output_sha256',
  'imagegen_response_non_codex_api_fallback_not_full_evidence',
  'extractRealCallouts',
  'buildImageUxCalloutExtractionReport'
]);

emitGate('ux-review:run-wires-imagegen', { command_path: 'sks ux-review run', imagegen_adapter: 'generateGptImage2CalloutReview' });
