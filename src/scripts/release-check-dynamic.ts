#!/usr/bin/env node
// @ts-nocheck
// release:check:dynamic — change-aware gate planner. Runs only P0 always-on gates
// plus gates whose affected_by globs match the changed files. Real/heavy gates are
// deferred to release:real-check. Publish mode never skips required_for_publish gates.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const { buildGateManifest, selectGates } = await importDist('core/release/gate-manifest.js');

const args = process.argv.slice(2);
const publish = args.includes('--publish');
const baseArg = readArg(args, '--base');

// Normalize the checked-in v2 DAG manifest for the legacy dynamic selector.
const manifest = loadDynamicManifest();

const changedFiles = detectChangedFiles(baseArg);
const plan = selectGates(manifest.gates, changedFiles, { publish });

// --- Hermetic invariant proofs (independent of the current git state) ---
// 1) A docs-only change must NOT select any real/heavy gate.
const docsOnly = selectGates(manifest.gates, ['docs/release-readiness.md'], { publish: false });
const realSelectedOnDocs = docsOnly.selected.filter((g) => g.cost === 'real' || g.cost === 'heavy');
assertGate(realSelectedOnDocs.length === 0, 'docs-only change must not select real/heavy gates', { offenders: realSelectedOnDocs.map((g) => g.id) });
// At least one heavy/real gate must be skipped on a docs-only change (proves narrowing).
const skippedHeavy = docsOnly.skipped.length;
assertGate(skippedHeavy > 0, 'docs-only change must skip at least one unrelated gate', { skipped: skippedHeavy });

// 2) Publish mode must select every required_for_publish gate.
const publishPlan = selectGates(manifest.gates, [], { publish: true });
const requiredIds = manifest.gates.filter((g) => g.required_for_publish).map((g) => g.id);
const selectedPublish = new Set(publishPlan.selected.map((g) => g.id));
const missingRequired = requiredIds.filter((id) => !selectedPublish.has(id));
assertGate(missingRequired.length === 0, 'publish mode must never skip required_for_publish gates', { missingRequired });

const report = {
  schema: 'sks.release-check-dynamic.v1',
  ok: true,
  mode: publish ? 'publish' : 'incremental',
  base: baseArg || null,
  changed_files: changedFiles,
  selected: plan.selected.map((g) => g.id),
  skipped: plan.skipped,
  invariants: { docs_only_skips_heavy: true, publish_keeps_required: true }
};
const reportDir = path.join(root, '.sneakoscope', 'reports');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'release-check-dynamic.json'), `${JSON.stringify(report, null, 2)}\n`);
emitGate('release:check:dynamic', { selected: report.selected.length, skipped: report.skipped.length, changed_files: changedFiles.length, mode: report.mode });

function readArg(list, name) {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] || null : null;
}

function loadDynamicManifest() {
  const v2Path = path.join(root, 'release-gates.v2.json');
  if (!fs.existsSync(v2Path)) throw new Error('release-gates.v2.json is required; release-gates.json v1 is no longer supported');
  const parsed = JSON.parse(fs.readFileSync(v2Path, 'utf8'));
  const releaseNodes = (Array.isArray(parsed.gates) ? parsed.gates : []).filter((gate) => Array.isArray(gate.preset) && gate.preset.includes('release'));
  const byId = new Map(releaseNodes.map((gate) => [gate.id, gate]));
  const dynamic = buildGateManifest(releaseNodes.map((gate) => gate.id));
  return {
    schema: 'sks.release-gate-manifest.v1.from-v2',
    gates: dynamic.gates.map((entry) => {
      const node = byId.get(entry.id);
      const resource = Array.isArray(node?.resource) ? node.resource.join(',') : '';
      return {
        ...entry,
        affected_by: usefulCacheInputs(node?.cache?.inputs, entry.affected_by),
        cost: node?.side_effect === 'real-env' || resource.includes('real') ? 'real' : entry.cost
      };
    })
  };
}

function usefulCacheInputs(inputs, fallback) {
  if (!Array.isArray(inputs) || !inputs.length) return fallback;
  if (inputs.some((input) => ['src/**', 'package.json', 'release-gates.v2.json', 'schemas/**'].includes(input))) return fallback;
  return inputs;
}
function detectChangedFiles(base) {
  try {
    let ref = base;
    if (!ref) {
      const mb = spawnSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: root, encoding: 'utf8' });
      ref = mb.status === 0 ? mb.stdout.trim() : 'HEAD~1';
    }
    const diff = spawnSync('git', ['diff', '--name-only', `${ref}...HEAD`], { cwd: root, encoding: 'utf8' });
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    const files = new Set();
    if (diff.status === 0) diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean).forEach((f) => files.add(f));
    if (status.status === 0) status.stdout.split('\n').map((s) => s.slice(3).trim()).filter(Boolean).forEach((f) => files.add(f));
    return [...files];
  } catch {
    return [];
  }
}
