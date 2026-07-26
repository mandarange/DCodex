/**
 * Hard safety floors.
 *
 * These are evaluated before anything is scored. A floor is not a weighted
 * component: if one fails the composite score is not computed at all, so a leak
 * or a missed protected gate can never be traded away against a latency win.
 */
import { containsPlaintextSecret } from '../../../secret-redaction.js';
import { isWorkspaceRelativePosixPath } from '../paths.js';
import { conflictKey, runSignature } from './metrics.js';
import { FIXTURE_ABSOLUTE_PATH, FIXTURE_SECRET_TOKEN } from './fixtures/index.js';
import {
  type ContextGraphBenchmarkAdapterKind,
  type ContextGraphBenchmarkCaseMetrics,
  type ContextGraphBenchmarkFloorId,
  type ContextGraphBenchmarkFloorReport,
  type ContextGraphBenchmarkFloorResult,
  type ContextGraphBenchmarkRun
} from './types.js';

/** Path shapes that must never appear in a graph artifact, a run result, or the report. */
const PATH_LEAK_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'absolute_posix_user_home', pattern: /(?:^|["'\s:=(,[])\/(?:Users|home|root)\// },
  { id: 'absolute_posix_tmp', pattern: /(?:^|["'\s:=(,[])\/(?:private\/)?(?:var\/folders|tmp)\// },
  { id: 'absolute_windows_drive', pattern: /(?:^|["'\s:=(,[])[A-Za-z]:[\\/]/ },
  { id: 'tilde_home', pattern: /(?:^|["'\s:=(,[])~\// },
  { id: 'unc_path', pattern: /\\\\\?\\/ }
];

const SECRET_LEAK_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'aws_access_key_shape', pattern: /\bAKIA[0-9A-Z]{12,}\b/ },
  { id: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'jwt_shape', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./ }
];

/**
 * Returns the ids of the rules a text violates. The matched text itself is never
 * returned, so a leak report cannot become a second copy of the leak.
 */
export function scanForLeaks(text: string): { secretRules: string[]; pathRules: string[] } {
  const secretRules = new Set<string>();
  const pathRules = new Set<string>();
  if (!text) return { secretRules: [], pathRules: [] };
  if (text.includes(FIXTURE_SECRET_TOKEN)) secretRules.add('fixture_secret_canary');
  if (text.includes(FIXTURE_ABSOLUTE_PATH)) pathRules.add('fixture_absolute_path_canary');
  for (const rule of SECRET_LEAK_RULES) if (rule.pattern.test(text)) secretRules.add(rule.id);
  for (const rule of PATH_LEAK_RULES) if (rule.pattern.test(text)) pathRules.add(rule.id);
  if (containsPlaintextSecret(text)) secretRules.add('plaintext_secret');
  return { secretRules: [...secretRules].sort(), pathRules: [...pathRules].sort() };
}

function runPayload(run: ContextGraphBenchmarkRun): string {
  return JSON.stringify({
    matchedPaths: run.matchedPaths,
    matchedNodeIds: run.matchedNodeIds,
    selectedGateIds: run.selectedGateIds,
    selectedTestPaths: run.selectedTestPaths,
    writeScopeConflicts: run.writeScopeConflicts.map(conflictKey),
    staleIncluded: run.staleIncluded,
    invalidatedIncluded: run.invalidatedIncluded,
    exactSeedsPreserved: run.exactSeedsPreserved,
    errorCode: run.errorCode
  });
}

export interface BenchmarkFloorInput {
  readonly adapterId: string;
  readonly adapterKind: ContextGraphBenchmarkAdapterKind;
  readonly runs: readonly ContextGraphBenchmarkRun[];
  readonly rows: readonly ContextGraphBenchmarkCaseMetrics[];
}

interface FloorSpec {
  readonly id: ContextGraphBenchmarkFloorId;
  readonly label: string;
  readonly appliesTo: 'all' | 'candidate';
  readonly comparison: 'lte' | 'gte';
  readonly limit: number;
  measure(input: BenchmarkFloorInput): { observed: number; detail: string[] };
}

function countSecretLeaks(input: BenchmarkFloorInput): { observed: number; detail: string[] } {
  const detail = new Set<string>();
  let observed = 0;
  for (const run of input.runs) {
    for (const rule of run.safety.secretLeaks) {
      observed += 1;
      detail.add(`${run.caseId}:${rule}`);
    }
    const scan = scanForLeaks(runPayload(run));
    for (const rule of scan.secretRules) {
      observed += 1;
      detail.add(`${run.caseId}:${rule}`);
    }
  }
  return { observed, detail: [...detail].sort() };
}

function countPathLeaks(input: BenchmarkFloorInput): { observed: number; detail: string[] } {
  const detail = new Set<string>();
  let observed = 0;
  for (const run of input.runs) {
    for (const rule of run.safety.pathLeaks) {
      observed += 1;
      detail.add(`${run.caseId}:${rule}`);
    }
    const scan = scanForLeaks(runPayload(run));
    for (const rule of scan.pathRules) {
      observed += 1;
      detail.add(`${run.caseId}:${rule}`);
    }
    for (const candidate of [...run.matchedPaths, ...run.selectedTestPaths]) {
      if (isWorkspaceRelativePosixPath(candidate)) continue;
      observed += 1;
      detail.add(`${run.caseId}:non_workspace_relative_result`);
    }
  }
  return { observed, detail: [...detail].sort() };
}

function countDeterminismMismatch(input: BenchmarkFloorInput): { observed: number; detail: string[] } {
  const byCase = new Map<string, ContextGraphBenchmarkRun[]>();
  for (const run of input.runs) {
    const bucket = byCase.get(run.caseId);
    if (bucket) bucket.push(run);
    else byCase.set(run.caseId, [run]);
  }
  const detail = new Set<string>();
  let observed = 0;
  for (const [caseId, runs] of byCase) {
    const first = runs[0];
    if (!first) continue;
    const baselineSignature = runSignature(first);
    const baselineHash = runs.find((run) => run.safety.snapshotHash)?.safety.snapshotHash ?? null;
    for (const run of runs) {
      if (runSignature(run) !== baselineSignature) {
        observed += 1;
        detail.add(`${caseId}:answer_not_reproducible`);
      }
      const hash = run.safety.snapshotHash;
      if (baselineHash && hash && hash !== baselineHash) {
        observed += 1;
        detail.add(`${caseId}:snapshot_hash_drift`);
      }
      const determinism = run.safety.determinismHash;
      if (hash && determinism && hash !== determinism) {
        observed += 1;
        detail.add(`${caseId}:recompile_hash_mismatch`);
      }
    }
  }
  return { observed, detail: [...detail].sort() };
}

function sumRuns(
  input: BenchmarkFloorInput,
  pick: (run: ContextGraphBenchmarkRun) => number,
  reason: string
): { observed: number; detail: string[] } {
  const detail = new Set<string>();
  let observed = 0;
  for (const run of input.runs) {
    const value = Math.max(0, pick(run));
    if (value > 0) {
      observed += value;
      detail.add(`${run.caseId}:${reason}`);
    }
  }
  return { observed, detail: [...detail].sort() };
}

function fullRecall(
  input: BenchmarkFloorInput,
  pick: (row: ContextGraphBenchmarkCaseMetrics) => number,
  required: (row: ContextGraphBenchmarkCaseMetrics) => boolean,
  reason: string
): { observed: number; detail: string[] } {
  const applicable = input.rows.filter(required);
  if (!applicable.length) return { observed: 1, detail: [] };
  const detail: string[] = [];
  let total = 0;
  for (const row of applicable) {
    const value = pick(row);
    total += value;
    if (value < 1) detail.push(`${row.caseId}:${reason}`);
  }
  return { observed: total / applicable.length, detail: detail.sort() };
}

const FLOOR_SPECS: readonly FloorSpec[] = [
  {
    id: 'secret_leak_zero',
    label: 'no secret-shaped value reaches a result or an artifact',
    appliesTo: 'all',
    comparison: 'lte',
    limit: 0,
    measure: countSecretLeaks
  },
  {
    id: 'path_leak_zero',
    label: 'no absolute, home or temp path reaches a result or an artifact',
    appliesTo: 'all',
    comparison: 'lte',
    limit: 0,
    measure: countPathLeaks
  },
  {
    id: 'dangling_edge_zero',
    label: 'no edge points at a node that is not in the snapshot',
    appliesTo: 'all',
    comparison: 'lte',
    limit: 0,
    measure: (input) => sumRuns(input, (run) => run.safety.danglingEdges, 'dangling_edge')
  },
  {
    id: 'edge_without_provenance_zero',
    label: 'every edge carries path, hash and extractor provenance',
    appliesTo: 'all',
    comparison: 'lte',
    limit: 0,
    measure: (input) => sumRuns(input, (run) => run.safety.edgesWithoutProvenance, 'edge_without_provenance')
  },
  {
    id: 'deterministic_snapshot_zero_mismatch',
    label: 'the same input compiles and answers identically every time',
    appliesTo: 'all',
    comparison: 'lte',
    limit: 0,
    measure: countDeterminismMismatch
  },
  {
    id: 'protected_gate_recall_full',
    label: 'every protected gate in a gold set is returned',
    appliesTo: 'candidate',
    comparison: 'gte',
    limit: 1,
    measure: (input) =>
      fullRecall(input, (row) => row.protectedGateRecall, () => true, 'protected_gate_missed')
  },
  {
    id: 'write_scope_conflict_recall_full',
    label: 'every declared parallel write-scope conflict is detected',
    appliesTo: 'candidate',
    comparison: 'gte',
    limit: 1,
    measure: (input) => fullRecall(input, (row) => row.conflictRecall, () => true, 'conflict_missed')
  },
  {
    id: 'stale_graph_silent_fallback_zero',
    label: 'a missing or stale graph surfaces an error instead of silently searching text',
    appliesTo: 'all',
    comparison: 'lte',
    limit: 0,
    measure: (input) => sumRuns(input, (run) => (run.safety.silentTextFallback ? 1 : 0), 'silent_text_fallback')
  },
  {
    id: 'unsupported_language_exact_mislabel_zero',
    label: 'nothing from an unsupported language is labelled an exact relation',
    appliesTo: 'all',
    comparison: 'lte',
    limit: 0,
    measure: (input) =>
      sumRuns(input, (run) => run.safety.unsupportedLanguageExactClaims.length, 'unsupported_language_exact')
  },
  {
    id: 'project_code_execution_zero',
    label: 'no workspace or project code is executed or dynamically imported',
    appliesTo: 'all',
    comparison: 'lte',
    limit: 0,
    measure: (input) =>
      sumRuns(input, (run) => run.safety.projectCodeExecutions + run.safety.processSpawns, 'code_execution_or_spawn')
  },
  {
    id: 'unbounded_hot_path_scan_zero',
    label: 'the hot path never scans more files than its declared budget',
    appliesTo: 'all',
    comparison: 'lte',
    limit: 0,
    measure: (input) =>
      sumRuns(
        input,
        (run) => (run.safety.scannedFiles > run.safety.scanBudget ? run.safety.scannedFiles - run.safety.scanBudget : 0),
        'scan_budget_exceeded'
      )
  }
];

export function benchmarkFloorSpecIds(): readonly ContextGraphBenchmarkFloorId[] {
  return FLOOR_SPECS.map((spec) => spec.id);
}

export function evaluateBenchmarkFloors(inputs: readonly BenchmarkFloorInput[]): ContextGraphBenchmarkFloorReport {
  const results: ContextGraphBenchmarkFloorResult[] = [];
  for (const input of inputs) {
    for (const spec of FLOOR_SPECS) {
      if (spec.appliesTo === 'candidate' && input.adapterKind !== 'candidate') continue;
      const { observed, detail } = spec.measure(input);
      const passed = spec.comparison === 'lte' ? observed <= spec.limit : observed >= spec.limit;
      results.push({
        id: spec.id,
        label: spec.label,
        appliesTo: spec.appliesTo,
        adapterId: input.adapterId,
        adapterKind: input.adapterKind,
        passed,
        observed,
        limit: spec.limit,
        comparison: spec.comparison,
        detail
      });
    }
  }
  const failed = results.filter((result) => !result.passed).length;
  return { ok: failed === 0, evaluated: results.length, failed, results };
}
