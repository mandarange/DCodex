import { buildGatePackManifest } from './gate-pack-manifest.js';
import { executeGatePack, type GatePackRunnerResult } from './gate-pack-runner.js';
import { buildCriticalPathLedger, writeCriticalPathLedger } from './critical-path-ledger.js';
import type { ResourceClassBudget } from './resource-class-budget.js';
import { computeResourceClassBudget } from './resource-class-budget.js';
import type { TriWikiAffectedGraph } from '../triwiki/triwiki-affected-graph.js';
import fs from 'node:fs';
import path from 'node:path';

export const EXTREME_PARALLEL_SCHEDULER_SCHEMA = 'sks.extreme-parallel-scheduler.v1';

export interface ExtremeParallelSchedule {
  schema: typeof EXTREME_PARALLEL_SCHEDULER_SCHEMA;
  ok: boolean;
  batches: Array<{ batch: number; packs: string[]; estimated_ms: number }>;
  sequential_ms: number;
  critical_path_ms: number;
  reduction_ratio: number;
  budget: ResourceClassBudget;
  blockers: string[];
}

export interface ExtremeSchedulerRunReport extends ExtremeParallelSchedule {
  run_id: string;
  mode: 'execute';
  executed_packs: string[];
  reused_proof_count: number;
  executed_gate_count: number;
  failed_pack_count: number;
  wall_ms: number;
  pack_reports: GatePackRunnerResult[];
  resource_wait_ms: Record<string, number>;
  resource_claim_timeline: string;
}

export function planExtremeParallelSchedule(root: string, graph?: TriWikiAffectedGraph, budget: ResourceClassBudget = computeResourceClassBudget()): ExtremeParallelSchedule {
  const manifest = buildGatePackManifest(root);
  const selectedIds = new Set(graph?.gate_packs && graph.gate_packs.length ? graph.gate_packs : manifest.packs.map((pack) => pack.id));
  const packs = manifest.packs.filter((pack) => selectedIds.has(pack.id)).sort((a, b) => b.estimated_ms - a.estimated_ms);
  const laneCount = Math.max(1, Math.min(packs.length || 1, Math.max(4, budget.cpu_light)));
  const lanes: Array<{ packs: string[]; estimated_ms: number }> = Array.from({ length: laneCount }, () => ({ packs: [], estimated_ms: 0 }));
  for (const pack of packs) {
    const target = lanes.reduce((best, lane) => lane.estimated_ms < best.estimated_ms ? lane : best, lanes[0]!);
    target.packs.push(pack.id);
    target.estimated_ms += pack.estimated_ms;
  }
  const batches = lanes
    .filter((lane) => lane.packs.length > 0)
    .map((lane, index) => ({ batch: index + 1, packs: lane.packs, estimated_ms: lane.estimated_ms }));
  const sequential = packs.reduce((sum, pack) => sum + pack.estimated_ms, 0);
  const critical = batches.reduce((max, batch) => Math.max(max, batch.estimated_ms), 0);
  const ratio = sequential <= 0 ? 1 : critical / sequential;
  const blockers = ratio <= 0.3 || packs.length < 4 ? [] : ['critical_path_reduction_below_70_percent'];
  return {
    schema: EXTREME_PARALLEL_SCHEDULER_SCHEMA,
    ok: blockers.length === 0,
    batches,
    sequential_ms: sequential,
    critical_path_ms: critical,
    reduction_ratio: Number(ratio.toFixed(4)),
    budget,
    blockers
  };
}

export async function executeExtremeSchedule(input: {
  root: string;
  graph: TriWikiAffectedGraph;
  slaMs: number;
  budget: ResourceClassBudget;
  useProofBank: boolean;
}): Promise<ExtremeSchedulerRunReport> {
  const planned = planExtremeParallelSchedule(input.root, input.graph, input.budget);
  const started = Date.now();
  const runId = `xs-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const manifest = buildGatePackManifest(input.root);
  const packById = new Map(manifest.packs.map((pack) => [pack.id, pack]));
  const queuedAt = new Map<string, number>();
  const pending = planned.batches.flatMap((batch) => batch.packs).filter((packId, index, all) => all.indexOf(packId) === index);
  for (const packId of pending) queuedAt.set(packId, Date.now());
  const used = emptyUsedResources();
  const waitingMs: Record<string, number> = {};
  const timeline: Array<{ event: string; pack_id: string; at: string; resources: string[]; used: Record<string, number>; wait_ms?: number; ok?: boolean }> = [];
  const running = new Map<string, Promise<GatePackRunnerResult>>();
  const reports: GatePackRunnerResult[] = [];
  let reused = 0;
  let executedGates = 0;
  let failedPacks = 0;

  while (pending.length || running.size) {
    let launched = false;
    for (let i = 0; i < pending.length;) {
      const packId = pending[i]!;
      const resources = resourceKeysForPack(packById.get(packId)?.resource_classes || ['cpu-light']);
      if (!canClaim(used, input.budget, resources)) {
        i += 1;
        continue;
      }
      pending.splice(i, 1);
      const waitMs = Math.max(0, Date.now() - (queuedAt.get(packId) || Date.now()));
      for (const resource of resources) waitingMs[resource] = (waitingMs[resource] || 0) + waitMs;
      claim(used, resources);
      timeline.push({ event: 'claim', pack_id: packId, at: new Date().toISOString(), resources, used: { ...used }, wait_ms: waitMs });
      launched = true;
      const promise = executeGatePack({
        root: input.root,
        packId,
        mode: 'execute',
        maxParallel: Math.max(1, Math.min(4, input.budget.cpu_light))
      }).then((report) => {
        release(used, resources);
        timeline.push({ event: 'release', pack_id: packId, at: new Date().toISOString(), resources, used: { ...used }, ok: report.ok });
        return report;
      });
      running.set(packId, promise);
    }
    if (!running.size) {
      if (!launched) await sleep(5);
      continue;
    }
    if (launched && pending.some((packId) => canClaim(used, input.budget, resourceKeysForPack(packById.get(packId)?.resource_classes || ['cpu-light'])))) {
      continue;
    }
    const report = await Promise.race([...running.values()]);
    running.delete(report.pack_id);
    reports.push(report);
    reused += report.reused_proof_count || report.reused || 0;
    executedGates += report.executed_gate_count || report.executed || 0;
    if (!report.ok) failedPacks += 1;
  }
  for (const report of await Promise.all([...running.values()])) {
    if (!reports.some((row) => row.pack_id === report.pack_id)) {
      reports.push(report);
      reused += report.reused_proof_count || report.reused || 0;
      executedGates += report.executed_gate_count || report.executed || 0;
      if (!report.ok) failedPacks += 1;
    }
  }
  const wallMs = Math.max(0, Date.now() - started);
  const criticalPathMs = Math.max(...reports.map((report) => report.critical_path_ms || 0), planned.critical_path_ms);
  const sequentialMs = reports.reduce((sum, report) => sum + (report.critical_path_ms || 0), planned.sequential_ms);
  const timelineFile = writeResourceClaimTimeline(input.root, runId, timeline);
  writeCriticalPathLedger(input.root, buildCriticalPathLedger({
    run_id: runId,
    sequential_ms: sequentialMs,
    critical_path_ms: criticalPathMs,
    wall_ms: wallMs,
    parallelism_gain: wallMs > 0 ? Number((sequentialMs / wallMs).toFixed(2)) : 1,
    resource_wait_ms: waitingMs,
    top_blockers: reports.filter((report) => !report.ok).map((report) => ({ id: report.pack_id, wait_ms: 0, run_ms: report.critical_path_ms || 0 }))
  }));
  return {
    ...planned,
    ok: planned.ok && failedPacks === 0 && wallMs <= input.slaMs,
    run_id: runId,
    mode: 'execute',
    executed_packs: reports.map((report) => report.pack_id),
    reused_proof_count: reused,
    executed_gate_count: executedGates,
    failed_pack_count: failedPacks,
    wall_ms: wallMs,
    resource_wait_ms: waitingMs,
    resource_claim_timeline: timelineFile,
    critical_path_ms: criticalPathMs,
    sequential_ms: sequentialMs,
    pack_reports: reports,
    blockers: [...planned.blockers, ...(wallMs > input.slaMs ? ['sla_actual_exceeds_budget'] : []), ...(failedPacks ? ['pack_execution_failed'] : [])]
  };
}

function emptyUsedResources(): Record<string, number> {
  return {
    cpu_light: 0,
    cpu_heavy: 0,
    io_light: 0,
    io_heavy: 0,
    fs_read: 0,
    network: 0,
    remote_model_real: 0,
    browser_real: 0,
    secret_sensitive: 0
  };
}

function resourceKeysForPack(classes: string[]): Array<keyof ResourceClassBudget> {
  const keys = classes.map((value) => {
    if (value === 'cpu-light') return 'cpu_light';
    if (value === 'cpu-heavy') return 'cpu_heavy';
    if (value === 'io-light') return 'io_light';
    if (value === 'io-heavy') return 'io_heavy';
    if (value === 'fs-read') return 'fs_read';
    if (value === 'remote-model-real') return 'remote_model_real';
    if (value === 'browser-real') return 'browser_real';
    if (value === 'secret-sensitive' || value === 'secret') return 'secret_sensitive';
    if (value === 'network') return 'network';
    return 'cpu_light';
  });
  return [...new Set(keys)] as Array<keyof ResourceClassBudget>;
}

function canClaim(used: Record<string, number>, budget: ResourceClassBudget, resources: Array<keyof ResourceClassBudget>): boolean {
  return resources.every((resource) => (used[resource] || 0) < Number(budget[resource] || 1));
}

function claim(used: Record<string, number>, resources: Array<keyof ResourceClassBudget>): void {
  for (const resource of resources) used[resource] = (used[resource] || 0) + 1;
}

function release(used: Record<string, number>, resources: Array<keyof ResourceClassBudget>): void {
  for (const resource of resources) used[resource] = Math.max(0, (used[resource] || 0) - 1);
}

function writeResourceClaimTimeline(root: string, runId: string, timeline: unknown[]): string {
  const file = path.join(root, '.sneakoscope', 'reports', 'resource-claim-timeline.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ schema: 'sks.resource-claim-timeline.v1', run_id: runId, events: timeline }, null, 2)}\n`);
  return file;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
