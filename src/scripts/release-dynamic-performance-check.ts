#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const { selectGates } = await importDist('core/release/gate-manifest.js');
const { buildGateManifest } = await importDist('core/release/gate-manifest.js');
const manifest = loadDynamicManifest();
const t0 = Date.now();

const docsOnly = summarize(['docs/release-readiness.md']);
const zellijOnly = summarize(['src/core/zellij/zellij-capability.ts']);
const coreSkillOnly = summarize(['src/core/skills/core-skill-deployment.ts']);
const currentReport = readJson('.sneakoscope/reports/release-check-dynamic-execute.json', null);
const durationMs = Date.now() - t0;

const report = {
  schema: 'sks.release-dynamic-performance.v1',
  ok: true,
  duration_ms: durationMs,
  gate_count: manifest.gates.length,
  current: currentReport ? {
    selected_count: currentReport.selected?.length || 0,
    executed_count: currentReport.executed?.length || 0,
    cache_hits: currentReport.cache_hits?.length || 0,
    skipped_count: currentReport.skipped?.length || 0,
    mode: currentReport.mode || null
  } : null,
  fixtures: {
    docs_only: docsOnly,
    zellij_only: zellijOnly,
    core_skill_only: coreSkillOnly
  },
  warnings: durationMs > 30_000 ? ['dynamic_performance_check_over_budget'] : []
};
report.ok = docsOnly.heavy_selected === 0
  && zellijOnly.selected.every((id) => id.startsWith('zellij:') || alwaysOn(id) || scopedRuntimeBoundary(id))
  && coreSkillOnly.selected.every((id) => id.startsWith('core-skill:') || alwaysOn(id) || scopedRuntimeBoundary(id))
  && docsOnly.selected_count < manifest.gates.length;

const out = path.join(root, '.sneakoscope', 'reports', 'release-dynamic-performance.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
assertGate(report.ok, 'dynamic release performance fixtures failed', report);
emitGate('release:dynamic-performance', {
  gates: manifest.gates.length,
  docs_only_selected: docsOnly.selected_count,
  zellij_only_selected: zellijOnly.selected_count,
  core_skill_only_selected: coreSkillOnly.selected_count,
  duration_ms: durationMs
});

function summarize(changedFiles) {
  const plan = selectGates(manifest.gates, changedFiles, { publish: false });
  const selected = plan.selected.map((gate) => gate.id);
  return {
    changed_files: changedFiles,
    selected,
    selected_count: selected.length,
    skipped_count: plan.skipped.length,
    heavy_selected: plan.selected.filter((gate) => gate.cost === 'heavy' || gate.cost === 'real').length
  };
}

function alwaysOn(id) {
  return manifest.gates.some((gate) => gate.id === id && gate.always_on_release === true);
}

function scopedRuntimeBoundary(id) {
  return [
    'runtime:no-mjs-scripts',
    'runtime:ts-python-boundary',
    'runtime:proof-summary',
    'runtime:proof-summary-cli',
    'runtime:proof-summary-messages',
    'runtime:proof-zellij-stacked-summary'
  ].includes(id);
}

function readJson(rel, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  } catch {
    return fallback;
  }
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
