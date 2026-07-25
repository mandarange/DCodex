#!/usr/bin/env node
// @ts-nocheck
// GATE: core-skill:card-schema
// Proves the Core Skill Card is read-only external state, that the checked-in
// schema matches the runtime contract, and that an optimizer candidate can never
// overwrite a deployed snapshot in place.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, root, readJson } from './gate-lib.js';

const cardMod = await importDist('core/skills/core-skill-card.js');
const typesMod = await importDist('core/skills/core-skill-types.js');
const deployMod = await importDist('core/skills/core-skill-deployment.js');
const { createRequestedScopeContract } = await importDist('core/safety/requested-scope-contract.js');

const BODY = '## Goal\nDo the task.\n\n## Verification\nCheck output.\n\n## Rollback\nRevert on failure.\n';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-card-schema-'));
const promotionContract = createRequestedScopeContract({
  route: 'core-skill-card-schema',
  userRequest: 'release gate fixture skill promotion',
  projectRoot: tempRoot,
  overrides: { skill_snapshot_promotion: true }
});

// 1) A fresh candidate is structurally valid and read-only.
const candidate = cardMod.createCandidateCard({ skillId: 'demo-skill', route: 'DFix', baseVersion: 0, body: BODY });
const shape = cardMod.validateCardShape(candidate);
assertGate(shape.ok, 'candidate card must pass validateCardShape', shape);
assertGate(candidate.status === 'candidate', 'fresh card status must be candidate', { status: candidate.status });
assertGate(candidate.deployment_snapshot === false, 'candidate must not be a deployment snapshot', candidate);
assertGate(candidate.side_effect_scope.read_only === true, 'candidate card must be read_only', candidate.side_effect_scope);
assertGate(candidate.side_effect_scope.allowed_mutations.length === 0, 'candidate card must grant zero mutations', candidate.side_effect_scope);

// 2) The checked-in schema parses and its const matches the runtime schema id.
const cardSchema = readJson('schemas/skills/core-skill-card.schema.json');
assertGate(cardSchema.properties?.schema?.const === typesMod.CORE_SKILL_CARD_SCHEMA, 'card schema const must match CORE_SKILL_CARD_SCHEMA', { const: cardSchema.properties?.schema?.const, expected: typesMod.CORE_SKILL_CARD_SCHEMA });

// 3) Negative invariants.
const notReadOnly = { ...candidate, side_effect_scope: { allowed_mutations: [], read_only: false } };
const notReadOnlyShape = cardMod.validateCardShape(notReadOnly);
assertGate(notReadOnlyShape.ok === false && notReadOnlyShape.blockers.includes('card_not_read_only'), 'read_only=false card must be blocked by card_not_read_only', notReadOnlyShape);

const grantsMutations = { ...candidate, side_effect_scope: { allowed_mutations: ['x'], read_only: true } };
const grantsShape = cardMod.validateCardShape(grantsMutations);
assertGate(grantsShape.ok === false && grantsShape.blockers.includes('card_grants_mutations'), 'allowed_mutations card must be blocked by card_grants_mutations', grantsShape);

const badDeployed = { ...candidate, status: 'deployed', deployment_snapshot: false };
const badDeployedShape = cardMod.validateCardShape(badDeployed);
assertGate(badDeployedShape.ok === false && badDeployedShape.blockers.includes('deployed_card_not_snapshot'), 'deployed card without snapshot flag must be blocked', badDeployedShape);

// 4) A deployed snapshot cannot be overwritten by an optimizer candidate.
//    The deployed snapshot lives in deployed.json; a candidate is a SEPARATE file.
const accepted = { ...candidate, status: 'accepted' };
const promotion = await deployMod.promoteToDeployedWithLedger(tempRoot, accepted, { contract: promotionContract, context: 'release' });
assertGate(promotion.ok === true, 'ledger promotion must succeed for an accepted card', promotion);

const deployedBefore = await cardMod.loadDeployedSnapshot(tempRoot, 'DFix', 'demo-skill');
assertGate(deployedBefore && deployedBefore.status === 'deployed' && deployedBefore.deployment_snapshot === true, 'loadDeployedSnapshot must return a deployed snapshot', deployedBefore);

// Saving a candidate with the same skill_id must NOT touch deployed.json.
const sneakyCandidate = cardMod.createCandidateCard({ skillId: 'demo-skill', route: 'DFix', baseVersion: 9, body: '## Goal\nOverwrite me.\n' });
await cardMod.saveCard(tempRoot, sneakyCandidate);
const deployedAfter = await cardMod.loadDeployedSnapshot(tempRoot, 'DFix', 'demo-skill');
assertGate(deployedAfter && deployedAfter.status === 'deployed' && deployedAfter.deployment_snapshot === true, 'deployed snapshot must remain deployed after saving a candidate', deployedAfter);
assertGate(deployedAfter.body === deployedBefore.body, 'deployed snapshot body must be unchanged by candidate save', { before: deployedBefore.body, after: deployedAfter.body });

fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.sneakoscope', 'reports', 'core-skill-card-schema-check.json'),
  `${JSON.stringify({ gate: 'core-skill:card-schema', candidate_ok: shape.ok, schema_const: cardSchema.properties?.schema?.const, deployed_protected: deployedAfter.body === deployedBefore.body }, null, 2)}\n`
);
fs.rmSync(tempRoot, { recursive: true, force: true });

emitGate('core-skill:card-schema', { candidate_read_only: true, schema_const: cardSchema.properties?.schema?.const, deployed_snapshot_immutable: true });
