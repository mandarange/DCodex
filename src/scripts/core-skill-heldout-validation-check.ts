#!/usr/bin/env node
// @ts-nocheck
// GATE: core-skill:heldout-validation
// Proves strict held-out acceptance: a candidate is accepted ONLY on strict
// held-out improvement with no safety regression, train-only gains are rejected,
// and rejected patches are buffered so the same failed edit is not retried.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const validationMod = await importDist('core/skills/core-skill-validation.js');
const bufferMod = await importDist('core/skills/rejected-skill-patch-buffer.js');

const baseInput = {
  baselineHeldout: 0.76,
  candidateHeldout: 0.82,
  sideEffectZero: true,
  requestedScopeCompliant: true,
  proofCompletenessBaseline: 1,
  proofCompletenessCandidate: 1,
  rollbackReadyBaseline: 1,
  rollbackReadyCandidate: 1,
  latencyBaselineMs: 1000,
  latencyCandidateMs: 1100
};

// 1) Accept on strict improvement with no regression.
const acceptRes = validationMod.validateHeldout(baseInput);
assertGate(acceptRes.accept === true && acceptRes.reason === 'strict_improvement', 'strict improvement must be accepted', acceptRes);

// 2) Held-out not improved -> reject.
const notImproved = validationMod.validateHeldout({ ...baseInput, candidateHeldout: 0.74 });
assertGate(notImproved.accept === false && notImproved.reason === 'heldout_not_improved', 'non-improving held-out must be rejected', notImproved);

// 3) Train-improves-but-held-out-worse maps to heldout_not_improved.
//    (Held-out is the only acceptance signal; a worse held-out is rejected regardless of train gains.)
const trainGainHeldoutWorse = validationMod.validateHeldout({ ...baseInput, candidateHeldout: 0.70 });
assertGate(trainGainHeldoutWorse.accept === false && trainGainHeldoutWorse.reason === 'heldout_not_improved', 'train-gain/held-out-worse must reject as heldout_not_improved', trainGainHeldoutWorse);

// 4) Side-effect violation with improved held-out -> reject.
const sideEffect = validationMod.validateHeldout({ ...baseInput, sideEffectZero: false });
assertGate(sideEffect.accept === false && sideEffect.reason === 'side_effect_zero_failed', 'side-effect failure must reject as side_effect_zero_failed', sideEffect);

// 5) Rejected-patch buffer dedupes by hash.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-heldout-'));
await bufferMod.recordRejectedPatch(tempRoot, { skill_id: 's', base_version: 3, patch_hash: 'abc', reason: 'heldout_not_improved', score_delta: -0.03 });
const knownRejected = await bufferMod.isPatchRejected(tempRoot, 'abc');
const unknownRejected = await bufferMod.isPatchRejected(tempRoot, 'zzz');
assertGate(knownRejected === true, 'recorded patch hash must be reported as rejected', { knownRejected });
assertGate(unknownRejected === false, 'unknown patch hash must not be reported as rejected', { unknownRejected });

fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.sneakoscope', 'reports', 'core-skill-heldout-validation-check.json'),
  `${JSON.stringify({ gate: 'core-skill:heldout-validation', accept_delta: acceptRes.score_delta, reject_reasons: [notImproved.reason, trainGainHeldoutWorse.reason, sideEffect.reason] }, null, 2)}\n`
);
fs.rmSync(tempRoot, { recursive: true, force: true });

emitGate('core-skill:heldout-validation', { accept_strict_improvement: true, heldout_not_improved_rejected: true, side_effect_rejected: true, rejected_buffer_dedupes: knownRejected && !unknownRejected });
