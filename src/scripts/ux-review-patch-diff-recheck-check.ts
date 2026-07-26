#!/usr/bin/env node
// @ts-nocheck
import { emitGate, requireContains } from './real-execution-check-lib.js';

requireContains('ux-review:patch-diff-recheck', 'src/core/image-ux-review/fix-loop.ts', [
  'changed_files',
  'recapture_required',
  'no_op_patch_wrongness',
  'regression'
]);
requireContains('ux-review:patch-diff-recheck', 'src/core/image-ux-review/patch-handoff.ts', [
  'explicit_apply_opt_in',
  'dry_run',
  'recapture_required'
]);
requireContains('ux-review:patch-diff-recheck', 'src/core/commands/image-ux-review-command.ts', [
  'attachAfterImageCommand',
  'recheck'
]);

emitGate('ux-review:patch-diff-recheck', { patch_handoff: 'dry-run-by-default', recapture: 'required-after-change' });
