#!/usr/bin/env node
// @ts-nocheck
// core-skill:route-runtime-integration (1.20.2 Area 3.1).
//
// Proves the route runtime reads the deployed Core Skill snapshot and records it
// in proof: (1) selectRouteSkill returns source:'deployed' + optimizer_invoked:false
// for a deployed snapshot, (2) a missing snapshot is a graceful 'fallback' with a
// warning (route still runs), and (3) the agent-proof-evidence builder emits the
// selected_core_skill field.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const { createCandidateCard, routeSkillId } = await importDist('core/skills/core-skill-card.js');
const { promoteToDeployedWithLedger } = await importDist('core/skills/core-skill-deployment.js');
const { selectRouteSkill, skillProofRecord } = await importDist('core/skills/core-skill-runtime.js');
const { createRequestedScopeContract } = await importDist('core/safety/requested-scope-contract.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-skill-rt-'));
const route = '$Naruto';
const skillId = routeSkillId(route);
const promotionContract = createRequestedScopeContract({
  route: 'core-skill-route-runtime-integration',
  userRequest: 'release gate fixture skill promotion',
  projectRoot: root,
  overrides: { skill_snapshot_promotion: true }
});

// Missing snapshot → graceful fallback.
const missing = await selectRouteSkill(root, route, skillId);
assertGate(missing.source === 'fallback', 'missing snapshot must be a graceful fallback', { missing });
assertGate(typeof missing.warning === 'string' && missing.warning.length > 0, 'missing snapshot must carry a warning', { missing });

// Deploy a snapshot, then select it.
const candidate = createCandidateCard({ skillId, route, baseVersion: 0, body: 'Route skill body.' });
const accepted = { ...candidate, status: 'accepted' };
const promoted = await promoteToDeployedWithLedger(root, accepted, { contract: promotionContract, context: 'release' });
assertGate(promoted.ok === true, 'ledger promotion must succeed', { promoted });

const selection = await selectRouteSkill(root, route, skillId);
assertGate(selection.source === 'deployed', 'deployed snapshot must be selected', { selection });
assertGate(typeof selection.instruction === 'string', 'deployed selection must carry an instruction fragment', { selection });

const proof = skillProofRecord(selection);
assertGate(proof.optimizer_invoked === false, 'route skill selection must never invoke the optimizer', { proof });
assertGate(proof.skill_id === skillId && typeof proof.hash === 'string', 'proof record must carry skill_id + hash', { proof });

// The agent-proof-evidence builder must surface a selected_core_skill field.
const evidenceSource = fs.readFileSync(path.join(process.cwd(), 'src/core/agents/agent-proof-evidence.ts'), 'utf8');
assertGate(/selected_core_skill\s*:/.test(evidenceSource), 'agent-proof-evidence must emit selected_core_skill', {});
const orchestratorSource = fs.readFileSync(path.join(process.cwd(), 'src/core/agents/agent-orchestrator.ts'), 'utf8');
assertGate(/selectRouteSkill\(/.test(orchestratorSource) && /selectedCoreSkill/.test(orchestratorSource), 'orchestrator must wire selectRouteSkill into the proof', {});

fs.rmSync(root, { recursive: true, force: true });
emitGate('core-skill:route-runtime-integration', { route, skill_id: skillId, deployed_selected: true, fallback_graceful: true });
