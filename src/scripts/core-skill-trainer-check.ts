#!/usr/bin/env node
// @ts-nocheck
// GATE: core-skill:trainer-loop
// Proves the SkillOpt training loop (rollout → reflect → aggregate → select →
// strict held-out gate → meta-update): a deficient rollout batch yields an
// accepted bounded edit, lessons already covered yield no proposal, a
// non-improving evaluator is rejected and decays the textual learning rate,
// meta-update is clamped to [min, default], and the loop is forbidden in a
// deployment context. The best held-out card is exported as best-skill.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const trainerMod = await importDist('core/skills/core-skill-trainer.js');
const metaMod = await importDist('core/skills/core-skill-meta-update.js');
const reflectionMod = await importDist('core/skills/core-skill-reflection.js');
const cardMod = await importDist('core/skills/core-skill-card.js');
const deploymentMod = await importDist('core/skills/core-skill-deployment.js');
const epochMod = await importDist('core/skills/core-skill-epoch.js');
const typesMod = await importDist('core/skills/core-skill-types.js');

const baseCard = cardMod.createCandidateCard({
  skillId: 'trainer-fixture',
  route: 'naruto',
  baseVersion: 0,
  body: '# Skill\n\n## method\n- Do the task.\n'
});

const deficientTrace = {
  schema: typesMod.CORE_ROLLOUT_TRACE_SCHEMA,
  route: 'naruto',
  prompt: 'fixture',
  skill_id: baseCard.skill_id,
  skill_version: baseCard.version,
  backend: 'fake',
  proof_artifacts: [],
  gate_results: [],
  side_effect_ledger: [],
  latency_ms: 100,
  failure_reason: null,
  rollback_ready: false,
  requested_scope_compliant: true
};

// 1) Reflection: a proof-less, rollback-weak rollout yields both deficiency dimensions.
const reflections = reflectionMod.reflectOnTrace(deficientTrace);
const dims = reflections.map((r) => r.dimension);
assertGate(dims.includes('proof_completeness') && dims.includes('rollback_ready'), 'reflection must flag proof and rollback deficiencies', dims);

// 2) Selection skips lessons the card already covers.
const coveredCard = { ...baseCard, body: `${baseCard.body}\n- Always emit a proof artifact before reporting success.\n- Record a rollback-ready checkpoint before mutating anything.\n` };
const coveredOps = reflectionMod.selectPatchOperations(coveredCard, reflectionMod.aggregateReflections(reflections), epochMod.DEFAULT_TEXTUAL_LEARNING_RATE);
assertGate(coveredOps.length === 0, 'covered lessons must not be re-proposed', coveredOps);

// 3) Training run with an improving held-out evaluator: epoch 0 accepts, epoch 1 has nothing left to propose.
const improvingEvaluator = (card) => ({
  heldout: 0.5 + (/proof artifact/i.test(card.body) ? 0.2 : 0) + (/rollback/i.test(card.body) ? 0.1 : 0),
  sideEffectZero: true,
  requestedScopeCompliant: true,
  proofCompleteness: 1,
  rollbackReady: 1,
  latencyMs: 1000
});
const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-trainer-a-'));
const runA = await trainerMod.trainSkill(rootA, {
  card: baseCard,
  epochs: [[deficientTrace], [deficientTrace]],
  evaluateHeldout: improvingEvaluator
});
assertGate(runA.epochs[0].accepted === true && runA.epochs[0].reason === 'strict_improvement', 'deficient batch with improving held-out must be accepted', runA.epochs[0]);
assertGate(runA.epochs[1].accepted === false && runA.epochs[1].reason === 'no_proposal', 'epoch after all lessons applied must yield no_proposal', runA.epochs[1]);
assertGate(runA.accepted_count === 1 && runA.best_heldout > runA.baseline_heldout, 'best held-out must strictly improve over baseline', runA);
assertGate(runA.best.version > baseCard.version, 'accepted training must bump the skill version', { best: runA.best.version, base: baseCard.version });
assertGate(fs.existsSync(runA.report_path) && fs.existsSync(runA.best_skill_path), 'training report and best-skill artifact must exist', runA);
const report = JSON.parse(fs.readFileSync(runA.report_path, 'utf8'));
assertGate(report.schema === trainerMod.CORE_SKILL_TRAINING_REPORT_SCHEMA && report.accepted_count === 1, 'training report schema/accepted_count must match', report);

// 4) Non-improving evaluator: rejected as heldout_not_improved and the learning rate decays epoch-wise.
const flatEvaluator = () => ({ heldout: 0.5, sideEffectZero: true, requestedScopeCompliant: true, proofCompleteness: 1, rollbackReady: 1, latencyMs: 1000 });
const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-trainer-b-'));
const runB = await trainerMod.trainSkill(rootB, {
  card: baseCard,
  epochs: [[deficientTrace], [deficientTrace]],
  evaluateHeldout: flatEvaluator
});
assertGate(runB.epochs[0].accepted === false && runB.epochs[0].reason === 'heldout_not_improved', 'flat held-out must be rejected', runB.epochs[0]);
assertGate(runB.epochs[1].learning_rate.max_added_chars === Math.round(epochMod.DEFAULT_TEXTUAL_LEARNING_RATE.max_added_chars * metaMod.META_UPDATE_DECAY), 'rejection must decay the textual learning rate for the next epoch', runB.epochs[1]);
assertGate(runB.accepted_count === 0 && runB.best.version === baseCard.version, 'no acceptance must leave the base card as best', runB);

// 5) Meta-update clamps: repeated decay floors at MIN; growth caps at DEFAULT.
let rate = { ...epochMod.DEFAULT_TEXTUAL_LEARNING_RATE };
for (let i = 0; i < 10; i += 1) rate = metaMod.metaUpdateLearningRate(rate, 'rejected');
assertGate(rate.max_added_chars === metaMod.MIN_TEXTUAL_LEARNING_RATE.max_added_chars, 'repeated decay must floor at MIN_TEXTUAL_LEARNING_RATE', rate);
for (let i = 0; i < 10; i += 1) rate = metaMod.metaUpdateLearningRate(rate, 'accepted');
assertGate(rate.max_added_chars === epochMod.DEFAULT_TEXTUAL_LEARNING_RATE.max_added_chars, 'repeated growth must cap at DEFAULT_TEXTUAL_LEARNING_RATE', rate);

// 6) The trainer is forbidden in a deployment context.
deploymentMod.setDeploymentContext(true);
let deploymentBlocked = false;
try {
  await trainerMod.trainSkill(rootA, { card: baseCard, epochs: [[deficientTrace]], evaluateHeldout: improvingEvaluator });
} catch (err) {
  deploymentBlocked = err instanceof deploymentMod.SkillDeploymentViolationError || /deployment/i.test(String(err?.message));
} finally {
  deploymentMod.setDeploymentContext(false);
}
assertGate(deploymentBlocked, 'trainSkill must throw in deployment context', { deploymentBlocked });

fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.sneakoscope', 'reports', 'core-skill-trainer-check.json'),
  `${JSON.stringify({ gate: 'core-skill:trainer-loop', accepted_epoch_reason: runA.epochs[0].reason, exhausted_reason: runA.epochs[1].reason, rejected_reason: runB.epochs[0].reason, decayed_max_added_chars: runB.epochs[1].learning_rate.max_added_chars, deployment_blocked: deploymentBlocked }, null, 2)}\n`
);
fs.rmSync(rootA, { recursive: true, force: true });
fs.rmSync(rootB, { recursive: true, force: true });

emitGate('core-skill:trainer-loop', {
  reflect_aggregate_select: true,
  strict_heldout_acceptance: runA.epochs[0].accepted,
  no_proposal_when_covered: runA.epochs[1].reason === 'no_proposal',
  rejection_decays_learning_rate: true,
  meta_update_clamped: true,
  deployment_blocked: deploymentBlocked
});
