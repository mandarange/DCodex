/**
 * The bounded experiment loop.
 *
 * Fixed order, no configurable shortcuts:
 *   baseline -> validate -> run under an identical budget -> hard floors ->
 *   composite comparison -> working-tree guard -> log -> (only if it won) a
 *   proposed-patch artifact.
 *
 * Three properties are enforced here rather than documented:
 *   - a candidate that names anything outside the two tuning files never runs;
 *   - a candidate that trips a hard floor is discarded before its score is
 *     consulted, so a safety regression can never be traded for a latency win;
 *   - the guarded surface is re-fingerprinted after every experiment, so a run
 *     that somehow mutated the working tree aborts instead of continuing.
 *
 * The loop never commits, pushes, merges, publishes, or edits a source file. The
 * best candidate is a proposal that a human still has to review.
 */
import { shortDigest } from '../ids.js';
import { runContextGraphBenchmark } from '../benchmark/runner.js';
import type { ContextGraphBenchmarkReport } from '../benchmark/types.js';
import {
  appendContextGraphExperimentRecord,
  buildContextGraphPatchArtifact,
  writeContextGraphPatchArtifact
} from './artifact.js';
import { generateContextGraphCandidates, type ContextGraphCandidatePlan } from './candidates.js';
import { contextGraphSurfaceDrift, fingerprintContextGraphTuningSurface } from './guard.js';
import { benchmarkOptionsFor, toContextGraphExperimentRecord } from './record.js';
import { baselineContextGraphTuning } from './resolve.js';
import { validateContextGraphCandidate } from './validate.js';
import {
  CONTEXT_GRAPH_OPTIMIZER_SCHEMA,
  type ContextGraphBenchmarkRunner,
  type ContextGraphExperimentBudget,
  type ContextGraphExperimentCandidate,
  type ContextGraphExperimentOutcome,
  type ContextGraphExperimentRecord,
  type ContextGraphOptimizerAdapterFactory,
  type ContextGraphOptimizerRunResult,
  type ContextGraphResolvedTuning,
  type ContextGraphSurfaceFingerprint,
  type ContextGraphTuningPatchArtifact
} from './types.js';

/** Below this the two composites are the same number wearing different rounding. */
export const CONTEXT_GRAPH_MIN_COMPOSITE_GAIN = 1e-6;
export const CONTEXT_GRAPH_DEFAULT_MAX_EXPERIMENT_MS = 10 * 60 * 1000;

export interface ContextGraphOptimizerOptions {
  readonly root: string;
  /** Supplies the baseline/candidate adapter pair for one experiment's tuning. */
  readonly adapters: ContextGraphOptimizerAdapterFactory;
  readonly candidates?: readonly ContextGraphExperimentCandidate[];
  readonly plan?: ContextGraphCandidatePlan;
  /** Injected benchmark driver; defaults to the locked harness. */
  readonly benchmark?: ContextGraphBenchmarkRunner;
  readonly corpus?: unknown;
  readonly corpusPath?: string;
  readonly caseIds?: readonly string[];
  readonly coldIterations?: number;
  readonly warmIterations?: number;
  readonly maxCandidates?: number;
  readonly maxDurationMs?: number;
  readonly minCompositeGain?: number;
  readonly now?: string;
  readonly runId?: string;
  readonly tmpDir?: string;
  readonly skipGitFixtures?: boolean;
  /** Defaults to true. When false the loop still decides, it just persists nothing. */
  readonly writeArtifacts?: boolean;
  readonly logMaxBytes?: number;
  readonly clock?: () => number;
}

interface ExperimentExecution {
  readonly report: ContextGraphBenchmarkReport | null;
  readonly errorName: string | null;
  readonly durationMs: number;
}

/**
 * Run the loop. Returns the full decision trail; the only side effects are the
 * bounded JSONL log and, for a candidate that won, one proposed-patch artifact —
 * both under the workspace report directory.
 */
export async function runContextGraphOptimizerLoop(
  options: ContextGraphOptimizerOptions
): Promise<ContextGraphOptimizerRunResult> {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const generatedAt = options.now ?? new Date(startedAt).toISOString();
  const runner: ContextGraphBenchmarkRunner = options.benchmark ?? runContextGraphBenchmark;
  const writeArtifacts = options.writeArtifacts !== false;
  const minGain = Math.max(0, options.minCompositeGain ?? CONTEXT_GRAPH_MIN_COMPOSITE_GAIN);
  const maxDurationMs = Math.max(0, options.maxDurationMs ?? CONTEXT_GRAPH_DEFAULT_MAX_EXPERIMENT_MS);
  const benchmarkOptions = benchmarkOptionsFor(options, generatedAt);

  const planned = options.candidates ?? generateContextGraphCandidates(options.plan ?? {});
  const maxCandidates = Math.max(0, Math.trunc(options.maxCandidates ?? planned.length));
  const candidates = planned.slice(0, maxCandidates);
  const runId = options.runId ?? `opt-${shortDigest(`${generatedAt}|${candidates.length}`, 12)}`;
  const budget: ContextGraphExperimentBudget = {
    caseIds: [...(options.caseIds ?? [])],
    coldIterations: options.coldIterations ?? 1,
    warmIterations: options.warmIterations ?? 3,
    maxCandidates,
    maxDurationMs
  };

  const before = fingerprintContextGraphTuningSurface(options.root);
  const experiments: ContextGraphExperimentRecord[] = [];
  const kept: ContextGraphTuningPatchArtifact[] = [];
  const notes: string[] = [];
  let abortReason: string | null = null;

  const execute = async (
    experimentId: string,
    candidateId: string | null,
    tuning: ContextGraphResolvedTuning
  ): Promise<ExperimentExecution> => {
    const began = clock();
    try {
      const adapters = await options.adapters({ experimentId, candidateId, tuning });
      const report = await runner(adapters, benchmarkOptions);
      return { report, errorName: null, durationMs: Math.max(0, clock() - began) };
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UnknownError';
      return { report: null, errorName: name, durationMs: Math.max(0, clock() - began) };
    }
  };

  const commit = async (record: ContextGraphExperimentRecord): Promise<void> => {
    experiments.push(record);
    if (!writeArtifacts) return;
    const written = await appendContextGraphExperimentRecord(
      options.root,
      record,
      options.logMaxBytes ?? undefined
    ).catch(() => null);
    if (written && !written.written) notes.push(`experiment_log_skipped:${written.leakRules.join(',')}`);
  };

  // --- Baseline ------------------------------------------------------------
  const baselineRun = await execute('baseline', null, baselineContextGraphTuning());
  const afterBaseline = fingerprintContextGraphTuningSurface(options.root);
  const baselineDrift = contextGraphSurfaceDrift(before, afterBaseline);
  const baselineReport = baselineRun.report;
  const baselineComposite = baselineReport?.score?.candidate.composite ?? null;

  if (baselineDrift.length) abortReason = 'working_tree_mutated';
  else if (!baselineReport) abortReason = `baseline_adapter_error:${baselineRun.errorName ?? 'UnknownError'}`;
  else if (!baselineReport.integrity.ok) abortReason = 'benchmark_integrity_failure';
  else if (!baselineReport.floors.ok) abortReason = 'baseline_floor_failure';
  else if (baselineComposite === null) abortReason = 'baseline_score_unavailable';

  const baselineRecord = toContextGraphExperimentRecord({
    runId,
    experimentId: 'baseline',
    candidateId: null,
    label: 'checked-in tuning',
    outcome: 'baseline',
    verdict: null,
    rejectionCodes: abortReason ? [abortReason] : [],
    overrides: [],
    appliedPointers: [],
    report: baselineReport,
    baselineComposite,
    budget,
    surfaceDigest: afterBaseline.digest,
    surfaceDrift: baselineDrift,
    artifactPath: null,
    durationMs: baselineRun.durationMs,
    ts: generatedAt
  });
  await commit(baselineRecord);

  if (abortReason !== null || baselineComposite === null || !baselineReport) {
    return finish({
      runId,
      generatedAt,
      budget,
      baseline: baselineRecord,
      experiments,
      kept,
      before,
      after: afterBaseline,
      abortReason: abortReason ?? 'baseline_score_unavailable',
      notes,
      durationMs: Math.max(0, clock() - startedAt)
    });
  }

  // --- Candidates ----------------------------------------------------------
  let index = 0;
  for (const candidate of candidates) {
    index += 1;
    const experimentId = `${runId}#${String(index).padStart(3, '0')}`;
    const verdict = validateContextGraphCandidate(candidate);
    const label = typeof candidate.label === 'string' ? candidate.label : '';

    if (verdict.kind !== 'accepted' || !verdict.tuning) {
      await commit(
        toContextGraphExperimentRecord({
          runId,
          experimentId,
          candidateId: verdict.candidateId || null,
          label,
          outcome: verdict.kind === 'integrity_violation' ? 'integrity_violation' : 'rejected',
          verdict: verdict.kind,
          rejectionCodes: verdict.rejections.map((item) => item.code),
          overrides: [],
          appliedPointers: [],
          report: null,
          baselineComposite,
          budget,
          surfaceDigest: afterBaseline.digest,
          surfaceDrift: [],
          artifactPath: null,
          durationMs: 0,
          ts: generatedAt
        })
      );
      continue;
    }

    if (maxDurationMs > 0 && clock() - startedAt >= maxDurationMs) {
      await commit(
        toContextGraphExperimentRecord({
          runId,
          experimentId,
          candidateId: candidate.id,
          label,
          outcome: 'skipped_budget',
          verdict: verdict.kind,
          rejectionCodes: ['budget_exhausted'],
          overrides: candidate.overrides,
          appliedPointers: verdict.tuning.appliedPointers,
          report: null,
          baselineComposite,
          budget,
          surfaceDigest: afterBaseline.digest,
          surfaceDrift: [],
          artifactPath: null,
          durationMs: 0,
          ts: generatedAt
        })
      );
      continue;
    }

    const run = await execute(experimentId, candidate.id, verdict.tuning);
    const after = fingerprintContextGraphTuningSurface(options.root);
    const drift = contextGraphSurfaceDrift(before, after);
    const report = run.report;
    const composite = report?.score?.candidate.composite ?? null;

    let outcome: ContextGraphExperimentOutcome;
    if (drift.length) outcome = 'discarded_integrity';
    else if (!report) outcome = 'discarded_error';
    else if (!report.integrity.ok) outcome = 'discarded_integrity';
    else if (!report.floors.ok) outcome = 'discarded_floor';
    else if (composite === null || !report.score?.passed) outcome = 'discarded_error';
    else if (composite > baselineComposite + minGain) outcome = 'kept';
    else outcome = 'discarded_no_gain';

    let artifactPath: string | null = null;
    if (outcome === 'kept' && report && composite !== null) {
      const artifact = buildContextGraphPatchArtifact({
        runId,
        experimentId,
        candidateId: candidate.id,
        label,
        rationale: typeof candidate.rationale === 'string' ? candidate.rationale : '',
        overrides: candidate.overrides,
        baselineComposite,
        candidateComposite: composite,
        improvement: report.score?.improvement ?? 0,
        corpusRevision: report.corpusRevision,
        corpusHash: report.integrity.corpusHash,
        scoringCodeHash: report.integrity.scoringCodeHash,
        budget,
        generatedAt,
        surfaceDigest: after.digest
      });
      kept.push(artifact);
      if (writeArtifacts) {
        const written = writeContextGraphPatchArtifact(options.root, artifact);
        if (written.written) artifactPath = written.relativePath;
        else notes.push(`patch_artifact_skipped:${written.leakRules.join(',')}`);
      }
    }

    await commit(
      toContextGraphExperimentRecord({
        runId,
        experimentId,
        candidateId: candidate.id,
        label,
        outcome,
        verdict: verdict.kind,
        rejectionCodes: run.errorName ? [`adapter_error:${run.errorName}`] : [],
        overrides: candidate.overrides,
        appliedPointers: verdict.tuning.appliedPointers,
        report,
        baselineComposite,
        budget,
        surfaceDigest: after.digest,
        surfaceDrift: drift,
        artifactPath,
        durationMs: run.durationMs,
        ts: generatedAt
      })
    );

    if (drift.length) {
      abortReason = 'working_tree_mutated';
      break;
    }
  }

  return finish({
    runId,
    generatedAt,
    budget,
    baseline: baselineRecord,
    experiments,
    kept,
    before,
    after: fingerprintContextGraphTuningSurface(options.root),
    abortReason,
    notes,
    durationMs: Math.max(0, clock() - startedAt)
  });
}

interface FinishInput {
  readonly runId: string;
  readonly generatedAt: string;
  readonly budget: ContextGraphExperimentBudget;
  readonly baseline: ContextGraphExperimentRecord | null;
  readonly experiments: readonly ContextGraphExperimentRecord[];
  readonly kept: readonly ContextGraphTuningPatchArtifact[];
  readonly before: ContextGraphSurfaceFingerprint;
  readonly after: ContextGraphSurfaceFingerprint;
  readonly abortReason: string | null;
  readonly notes: readonly string[];
  readonly durationMs: number;
}

function finish(input: FinishInput): ContextGraphOptimizerRunResult {
  const drift = contextGraphSurfaceDrift(input.before, input.after);
  const best = [...input.kept].sort((left, right) => right.compositeDelta - left.compositeDelta)[0] ?? null;
  return {
    schema: CONTEXT_GRAPH_OPTIMIZER_SCHEMA,
    ok: input.abortReason === null && drift.length === 0,
    runId: input.runId,
    generatedAt: input.generatedAt,
    budget: input.budget,
    baseline: input.baseline,
    experiments: input.experiments,
    kept: input.kept,
    best,
    surfaceDigestBefore: input.before.digest,
    surfaceDigestAfter: input.after.digest,
    surfaceDrift: drift,
    abortReason: input.abortReason,
    reviewRequired: true,
    notes: [...input.notes].sort(),
    durationMs: input.durationMs
  };
}
