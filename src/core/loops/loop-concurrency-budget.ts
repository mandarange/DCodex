import os from 'node:os';
import { writeJsonAtomic } from '../fsx.js';
import { loopConcurrencyBudgetPath } from './loop-artifacts.js';
import type { SksLoopPlan } from './loop-schema.js';

export interface LoopCodexUsageSignal {
  available: boolean;
  certainty: 'actual' | 'discovered' | 'fixture' | 'assumed_by_version' | 'unverified';
  source: 'codex-current-feature-usage' | 'env' | 'fixture' | 'none';
  evidence: string[];
  warnings: string[];
}

export interface LoopConcurrencyBudget {
  schema: 'sks.loop-concurrency-budget.v1';
  mission_id: string;
  usage_budget_source: 'codex-current-feature-usage' | 'sks-local-estimate';
  codex_usage_signal: LoopCodexUsageSignal;
  max_active_loops: number;
  max_active_workers: number;
  max_model_calls: number;
  per_loop_worker_budget: Array<{
    loop_id: string;
    maker_workers: number;
    checker_workers: number;
    model_call_budget: number;
  }>;
  headroom_workers: number;
  blockers: string[];
}

export function computeLoopConcurrencyBudget(input: {
  plan: SksLoopPlan;
  parallelism?: 'safe' | 'balanced' | 'extreme';
  env?: NodeJS.ProcessEnv;
  codexUsageSignal?: LoopCodexUsageSignal;
}): LoopConcurrencyBudget {
  const env = input.env || process.env;
  const codexUsageSignal = input.codexUsageSignal || codexUsageSignalFromEnv(env);
  const usageBudgetSource = codexUsageSignal.available && (codexUsageSignal.certainty === 'actual' || codexUsageSignal.certainty === 'discovered')
    ? 'codex-current-feature-usage'
    : 'sks-local-estimate';
  const cores = Math.max(1, os.cpus().length || 1);
  const requestedLoops = input.parallelism === 'safe' ? 1 : input.parallelism === 'extreme' ? Math.min(4, cores) : Math.min(2, cores);
  const envLoops = positiveInt(env.SKS_LOOP_MAX_ACTIVE_LOOPS);
  const envWorkers = positiveInt(env.SKS_LOOP_MAX_ACTIVE_WORKERS);
  const envModelCalls = positiveInt(env.SKS_LOOP_MAX_MODEL_CALLS);
  const maxActiveLoops = Math.min(requestedLoops, envLoops || requestedLoops);
  const requestedWorkers = input.parallelism === 'safe' ? Math.min(2, cores) : input.parallelism === 'extreme' ? Math.min(4, cores) : Math.min(3, cores);
  const maxActiveWorkers = Math.min(requestedWorkers, envWorkers || requestedWorkers);
  const requestedModelCalls = Math.max(1, Math.min(maxActiveWorkers, input.plan.global_budget.max_model_calls || maxActiveWorkers));
  const maxModelCalls = Math.min(requestedModelCalls, envModelCalls || requestedModelCalls);
  let remainingWorkers = maxActiveWorkers;
  let remainingModelCalls = maxModelCalls;
  const perLoop = input.plan.graph.nodes.map((node) => {
    const requested = Math.max(1, node.maker.worker_count + node.checker.worker_count);
    const fairShare = Math.max(1, Math.floor(maxActiveWorkers / Math.max(1, input.plan.graph.nodes.length)));
    const allocation = Math.min(requested, Math.max(1, fairShare), Math.max(1, remainingWorkers));
    const maker = Math.min(node.maker.worker_count, Math.max(1, Math.ceil(allocation / 2)));
    const checker = Math.min(node.checker.worker_count, Math.max(0, allocation - maker));
    const modelCalls = Math.min(Math.max(1, node.budget.max_model_calls), Math.max(1, remainingModelCalls));
    remainingWorkers = Math.max(0, remainingWorkers - maker - checker);
    remainingModelCalls = Math.max(0, remainingModelCalls - modelCalls);
    return {
      loop_id: node.loop_id,
      maker_workers: maker,
      checker_workers: checker,
      model_call_budget: modelCalls
    };
  });
  return {
    schema: 'sks.loop-concurrency-budget.v1',
    mission_id: input.plan.mission_id,
    usage_budget_source: usageBudgetSource,
    codex_usage_signal: codexUsageSignal,
    max_active_loops: maxActiveLoops,
    max_active_workers: maxActiveWorkers,
    max_model_calls: maxModelCalls,
    per_loop_worker_budget: perLoop,
    headroom_workers: Math.max(0, maxActiveWorkers - perLoop.reduce((sum, row) => sum + row.maker_workers + row.checker_workers, 0)),
    blockers: []
  };
}

export async function writeLoopConcurrencyBudget(root: string, budget: LoopConcurrencyBudget): Promise<void> {
  await writeJsonAtomic(loopConcurrencyBudgetPath(root, budget.mission_id), { ...budget, generated_at: new Date().toISOString() });
}

export function loopWorkerBudgetFor(budget: LoopConcurrencyBudget, loopId: string, phase: 'maker' | 'checker', requested: number): number {
  const row = budget.per_loop_worker_budget.find((item) => item.loop_id === loopId);
  const allowed = phase === 'maker' ? row?.maker_workers : row?.checker_workers;
  return Math.max(1, Math.min(Math.max(1, requested), Math.max(1, allowed || requested)));
}

function positiveInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : null;
}

function codexUsageSignalFromEnv(env: NodeJS.ProcessEnv): LoopCodexUsageSignal {
  const certainty = normalizeUsageCertainty(env.SKS_CODEX_CURRENT_FEATURE_USAGE_CERTAINTY);
  const available = env.SKS_CODEX_CURRENT_FEATURE_USAGE_AVAILABLE === '1' || certainty === 'actual' || certainty === 'discovered';
  return {
    available,
    certainty,
    source: available ? 'env' : 'none',
    evidence: env.SKS_CODEX_CURRENT_FEATURE_USAGE_EVIDENCE ? [env.SKS_CODEX_CURRENT_FEATURE_USAGE_EVIDENCE] : [],
    warnings: available ? [] : ['codex_current_feature_usage_signal_unavailable_using_local_estimate']
  };
}

function normalizeUsageCertainty(value: unknown): LoopCodexUsageSignal['certainty'] {
  if (value === 'actual' || value === 'discovered' || value === 'fixture' || value === 'assumed_by_version') return value;
  return 'unverified';
}
