import os from 'node:os';
import type { LoopConcurrencyBudget } from './loop-concurrency-budget.js';
import type { SksLoopGraphProof, SksLoopNode, SksLoopProof } from './loop-schema.js';
import { loopProofCompletionIssues, loopProofIsVerifiedComplete } from './loop-proof-validation.js';

export interface SksLoopSchedule {
  ok: boolean;
  batches: SksLoopNode[][];
  max_active_loops: number;
  blockers: string[];
}

export function scheduleLoopGraph(nodes: SksLoopNode[], parallelism: 'safe' | 'balanced' | 'extreme' = 'safe', budget?: LoopConcurrencyBudget): SksLoopSchedule {
  const pending = new Map(nodes.map((node) => [node.loop_id, node]));
  const completed = new Set<string>();
  const batches: SksLoopNode[][] = [];
  const maxParallel = budget?.max_active_loops || maxConcurrentLoops(nodes, parallelism);
  const blockers: string[] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((node) => node.dependencies.every((dep) => completed.has(dep)));
    if (!ready.length) {
      blockers.push(`loop_dependency_cycle:${[...pending.keys()].join(',')}`);
      break;
    }
    const batch = ready.slice(0, maxParallel);
    batches.push(batch);
    for (const node of batch) {
      pending.delete(node.loop_id);
      if (node.route !== '$Integration') completed.add(node.loop_id);
      else completed.add(node.loop_id);
    }
  }
  return { ok: blockers.length === 0, batches, max_active_loops: Math.max(0, ...batches.map((batch) => batch.length)), blockers };
}

export function maxConcurrentLoops(nodes: SksLoopNode[], parallelism: 'safe' | 'balanced' | 'extreme' = 'safe'): number {
  const cores = Math.max(1, os.cpus().length || 1);
  const base = parallelism === 'safe' ? 1 : parallelism === 'extreme' ? Math.min(4, cores) : Math.min(2, cores);
  return Math.max(1, Math.min(base, riskAwareLoopCap(nodes, parallelism, cores)));
}

function riskAwareLoopCap(nodes: SksLoopNode[], parallelism: 'safe' | 'balanced' | 'extreme', cores: number): number {
  if (parallelism === 'extreme') return Math.min(4, cores);
  const hasCritical = nodes.some((node) => node.risk.level === 'critical');
  const hasHigh = nodes.some((node) => node.risk.level === 'high');
  if (hasCritical) return 1;
  if (hasHigh) return parallelism === 'safe' ? 1 : Math.min(2, cores);
  return parallelism === 'safe' ? 1 : parallelism === 'balanced' ? Math.min(2, cores) : Math.min(4, cores);
}

export function graphProofFromLoopProofs(input: {
  missionId: string;
  proofs: SksLoopProof[];
  maxActiveLoops: number;
  maxActiveWorkers: number;
  wallMs: number;
}): SksLoopGraphProof {
  const selected = [...new Set(input.proofs.flatMap((proof) => proof.gate_result.selected_gates))];
  const passed = [...new Set(input.proofs.flatMap((proof) => proof.gate_result.passed_gates))];
  const failed = [...new Set(input.proofs.flatMap((proof) => proof.gate_result.failed_gates))];
  const skipped = [...new Set(input.proofs.flatMap((proof) => proof.gate_result.skipped_gates))];
  const proofValidationBlockers = input.proofs.flatMap((proof) => (
    loopProofCompletionIssues(proof).map((issue) => `${proof.loop_id}:${issue}`)
  ));
  const blockers = [...new Set([
    ...input.proofs.flatMap((proof) => proof.blockers),
    ...proofValidationBlockers
  ])];
  const sequential = Math.max(input.wallMs, input.proofs.length * Math.max(1, Math.floor(input.wallMs / Math.max(1, input.maxActiveLoops))));
  return {
    schema: 'sks.loop-graph-proof.v1',
    mission_id: input.missionId,
    ok: blockers.length === 0 && failed.length === 0,
    total_loops: input.proofs.length,
    completed_loops: input.proofs.filter(loopProofIsVerifiedComplete).length,
    blocked_loops: input.proofs.filter((proof) => proof.status === 'blocked').length,
    failed_loops: input.proofs.filter((proof) => proof.status === 'failed').length,
    handoff_loops: input.proofs.filter((proof) => proof.status === 'handoff').length,
    parallelism: {
      max_active_loops: input.maxActiveLoops,
      max_active_workers: input.maxActiveWorkers,
      wall_ms: input.wallMs,
      sequential_estimate_ms: sequential,
      speedup_ratio: Number((sequential / Math.max(1, input.wallMs)).toFixed(2))
    },
    gates: { selected, passed, failed, skipped },
    blockers
  };
}
