#!/usr/bin/env node
// @ts-nocheck
// GATE: core-skill:no-inference-optimizer
// Proves the optimizer NEVER runs in deployment/inference context: deployed-snapshot
// reads are allowed and carry route proof (skill id/version/hash), while any
// optimizer/epoch call throws a SkillDeploymentViolationError. Out of context the
// optimizer works normally.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const cardMod = await importDist('core/skills/core-skill-card.js');
const runtimeMod = await importDist('core/skills/core-skill-runtime.js');
const deployMod = await importDist('core/skills/core-skill-deployment.js');
const epochMod = await importDist('core/skills/core-skill-epoch.js');
const traceMod = await importDist('core/skills/core-rollout-trace.js');

const BODY = '## Goal\nDo the task.\n\n## Verification\nCheck output.\n\n## Rollback\nRevert on failure.\n';
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-no-opt-'));

const card = cardMod.createCandidateCard({ skillId: 'x', route: 'DFix', baseVersion: 0, body: BODY });
const trace = traceMod.createRolloutTrace({ route: 'DFix', backend: 'fake', proof_artifacts: [], rollback_ready: false, requested_scope_compliant: true, latency_ms: 1000, failure_reason: null });

// Enter deployment / inference context.
deployMod.setDeploymentContext(true);
process.env.SKS_SKILL_DEPLOYMENT_CONTEXT = '1';
assertGate(deployMod.isDeploymentContext() === true, 'deployment context must be active', { active: deployMod.isDeploymentContext() });

// 1) Deployment reads are allowed and never throw.
let selection = null;
let readThrew = false;
try {
  await cardMod.loadDeployedSnapshot(tempRoot, 'DFix', 'x');
  selection = await runtimeMod.selectRouteSkill(tempRoot, 'DFix', 'x');
} catch {
  readThrew = true;
}
assertGate(readThrew === false, 'deployment-path reads must not throw in deployment context', { readThrew });
assertGate(selection !== null, 'selectRouteSkill must return a selection', { selection });
assertGate(selection.source === 'fallback' || selection.source === 'deployed', 'selection source must be fallback or deployed', selection);

// 2) Route proof record: no optimizer invocation, and skill id/version/hash keys present (Task 4.7).
const proof = runtimeMod.skillProofRecord(selection);
assertGate(proof.optimizer_invoked === false, 'route proof must show optimizer was not invoked', proof);
assertGate('skill_id' in proof && 'version' in proof && 'hash' in proof, 'route proof must include skill_id/version/hash keys', proof);

// 3) Optimizer calls are forbidden in deployment context.
let proposeThrew = null;
try {
  epochMod.proposeSkillPatch(card, [trace]);
} catch (err) {
  proposeThrew = err;
}
assertGate(proposeThrew !== null && proposeThrew.name === 'SkillDeploymentViolationError', 'proposeSkillPatch must throw SkillDeploymentViolationError in deployment context', { name: proposeThrew?.name });

let epochThrew = null;
try {
  await epochMod.runSkillEpoch(tempRoot, { card, trainTraces: [trace], validation: { baselineHeldout: 0.5, candidateHeldout: 0.6, sideEffectZero: true, requestedScopeCompliant: true, proofCompletenessBaseline: 0, proofCompletenessCandidate: 1, rollbackReadyBaseline: 0, rollbackReadyCandidate: 1, latencyBaselineMs: 1000, latencyCandidateMs: 1000 } });
} catch (err) {
  epochThrew = err;
}
assertGate(epochThrew !== null && epochThrew.name === 'SkillDeploymentViolationError', 'runSkillEpoch must throw SkillDeploymentViolationError in deployment context', { name: epochThrew?.name });

// 4) Reset: out of deployment context the optimizer works (does not throw).
deployMod.setDeploymentContext(false);
delete process.env.SKS_SKILL_DEPLOYMENT_CONTEXT;
assertGate(deployMod.isDeploymentContext() === false, 'deployment context must be cleared', { active: deployMod.isDeploymentContext() });
let proposeOk = true;
try {
  epochMod.proposeSkillPatch(card, [trace]);
} catch {
  proposeOk = false;
}
assertGate(proposeOk === true, 'proposeSkillPatch must not throw out of deployment context', { proposeOk });

fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.sneakoscope', 'reports', 'core-skill-no-inference-optimizer-check.json'),
  `${JSON.stringify({ gate: 'core-skill:no-inference-optimizer', source: selection.source, optimizer_invoked: proof.optimizer_invoked, proof_keys: Object.keys(proof) }, null, 2)}\n`
);
fs.rmSync(tempRoot, { recursive: true, force: true });

emitGate('core-skill:no-inference-optimizer', { deployment_read_allowed: true, optimizer_forbidden_in_deployment: true, route_proof_has_id_version_hash: 'skill_id' in proof && 'version' in proof && 'hash' in proof, optimizer_runs_out_of_context: proposeOk });
