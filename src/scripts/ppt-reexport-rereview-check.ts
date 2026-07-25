#!/usr/bin/env node
// @ts-nocheck
import { emitGate, requireContains } from './real-execution-check-lib.js';

requireContains('ppt:reexport-rereview', 'src/core/commands/ppt-command.ts', [
  'attach-fixed-deck',
  'fixedDeckPath',
  'recheck'
]);
requireContains('ppt:reexport-rereview', 'src/core/ppt-review/index.ts', [
  'changed_slides_rechecked',
  'ppt_slide_recheck_missing',
  'fixedDeckPath'
]);
requireContains('ppt:reexport-rereview', 'src/core/ppt-review/ppt-patch-handoff.ts', [
  'deck_binary_edit_unavailable_manual_handoff_required',
  're_export_required'
]);

emitGate('ppt:reexport-rereview', { recheck: 'fixed-deck-or-slide-evidence-required' });
