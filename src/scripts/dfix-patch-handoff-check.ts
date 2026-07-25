#!/usr/bin/env node
// @ts-nocheck
import { emitGate, requireContains } from './real-execution-check-lib.js';

requireContains('dfix:patch-handoff', 'src/core/dfix.ts', [
  'codex_patch_handoff',
  'buildDfixCodexPatchPrompt',
  'git_diff_before',
  'git_diff_after',
  'rollback_plan',
  'explicit_apply_opt_in'
]);

emitGate('dfix:patch-handoff', { patch_mode: 'exact-find-replace-or-codex-handoff', diff_capture: true });
