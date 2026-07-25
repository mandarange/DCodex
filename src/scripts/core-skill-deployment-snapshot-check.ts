#!/usr/bin/env node
// @ts-nocheck
// GATE: core-skill:deployment-snapshot
// Proves deployed snapshots are immutable (a changed body needs a higher version),
// the previous snapshot is archived for rollback, rollback restores it, and only an
// accepted card may be promoted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const cardMod = await importDist('core/skills/core-skill-card.js');
const deployMod = await importDist('core/skills/core-skill-deployment.js');
const { createRequestedScopeContract } = await importDist('core/safety/requested-scope-contract.js');

const ROUTE = 'DFix';
const SKILL = 'demo-skill';
const BODY_V1 = '## Goal\nDo the task.\n\n## Verification\nCheck output.\n\n## Rollback\nRevert on failure.\n';
const BODY_V2 = '## Goal\nDo the task carefully.\n\n## Verification\nCheck output twice.\n\n## Rollback\nRevert on failure.\n';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-deploy-'));
const promotionContract = createRequestedScopeContract({
  route: 'core-skill-deployment-snapshot',
  userRequest: 'release gate fixture skill promotion',
  projectRoot: tempRoot,
  overrides: { skill_snapshot_promotion: true }
});

// 1) Promote an accepted card to a deployed snapshot.
const acceptedV1 = { ...cardMod.createCandidateCard({ skillId: SKILL, route: ROUTE, baseVersion: 0, body: BODY_V1 }), status: 'accepted' };
const promoteV1 = await deployMod.promoteToDeployedWithLedger(tempRoot, acceptedV1, { contract: promotionContract, context: 'release' });
assertGate(promoteV1.ok === true, 'promoting an accepted card must succeed', promoteV1);
assertGate(promoteV1.snapshot && promoteV1.snapshot.status === 'deployed' && promoteV1.snapshot.deployment_snapshot === true, 'snapshot must be deployed + flagged', promoteV1.snapshot);

// 2) Immutability: a changed body at version <= existing must be rejected.
const changedSameVersion = { ...cardMod.createCandidateCard({ skillId: SKILL, route: ROUTE, baseVersion: 0, body: BODY_V2 }), status: 'accepted' };
assertGate(changedSameVersion.version === acceptedV1.version, 'changed-body card must share the existing version for this check', { changed: changedSameVersion.version, existing: acceptedV1.version });
const promoteSame = await deployMod.promoteToDeployedWithLedger(tempRoot, changedSameVersion, { contract: promotionContract, context: 'release' });
assertGate(promoteSame.ok === false && promoteSame.blockers.includes('snapshot_changed_without_version_increment'), 'changed body without version bump must be rejected', promoteSame);

// 3) A changed body at a HIGHER version succeeds, archives the previous snapshot.
const acceptedV2 = { ...cardMod.createCandidateCard({ skillId: SKILL, route: ROUTE, baseVersion: 1, body: BODY_V2 }), status: 'accepted' };
assertGate(acceptedV2.version > acceptedV1.version, 'v2 must have a higher version than v1', { v2: acceptedV2.version, v1: acceptedV1.version });
const promoteV2 = await deployMod.promoteToDeployedWithLedger(tempRoot, acceptedV2, { contract: promotionContract, context: 'release' });
assertGate(promoteV2.ok === true, 'higher-version changed snapshot must promote', promoteV2);
assertGate(typeof promoteV2.archived_path === 'string' && promoteV2.archived_path.length > 0, 'previous snapshot must be archived', promoteV2);
const hasRollback = await deployMod.hasRollbackSnapshot(tempRoot, ROUTE, SKILL);
assertGate(hasRollback === true, 'a rollback snapshot must exist after a version bump', { hasRollback });

// 4) Rollback restores the previous (v1) snapshot.
const rolled = await deployMod.rollbackDeployment(tempRoot, ROUTE, SKILL);
assertGate(rolled.ok === true && rolled.restored_version === acceptedV1.version, 'rollback must restore the previous version', rolled);

// 5) Promotion requires accepted status.
const candidate = cardMod.createCandidateCard({ skillId: 'other-skill', route: ROUTE, baseVersion: 0, body: BODY_V1 });
const promoteCandidate = await deployMod.promoteToDeployedWithLedger(tempRoot, candidate, { contract: promotionContract, context: 'release' });
assertGate(promoteCandidate.ok === false && promoteCandidate.blockers.includes('promote_requires_accepted_status'), 'a candidate card must not be promotable', promoteCandidate);

fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.sneakoscope', 'reports', 'core-skill-deployment-snapshot-check.json'),
  `${JSON.stringify({ gate: 'core-skill:deployment-snapshot', restored_version: rolled.restored_version, archived_path: Boolean(promoteV2.archived_path) }, null, 2)}\n`
);
fs.rmSync(tempRoot, { recursive: true, force: true });

emitGate('core-skill:deployment-snapshot', { immutable_without_version_bump: true, archived_on_bump: true, rollback_restores_previous: rolled.restored_version === acceptedV1.version, promote_requires_accepted: true });
