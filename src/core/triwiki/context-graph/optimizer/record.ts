/**
 * Experiment log rows.
 *
 * One place builds every row, so the log is homogeneous whether the experiment
 * ran, was refused before it ran, or was skipped for budget. Every field is an
 * id, a code, a pointer, or a number: the row is safe to append verbatim.
 */
import type { ContextGraphBenchmarkOptions } from '../benchmark/runner.js';
import type { ContextGraphBenchmarkReport } from '../benchmark/types.js';
import {
  CONTEXT_GRAPH_EXPERIMENT_LOG_SCHEMA,
  type ContextGraphExperimentBudget,
  type ContextGraphExperimentOutcome,
  type ContextGraphExperimentRecord,
  type ContextGraphParameterOverride
} from './types.js';

export function failedFloorIds(report: ContextGraphBenchmarkReport): string[] {
  const out = new Set<string>();
  for (const result of report.floors.results) if (!result.passed) out.add(result.id);
  return [...out].sort();
}

export interface BenchmarkBudgetInput {
  readonly root: string;
  readonly corpus?: unknown;
  readonly corpusPath?: string | undefined;
  readonly caseIds?: readonly string[] | undefined;
  readonly coldIterations?: number | undefined;
  readonly warmIterations?: number | undefined;
  readonly tmpDir?: string | undefined;
  readonly skipGitFixtures?: boolean | undefined;
}

/**
 * The single benchmark invocation shape every experiment shares. Frozen once per
 * run so no candidate can be measured against a cheaper or a longer budget.
 */
export function benchmarkOptionsFor(input: BenchmarkBudgetInput, now: string): ContextGraphBenchmarkOptions {
  return {
    root: input.root,
    ...(input.corpus === undefined ? {} : { corpus: input.corpus }),
    ...(input.corpusPath === undefined ? {} : { corpusPath: input.corpusPath }),
    ...(input.caseIds === undefined ? {} : { caseIds: input.caseIds }),
    ...(input.coldIterations === undefined ? {} : { coldIterations: input.coldIterations }),
    ...(input.warmIterations === undefined ? {} : { warmIterations: input.warmIterations }),
    ...(input.tmpDir === undefined ? {} : { tmpDir: input.tmpDir }),
    ...(input.skipGitFixtures === undefined ? {} : { skipGitFixtures: input.skipGitFixtures }),
    now,
    // The loop writes its own artifacts. A per-experiment benchmark report would
    // overwrite the previous experiment's numbers at the same path.
    writeReport: false
  };
}

export interface ExperimentRecordInput {
  readonly runId: string;
  readonly experimentId: string;
  readonly candidateId: string | null;
  readonly label: string;
  readonly outcome: ContextGraphExperimentOutcome;
  readonly verdict: ContextGraphExperimentRecord['verdict'];
  readonly rejectionCodes: readonly string[];
  readonly overrides: readonly ContextGraphParameterOverride[];
  readonly appliedPointers: readonly string[];
  readonly report: ContextGraphBenchmarkReport | null;
  readonly baselineComposite: number | null;
  readonly budget: ContextGraphExperimentBudget;
  readonly surfaceDigest: string;
  readonly surfaceDrift: readonly string[];
  readonly artifactPath: string | null;
  readonly durationMs: number;
  readonly ts: string;
}

export function toContextGraphExperimentRecord(input: ExperimentRecordInput): ContextGraphExperimentRecord {
  const report = input.report;
  const composite = report?.score?.candidate.composite ?? null;
  const delta = composite !== null && input.baselineComposite !== null ? composite - input.baselineComposite : null;
  return {
    schema: CONTEXT_GRAPH_EXPERIMENT_LOG_SCHEMA,
    ts: input.ts,
    runId: input.runId,
    experimentId: input.experimentId,
    candidateId: input.candidateId,
    label: input.label,
    outcome: input.outcome,
    verdict: input.verdict,
    rejectionCodes: [...input.rejectionCodes].sort(),
    overrides: input.overrides,
    appliedPointers: input.appliedPointers,
    corpusRevision: report?.corpusRevision ?? null,
    corpusHash: report?.integrity.corpusHash ?? null,
    scoringCodeHash: report?.integrity.scoringCodeHash ?? null,
    baselineComposite: input.baselineComposite,
    candidateComposite: composite,
    compositeDelta: delta === null ? null : Math.round(delta * 1e6) / 1e6,
    improvement: report?.score?.improvement ?? null,
    floorsOk: report ? report.floors.ok : null,
    failedFloorIds: report ? failedFloorIds(report) : [],
    budget: input.budget,
    surfaceDigest: input.surfaceDigest,
    surfaceDrift: input.surfaceDrift,
    artifactPath: input.artifactPath,
    reviewRequired: true,
    durationMs: input.durationMs
  };
}
