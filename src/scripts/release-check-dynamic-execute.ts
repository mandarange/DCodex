#!/usr/bin/env node
// @ts-nocheck
// release:check:dynamic:execute (1.20.2 Area 2).
//
// Change-aware gate RUNNER (the plan-only release-check-dynamic.mjs stays as-is).
// Default = EXECUTE: selects gates whose affected_by globs match changed files
// (plus always-on), runs each hermetic one via `npm run <id>`, caches successful
// results, and serves cache hits to skip re-runs on an unchanged tree. Real/heavy
// gates are deferred to release:real-check. --plan-only prints the plan without
// running. --publish selects every required_for_publish gate.
//
// This script is STANDALONE — it must never be added to the release:check chain,
// the DAG, or the gate manifest (it would recursively invoke the gate set).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { emitGate, importDist, root } from './gate-lib.js';

const { buildGateManifest, selectGates, FORBIDDEN_RECURSIVE_GATES } = await importDist('core/release/gate-manifest.js');
const { gateCacheKey, readGateCache, writeGateCache, recordGateResult, lookupGateResult } = await importDist('core/release/gate-cache.js');

let TRACKED = null;
const args = process.argv.slice(2);
const planOnly = args.includes('--plan-only');
const publish = args.includes('--publish');
const baseArg = readArg(args, '--base');
const envMode = process.env.SKS_ENV_MODE || (publish ? 'publish' : 'incremental');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = loadManifest();
const changedFiles = detectChangedFiles(baseArg);
const plan = selectGates(manifest.gates, changedFiles, { publish });

// Context Graph advisory: an ADDITIVE signal only. It may add a gate the exact
// changed-file globs missed (an import edge the glob does not express), and it
// can never remove one — the assertion below makes that structural rather than
// a promise. A missing or stale graph leaves the plan exactly as the exact
// selector produced it, because the graph is a cache and this is a release path.
const { contextGraphAffectedVerification } = await importDist('core/verification/context-graph-affected.js');
const baselineGateIds = plan.selected.map((gate) => gate.id);
let graphAdvisory = { graph_used: false, added_gates: [], graph_status: 'missing', conservative_reasons: [] };
try {
  const advice = await contextGraphAffectedVerification({
    root,
    changedFiles,
    gates: manifest.gates,
    baselineGateIds,
    ...(publish ? { publish: true } : {})
  });
  const dropped = baselineGateIds.filter((id) => !advice.gates.includes(id));
  if (dropped.length) {
    console.error(JSON.stringify({ ok: false, message: 'context_graph_advisory_dropped_baseline_gate', dropped }, null, 2));
    process.exit(1);
  }
  graphAdvisory = advice;
  if (advice.graph_used && advice.added_gates.length) {
    const byId = new Map(manifest.gates.map((gate) => [gate.id, gate]));
    for (const id of advice.added_gates) {
      const gate = byId.get(id);
      if (gate && !baselineGateIds.includes(id)) plan.selected.push(gate);
    }
  }
} catch (error) {
  // Advisory failure must never block a release plan the exact selector already
  // produced; it is recorded and the plan stands.
  graphAdvisory = { graph_used: false, added_gates: [], graph_status: 'unavailable', conservative_reasons: [], error: String(error).slice(0, 200) };
}

// Hermetic invariant proofs preserved from the planner (self-prove narrowing).
const docsOnly = selectGates(manifest.gates, ['docs/release-readiness.md'], { publish: false });
const realOnDocs = docsOnly.selected.filter((g) => g.cost === 'real' || g.cost === 'heavy');
const publishPlan = selectGates(manifest.gates, [], { publish: true });
const requiredIds = manifest.gates.filter((g) => g.required_for_publish).map((g) => g.id);
const selectedPublish = new Set(publishPlan.selected.map((g) => g.id));
const invariants = {
  docs_only_skips_heavy: realOnDocs.length === 0,
  publish_keeps_required: requiredIds.every((id) => selectedPublish.has(id))
};

const distHash = distHashValue();
const gitCommit = gitHead();
const manifestHash = fileHash('release-gates.v2.json');
const packageScriptsHash = sha256(JSON.stringify(pkg.scripts || {}));
const nodeVersion = process.version;
const npmVersion = npmVersionValue();
const cache = await readGateCache(root);

const executed = [];
const cacheHits = [];
const skipped = [...plan.skipped];
const failures = [];

for (const gate of plan.selected) {
  if (FORBIDDEN_RECURSIVE_GATES.has(gate.id)) {
    skipped.push({ id: gate.id, reason: 'forbidden_recursive_gate' });
    continue;
  }
  // Real/heavy gates are never run incrementally or cached — defer to release:real-check.
  if (gate.cost === 'real' || gate.cost === 'heavy') {
    skipped.push({ id: gate.id, reason: 'deferred_to_real_check' });
    continue;
  }
  const command = String(gate.command || '');
  if (!command) {
    failures.push({ id: gate.id, exit_code: null, stdout_tail: '', stderr_tail: 'gate_command_missing' });
    continue;
  }
  if (FORBIDDEN_RECURSIVE_GATES.has(gate.id) || /npm\s+run\s+(release:check|release:real-check|release:publish|publish:ignore-scripts|publish:npm|publish:dry|prepublishOnly)\b/.test(command)) {
    failures.push({ id: gate.id, exit_code: null, stdout_tail: '', stderr_tail: 'forbidden_recursive_gate_spawn' });
    continue;
  }
  const key = gateCacheKey({
    gateId: gate.id,
    command,
    packageVersion: pkg.version,
    gitCommit,
    inputHashes: hashAffectedFiles(gate.affected_by),
    envMode,
    distHash,
    manifestHash,
    packageScriptsHash,
    gateImplementationHash: gateImplementationHash(gate.id, command),
    nodeVersion,
    npmVersion
  });
  const hit = lookupGateResult(cache, key);
  if (hit && hit.ok) {
    cacheHits.push({ id: gate.id, key, duration_ms: hit.duration_ms, recorded_at: hit.recorded_at });
    continue;
  }
  if (planOnly) {
    executed.push({ id: gate.id, planned: true });
    continue;
  }
  const started = Date.now();
  const childEnv = { ...process.env, SKS_RELEASE_DYNAMIC: '1', SKS_ENV_MODE: envMode };
  const res = spawnSync(command, { cwd: root, env: childEnv, encoding: 'utf8', shell: true, maxBuffer: 50 * 1024 * 1024 });
  const durationMs = Date.now() - started;
  const ok = res.status === 0;
  executed.push({ id: gate.id, ok, exit_code: res.status, duration_ms: durationMs });
  if (ok) {
    // Only successful gates are cached; failures always re-run.
    recordGateResult(cache, key, gate.id, true, durationMs);
  } else {
    failures.push({ id: gate.id, exit_code: res.status, stdout_tail: tail(res.stdout), stderr_tail: tail(res.stderr) });
  }
}

if (!planOnly) await writeGateCache(root, cache);

const ok = failures.length === 0 && invariants.docs_only_skips_heavy && invariants.publish_keeps_required;
const report = {
  schema: 'sks.release-check-dynamic.v2',
  ok,
  mode: planOnly ? 'plan-only' : publish ? 'publish' : 'incremental',
  base: baseArg || null,
  changed_files: changedFiles,
  selected: plan.selected.map((g) => g.id),
  skipped,
  executed,
  cache_hits: cacheHits,
  failures,
  invariants
};
const reportDir = path.join(root, '.sneakoscope', 'reports');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'release-check-dynamic-execute.json'), `${JSON.stringify(report, null, 2)}\n`);

if (!ok) {
  console.log(JSON.stringify({ schema: 'sks.release-check-dynamic.v2', ok: false, mode: report.mode, failures, invariants }, null, 2));
  process.exit(1);
}
emitGate('release:check:dynamic:execute', {
  mode: report.mode,
  selected: report.selected.length,
  executed: executed.length,
  cache_hits: cacheHits.length,
  skipped: skipped.length,
  failures: failures.length,
  graph_advisory: {
    used: graphAdvisory.graph_used === true,
    status: graphAdvisory.graph_status,
    added_gates: graphAdvisory.added_gates,
    // Carried into the receipt so the advisory's own "this answer is short"
    // signals — `recommended_tests_truncated`, `added_gates_truncated`,
    // `impact_closure_truncated` — reach a reader. A reason nobody prints is the
    // same defect as a cap nobody reports.
    conservative_reasons: graphAdvisory.conservative_reasons ?? []
  }
});

// ---- helpers ----------------------------------------------------------------

function loadManifest() {
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
          command: node?.command || '',
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

function hashAffectedFiles(globs) {
  const regexes = (globs || []).map(globToRegExp);
  const hashes = [];
  for (const file of listTrackedFiles()) {
    if (!regexes.some((re) => re.test(file))) continue;
    try {
      const buf = fs.readFileSync(path.join(root, file));
      hashes.push(`${file}:${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}`);
    } catch {}
  }
  return hashes;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function fileHash(rel) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
  } catch {
    return 'missing';
  }
}

function gateImplementationHash(id, command) {
  const script = String(command || pkg.scripts?.[id] || '');
  const matches = [...script.matchAll(/node\s+\.\/([^ &|;]+\.js)/g)].map((match) => match[1]);
  if (matches.length) return sha256(matches.map((rel) => `${rel}:${fileHash(rel)}`).join('\n'));
  return sha256(script);
}

function npmVersionValue() {
  const res = spawnSync('npm', ['--version'], { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : 'npm-unavailable';
}

function listTrackedFiles() {
  if (TRACKED) return TRACKED;
  const res = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  TRACKED = res.status === 0 ? res.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  return TRACKED;
}

function globToRegExp(glob) {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, ' ').replace(/\*/g, '[^/]*').replace(/ /g, '.*') + '$');
}

function distHashValue() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'build-manifest.json'), 'utf8'));
    return String(m.source_digest || m.source_files_hash || m.version || 'no-dist');
  } catch {
    return 'no-dist';
  }
}

function gitHead() {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : 'no-git';
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

function readArg(list, name) {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] || null : null;
}

function tail(value, limit = 4000) {
  const text = String(value || '');
  return text.length <= limit ? text : text.slice(-limit);
}
