/**
 * The test-only v1/v2 comparison seam (ADR §10).
 *
 * Both engines arrive as explicit arguments. There is deliberately no
 * environment variable, no config lookup, and no runtime branch that could pick
 * one engine over the other: a seam reachable from configuration is a fallback,
 * and ADR §1 forbids fallbacks because they make the performance floor
 * unobservable and the correctness floor unprovable. `crk2-comparison.test.ts`
 * asserts this module's source contains no environment read, so the property is
 * checked rather than promised.
 *
 * The report never publishes a latency figure without the recall for the same
 * case beside it. The v1 baseline's two fastest cases, `korean` and `jargon`,
 * were fast because they matched nothing; `fast_but_empty` is the verdict that
 * names that pattern instead of celebrating it.
 */
import {
  CRK2_BENCHMARK_COMPARISON_SCHEMA,
  type Crk2Case,
  type Crk2CaseComparison,
  type Crk2CaseMetrics,
  type Crk2CaseVerdict,
  type Crk2ComparisonReport,
  type Crk2Engine,
  type Crk2EngineRequest,
  type Crk2EngineResult,
  type Crk2FloorReport
} from './crk2-types.js';
import { CRK2_CASES, CRK2_CORPUS_REVISION } from './crk2-corpus.js';
import { crk2ResultSignature, evaluateCrk2Case, summarizeCrk2Engine } from './crk2-metrics.js';
import { evaluateCrk2Floors } from './crk2-floors.js';

export const CRK2_DEFAULT_REPEATS = 32;
export const CRK2_DEFAULT_WARMUPS = 2;

export interface Crk2ComparisonOptions {
  /** Absolute path to a materialized `crk2-retrieval` workspace. Never written into the report. */
  readonly retrievalRoot: string;
  /** Absolute path to a materialized `crk2-fault` workspace. Never written into the report. */
  readonly faultRoot: string;
  readonly cases?: readonly Crk2Case[];
  /** Measured repeats per case, after warmups. Work order §12.4 asks for at least 30. */
  readonly repeats?: number;
  readonly warmups?: number;
  /** Injected clock; the report timestamp and every request share it. */
  readonly now: string;
}

export class Crk2ComparisonError extends Error {
  readonly code: 'engine_version_mismatch' | 'engine_identity_collision' | 'no_cases';

  constructor(code: Crk2ComparisonError['code'], message: string) {
    super(message);
    this.name = 'Crk2ComparisonError';
    this.code = code;
  }
}

function buildRequest(
  testCase: Crk2Case,
  options: Crk2ComparisonOptions,
  iteration: number
): Crk2EngineRequest {
  return {
    caseId: testCase.id,
    root: testCase.workspace === 'crk2-fault' ? options.faultRoot : options.retrievalRoot,
    workspace: testCase.workspace,
    query: testCase.query,
    profile: testCase.profile,
    changedPaths: testCase.changedPaths,
    focusPaths: testCase.focusPaths,
    tokenBudget: testCase.tokenBudget,
    risk: testCase.risk,
    k: testCase.k,
    iteration,
    now: options.now
  };
}

interface EngineRun {
  readonly rows: readonly Crk2CaseMetrics[];
  readonly samplesByCaseId: ReadonlyMap<string, readonly number[]>;
}

/**
 * Runs one engine over the corpus.
 *
 * Warmups are executed and discarded so a cold JIT cannot be reported as tail
 * latency, and every measured repeat is compared against the first answer's
 * signature — a run that is fast because it answered differently each time is a
 * determinism failure, not a speed win.
 */
async function runEngine(
  engine: Crk2Engine,
  cases: readonly Crk2Case[],
  options: Crk2ComparisonOptions,
  repeats: number,
  warmups: number
): Promise<EngineRun> {
  const rows: Crk2CaseMetrics[] = [];
  const samplesByCaseId = new Map<string, readonly number[]>();

  for (const testCase of cases) {
    for (let iteration = 0; iteration < warmups; iteration += 1) {
      await engine.run(buildRequest(testCase, options, -1 - iteration));
    }

    const samples: number[] = [];
    let first: Crk2EngineResult | null = null;
    let firstSignature = '';
    let mismatches = 0;

    for (let iteration = 0; iteration < repeats; iteration += 1) {
      const started = performance.now();
      const result = await engine.run(buildRequest(testCase, options, iteration));
      const measured = performance.now() - started;
      samples.push(Number.isFinite(result.latencyMs) && result.latencyMs >= 0 ? result.latencyMs : measured);
      const signature = crk2ResultSignature(result);
      if (!first) {
        first = result;
        firstSignature = signature;
      } else if (signature !== firstSignature) {
        mismatches += 1;
      }
    }

    if (!first) continue;
    samplesByCaseId.set(testCase.id, samples);
    rows.push(
      evaluateCrk2Case(testCase, engine, {
        result: first,
        latencySamples: samples,
        determinismMismatches: mismatches
      })
    );
  }

  return { rows, samplesByCaseId };
}

/**
 * v2 is only "better" on a case when its must-include recall did not fall.
 *
 * A faster answer with equal-or-worse recall that is still short of the gold set
 * is the baseline's `korean`/`jargon` reading in miniature, so it gets its own
 * verdict rather than disappearing into an averaged latency win.
 */
function verdictFor(v1: Crk2CaseMetrics, v2: Crk2CaseMetrics): Crk2CaseVerdict {
  if (v2.rejectionCorrect === false || v1.rejectionCorrect === false) return 'rejection_mismatch';
  const recallDelta = v2.mustIncludeRecall - v1.mustIncludeRecall;
  if (recallDelta < 0) return 'recall_regression';
  if (recallDelta > 0) return 'improved';
  if (v2.mustIncludeRecall < 1 && v2.latency.p95 < v1.latency.p95) return 'fast_but_empty';
  return 'unchanged';
}

function pairRows(
  cases: readonly Crk2Case[],
  v1Rows: readonly Crk2CaseMetrics[],
  v2Rows: readonly Crk2CaseMetrics[]
): readonly Crk2CaseComparison[] {
  const v1ById = new Map(v1Rows.map((row) => [row.caseId, row]));
  const v2ById = new Map(v2Rows.map((row) => [row.caseId, row]));
  const pairs: Crk2CaseComparison[] = [];
  for (const testCase of cases) {
    const left = v1ById.get(testCase.id);
    const right = v2ById.get(testCase.id);
    if (!left || !right) continue;
    pairs.push({
      caseId: testCase.id,
      category: testCase.category,
      v1: left,
      v2: right,
      mustIncludeRecallDelta: right.mustIncludeRecall - left.mustIncludeRecall,
      recallAtKDelta: right.recallAtK - left.recallAtK,
      latencyP95Delta: right.latency.p95 - left.latency.p95,
      latencyP99Delta: right.latency.p99 - left.latency.p99,
      verdict: verdictFor(left, right)
    });
  }
  return pairs;
}

function notesFor(pairs: readonly Crk2CaseComparison[], floors: Crk2FloorReport): readonly string[] {
  const notes: string[] = [];
  const fastButEmpty = pairs.filter((pair) => pair.verdict === 'fast_but_empty').length;
  if (fastButEmpty > 0) notes.push(`fast_but_empty_cases:${fastButEmpty}`);
  if (!floors.ok) notes.push('comparison_not_conclusive:hard_floor_failed');
  const unresolved = pairs.filter((pair) => pair.v2.mustIncludeRecall < 1).map((pair) => pair.category);
  for (const category of [...new Set(unresolved)].sort()) notes.push(`recall_below_one:${category}`);
  return notes;
}

/**
 * Compare a v1 engine against a v2 engine over the CRK2 corpus.
 *
 * Both engines are parameters. Neither is discovered, defaulted, or selected by
 * a flag — the caller holds the only references, and the harness that holds them
 * is deleted together with v1 at cutover (ADR §10).
 */
export async function compareRetrievalEngines(
  v1: Crk2Engine,
  v2: Crk2Engine,
  options: Crk2ComparisonOptions
): Promise<Crk2ComparisonReport> {
  if (v1.version !== 'v1' || v2.version !== 'v2') {
    throw new Crk2ComparisonError(
      'engine_version_mismatch',
      'the comparison seam takes exactly one v1 engine and one v2 engine, in that order'
    );
  }
  if (v1.id === v2.id) {
    throw new Crk2ComparisonError('engine_identity_collision', 'the two engines must be distinguishable by id');
  }
  const cases = options.cases ?? CRK2_CASES;
  if (!cases.length) throw new Crk2ComparisonError('no_cases', 'the comparison needs at least one case');

  const repeats = Math.max(1, Math.trunc(options.repeats ?? CRK2_DEFAULT_REPEATS));
  const warmups = Math.max(0, Math.trunc(options.warmups ?? CRK2_DEFAULT_WARMUPS));

  const left = await runEngine(v1, cases, options, repeats, warmups);
  const right = await runEngine(v2, cases, options, repeats, warmups);

  const v1Summary = summarizeCrk2Engine(v1, left.rows, left.samplesByCaseId);
  const v2Summary = summarizeCrk2Engine(v2, right.rows, right.samplesByCaseId);
  const floors = evaluateCrk2Floors(v2Summary, right.rows);
  const pairs = pairRows(cases, left.rows, right.rows);
  const regressions = pairs
    .filter((pair) => pair.verdict === 'recall_regression' || pair.verdict === 'fast_but_empty' || pair.verdict === 'rejection_mismatch')
    .map((pair) => `${pair.caseId}:${pair.verdict}`)
    .sort();

  return {
    schema: CRK2_BENCHMARK_COMPARISON_SCHEMA,
    ok: floors.ok && regressions.length === 0,
    generatedAt: options.now,
    corpusRevision: CRK2_CORPUS_REVISION,
    caseCount: cases.length,
    repeats,
    warmups,
    v1: v1Summary,
    v2: v2Summary,
    cases: pairs,
    floors,
    regressions,
    notes: notesFor(pairs, floors)
  };
}
