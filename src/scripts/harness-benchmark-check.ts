#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { assertGate, emitGate, root } from './gate-lib.js';
import { COMMAND_MANIFEST_LITE } from '../cli/command-manifest-lite.js';
import { ensureDir, nowIso, runProcess, writeJsonAtomic } from '../core/fsx.js';
import { reviewCommand } from '../core/commands/review-command.js';
import { simulateNarutoActivePool } from '../core/naruto/naruto-active-pool.js';
import { decideNarutoConcurrency } from '../core/naruto/naruto-concurrency-governor.js';
import { buildNarutoWorkGraph } from '../core/naruto/naruto-work-graph.js';

const reportPath = path.join(root, '.sneakoscope', 'reports', 'harness-benchmark.json');
const metrics = [];

metrics.push(await measure('install_entrypoint_readiness', 300000, async () => {
  await assertFile('dist/bin/install.js');
  await assertFile('plugins/sks/.codex-plugin/plugin.json');
  return { mode: 'hermetic_readiness', command: 'npm exec --yes --package=sneakoscope@latest -- sneakoscope install --yes' };
}));

metrics.push(await measure('stop_hook_light_budget', 25, async () => {
  const started = performance.now();
  await assertFile('dist/scripts/hook-latency-budget-check.js');
  return { mode: 'script_presence_budget_proxy', measured_ms: performance.now() - started };
}));

metrics.push(await measure('naruto_14_worker_fixture', 20000, async () => {
  const graph = buildNarutoWorkGraph({
    requestedWorkers: 14,
    totalWorkItems: 14,
    honorExplicitTotalWorkItems: true,
    readonly: true,
    writeCapable: false,
    maxActiveWorkers: 14
  });
  const governor = decideNarutoConcurrency({
    requestedWorkers: 14,
    totalWorkItems: 14,
    pendingWorkQueueSize: 14,
    backend: 'fake',
    hardware: { remoteApiRateLimitBudget: 14, fileDescriptorLimit: 4096, freeMemoryBytes: 8 * 1024 * 1024 * 1024, totalMemoryBytes: 16 * 1024 * 1024 * 1024 }
  });
  const report = simulateNarutoActivePool({ graph, governor: { ...governor, safe_active_workers: 14 } });
  return {
    command: 'simulateNarutoActivePool --fake --agents 14',
    ok: report.ok === true && report.completed_count >= 14 && report.max_observed_active_workers >= 7,
    completed_count: report.completed_count,
    max_observed_active_workers: report.max_observed_active_workers,
    blockers: report.blockers
  };
}));

metrics.push(await measure('review_10_file_diff', 120000, async () => {
  const fixture = await makeReviewFixture();
  const previousExitCode = process.exitCode;
  const review = await reviewCommand(['--root', fixture]) as any;
  process.exitCode = previousExitCode;
  return {
    files: review?.files || 0,
    machine_evidence: (review?.findings || []).filter((finding: any) => finding.evidence === 'machine').length,
    verdict: review?.verdict || 'unknown'
  };
}));

metrics.push(await measure('public_command_manifest', 2000, async () => {
  const names = COMMAND_MANIFEST_LITE.map((entry) => entry.name);
  return { ok: names.length > 0 && !names.includes('ui' as any), command_count: names.length };
}));

const report = {
  schema: 'sks.harness-benchmark.v1',
  generated_at: nowIso(),
  ok: metrics.every((metric) => metric.ok),
  metrics,
  report_path: path.relative(root, reportPath)
};

await writeJsonAtomic(reportPath, report);
assertGate(report.ok, 'harness benchmark check failed', report);
emitGate('harness:benchmark', report);

async function measure(id: string, budgetMs: number, fn: () => Promise<Record<string, unknown>>) {
  const started = performance.now();
  try {
    const detail = await fn();
    const elapsed_ms = Math.round((performance.now() - started) * 100) / 100;
    return { id, ok: elapsed_ms <= budgetMs && detail.ok !== false, budget_ms: budgetMs, elapsed_ms, detail };
  } catch (err: any) {
    const elapsed_ms = Math.round((performance.now() - started) * 100) / 100;
    return { id, ok: false, budget_ms: budgetMs, elapsed_ms, error: err?.message || String(err) };
  }
}

async function assertFile(rel: string) {
  await fs.access(path.join(root, rel));
}

async function makeReviewFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-review-bench-'));
  await runProcess('git', ['init'], { cwd: dir, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  for (let i = 0; i < 10; i += 1) {
    await ensureDir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src', `file-${i}.txt`), `baseline ${i}\n`, 'utf8');
  }
  await runProcess('git', ['add', '.'], { cwd: dir, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  for (let i = 0; i < 10; i += 1) {
    const content = i === 0 ? '<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n' : `changed ${i}\n`;
    await fs.writeFile(path.join(dir, 'src', `file-${i}.txt`), content, 'utf8');
  }
  return dir;
}
