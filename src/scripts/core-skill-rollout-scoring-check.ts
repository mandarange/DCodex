#!/usr/bin/env node
// @ts-nocheck
// GATE: core-skill:rollout-scoring
// Proves the rollout scorer rewards proof + zero side effects, treats a
// requested-scope/side-effect violation as a hard fail, and persists a score report.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, root, exists } from './gate-lib.js';

const traceMod = await importDist('core/skills/core-rollout-trace.js');
const scorerMod = await importDist('core/skills/core-skill-scorer.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-rollout-score-'));

// 1) Clean rollout: proof present, no side effects, rollback ready, scope compliant.
const cleanTrace = traceMod.createRolloutTrace({
  route: 'DFix',
  backend: 'fake',
  prompt: 'fix the bug',
  proof_artifacts: ['p.json'],
  side_effect_ledger: [],
  rollback_ready: true,
  requested_scope_compliant: true,
  latency_ms: 1000,
  failure_reason: null
});
const cleanScore = scorerMod.scoreRollout(cleanTrace);
assertGate(cleanScore.score > 0, 'clean rollout score must be positive', cleanScore);
assertGate(cleanScore.side_effect_violation === false, 'clean rollout must not be a side-effect violation', cleanScore);
assertGate(cleanScore.components.proof_completeness === 1, 'clean rollout proof_completeness must be 1', cleanScore.components);
assertGate(cleanScore.components.side_effect_zero === 1, 'clean rollout side_effect_zero must be 1', cleanScore.components);

// 2) Side-effect violation: out-of-scope global write is a HARD fail.
const violationTrace = traceMod.createRolloutTrace({
  route: 'DFix',
  backend: 'fake',
  prompt: 'fix the bug',
  proof_artifacts: ['p.json'],
  side_effect_ledger: ['global_config_write'],
  rollback_ready: true,
  requested_scope_compliant: false,
  latency_ms: 1000,
  failure_reason: null
});
const violationScore = scorerMod.scoreRollout(violationTrace);
assertGate(violationScore.side_effect_violation === true, 'out-of-scope rollout must flag side_effect_violation', violationScore);
assertGate(violationScore.score < 0, 'side-effect violation must drive score negative (hard fail)', violationScore);

// 3) Proof-less success scores lower (proof_completeness 0).
const prooflessTrace = traceMod.createRolloutTrace({
  route: 'DFix',
  backend: 'fake',
  prompt: 'fix the bug',
  proof_artifacts: [],
  side_effect_ledger: [],
  rollback_ready: true,
  requested_scope_compliant: true,
  latency_ms: 1000,
  failure_reason: null
});
const prooflessScore = scorerMod.scoreRollout(prooflessTrace);
assertGate(prooflessScore.components.proof_completeness === 0, 'proof-less rollout proof_completeness must be 0', prooflessScore.components);
assertGate(prooflessScore.score < cleanScore.score, 'proof-less rollout must score lower than clean rollout', { proofless: prooflessScore.score, clean: cleanScore.score });

// 4) Baseline vs candidate aggregate comparison.
const cleanAgg = scorerMod.scoreRollouts([cleanTrace]);
const prooflessAgg = scorerMod.scoreRollouts([prooflessTrace]);
assertGate(cleanAgg.score > prooflessAgg.score, 'aggregate clean score must beat aggregate proof-less score', { clean: cleanAgg.score, proofless: prooflessAgg.score });

// 5) Persist the score report and confirm the artifact exists under a temp root.
const writtenPath = await scorerMod.writeRolloutScore(tempRoot, cleanScore);
assertGate(fs.existsSync(writtenPath), 'writeRolloutScore must create the report file', { writtenPath });
assertGate(fs.existsSync(path.join(tempRoot, '.sneakoscope', 'reports', 'core-skill-rollout-score.json')), 'report must live at .sneakoscope/reports/core-skill-rollout-score.json', { tempRoot });

fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.sneakoscope', 'reports', 'core-skill-rollout-scoring-check.json'),
  `${JSON.stringify({ gate: 'core-skill:rollout-scoring', clean_score: cleanScore.score, violation_score: violationScore.score, proofless_score: prooflessScore.score }, null, 2)}\n`
);
fs.rmSync(tempRoot, { recursive: true, force: true });

emitGate('core-skill:rollout-scoring', { clean_score: cleanScore.score, violation_hard_fail: violationScore.score < 0, proofless_lower: prooflessScore.score < cleanScore.score, report_written: exists('.sneakoscope/reports/core-skill-rollout-scoring-check.json') });
