#!/usr/bin/env node
// @ts-nocheck
// core-skill:promotion-side-effect-ledger (1.20.2 Area 3.3).
//
// Proves release-owned skill snapshot promotion is recorded in the mutation
// ledger as a 'skill_snapshot_promotion' entry with a backup/rollback pointer,
// and that ledger write failure blocks deployment instead of succeeding.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const { createCandidateCard, routeSkillId } = await importDist('core/skills/core-skill-card.js');
const { promoteToDeployedWithLedger, promoteToDeployedLegacyForCompatibility } = await importDist('core/skills/core-skill-deployment.js');
const { createRequestedScopeContract } = await importDist('core/safety/requested-scope-contract.js');
const { mutationLedgerPath } = await importDist('core/safety/mutation-ledger.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-skill-promo-'));
const route = '$DFix';
const skillId = routeSkillId(route);
const contract = createRequestedScopeContract({
  route: 'skill-promotion', userRequest: 'deploy accepted skill', projectRoot: root,
  overrides: { skill_snapshot_promotion: true }
});

// First deploy (no previous snapshot → no backup, uses no_op reason).
const c1 = { ...createCandidateCard({ skillId, route, baseVersion: 0, body: 'v1 body' }), status: 'accepted' };
const p1 = await promoteToDeployedWithLedger(root, c1, { contract, context: 'release' });
assertGate(p1.ok === true, 'first promotion must succeed', { p1 });

// Second deploy (higher version) → archives previous as the rollback pointer.
const c2 = { ...createCandidateCard({ skillId, route, baseVersion: 1, body: 'v2 body' }), status: 'accepted' };
const p2 = await promoteToDeployedWithLedger(root, c2, { contract, context: 'release' });
assertGate(p2.ok === true, 'second promotion must succeed', { p2 });
assertGate(typeof p2.archived_path === 'string' && p2.archived_path.length > 0, 'second promotion must produce a rollback pointer (archived_path)', { p2 });

// Ledger must contain skill_snapshot_promotion entries, none in violation, the
// versioned one carrying the archived backup_path.
const ledgerText = fs.readFileSync(mutationLedgerPath(root), 'utf8');
const entries = ledgerText.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const promotions = entries.filter((e) => e.kind === 'skill_snapshot_promotion');
assertGate(promotions.length >= 2, 'each promotion must be recorded in the mutation ledger', { count: promotions.length });
assertGate(promotions.every((e) => e.violation === false), 'in-scope confirmed promotions must not be violations', { promotions });
assertGate(promotions.some((e) => e.backup_path && /deployed-history/.test(String(e.backup_path))), 'a promotion entry must reference the archived rollback pointer', { promotions });

// Release-owned ledger failure must block the deployment and roll back the pointer.
const ledgerFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-skill-promo-ledgerfail-'));
const ledgerBlocker = path.join(ledgerFailureRoot, 'not-a-dir');
fs.writeFileSync(ledgerBlocker, 'block ledger directory creation');
const cFail = { ...createCandidateCard({ skillId, route, baseVersion: 0, body: 'ledger fail body' }), status: 'accepted' };
const pFail = await promoteToDeployedWithLedger(ledgerFailureRoot, cFail, { contract, context: 'release', ledgerRoot: ledgerBlocker });
assertGate(pFail.ok === false && pFail.blockers.some((b) => String(b).startsWith('promotion_ledger_write_failed')), 'ledger write failure must hard-fail release promotion', { pFail });
assertGate(!fs.existsSync(path.join(ledgerFailureRoot, '.sneakoscope', 'skills', routeSkillId(route), skillId, 'deployed.json')), 'failed first deployment must not leave deployed snapshot behind', { pFail });

// Regression: explicit legacy wrapper remains available only for compatibility fixtures.
const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-skill-promo-2arg-'));
const c3 = { ...createCandidateCard({ skillId, route, baseVersion: 0, body: 'b' }), status: 'accepted' };
const p3 = await promoteToDeployedLegacyForCompatibility(fresh, c3);
assertGate(p3.ok === true && p3.snapshot !== null, 'legacy compatibility promotion must still return ok', { p3 });
assertGate(!fs.existsSync(mutationLedgerPath(fresh)), 'legacy compatibility promotion must not write a ledger', {});

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(fresh, { recursive: true, force: true });
fs.rmSync(ledgerFailureRoot, { recursive: true, force: true });
emitGate('core-skill:promotion-side-effect-ledger', {
  promotions: promotions.length,
  rollback_pointer: true,
  two_arg_safe: true,
  ledger_failure_hard_fail: true,
  legacy_wrapper_safe: true
});
