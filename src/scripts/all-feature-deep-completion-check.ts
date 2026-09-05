#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, requireContains, root, runSksJson } from './real-execution-check-lib.js';

const requiredGates = [
  'ux-review:run-wires-imagegen',
  'ux-review:extract-wires-real-extractor',
  'ux-review:patch-diff-recheck',
  'ux-review:imagegen-blackbox',
  'ppt:real-export-adapter',
  'ppt:real-imagegen-wiring',
  'ppt:reexport-rereview',
  'ppt:full-e2e-blackbox',
  'dfix:patch-handoff',
  'dfix:verification-recommendation',
  'dfix:fixture',
  'dfix:verification',
  'all-features:deep-completion',
  'schema:check'
];

const releaseManifest = JSON.parse(fs.readFileSync(path.join(root, 'release-gates.v2.json'), 'utf8'));
const releaseGateIds = new Set((releaseManifest.gates || []).map((gate) => String(gate.id || '')));
const missingGates = requiredGates.filter((id) => !releaseGateIds.has(id));
assertGate(missingGates.length === 0, 'all-features:deep-completion release gates missing', { missing: missingGates });
requireContains('all-features:deep-completion', 'src/core/feature-registry.ts', [
  'command_registry',
  'evidence_router',
  'completion_proof',
  'trust_report',
  'wrongness',
  'blackbox',
  'mock_not_real',
  'unavailable_blocker'
]);

const report = runSksJson(['features', 'complete', '--json'], { allowFailure: true });
assertGate(report.schema === 'sks.all-feature-completion.v1', 'all-feature completion schema mismatch', report);
assertGate(Array.isArray(report.features) && report.features.length > 0, 'all-feature completion rows missing', report);
assertGate(report.contract_coverage_ok === true, 'all-feature contract coverage must be complete', report);
assertGate(report.status === 'contract_covered_unverified', 'all-feature runtime truth status must remain explicit', report);
assertGate(report.working_claim_allowed === false, 'unverified all-feature runtime must not allow a working claim', report);
assertGate(report._process_status === 2, 'truthful unverified completion must retain its non-zero process status', report);
emitGate('all-features:deep-completion', { version: report.version, features: report.features.length, status: report.status });
