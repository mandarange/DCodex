/**
 * `baseline-lexical` — the pre-graph context behaviour, as a benchmark control.
 *
 * MEASUREMENT INSTRUMENT ONLY — NOT A PRODUCTION FALLBACK.
 * This adapter reproduces how context was retrieved before the Context Graph
 * existed (path search + text search, merged, everything labelled
 * `context_pack`) so the quality and performance gates have a real thing to
 * compare against. It lives only under `benchmark/adapters/`, it is imported by
 * no production module, and it must never be re-attached to
 * `src/core/search/context.ts` or to any other answer path. When the graph is
 * missing or stale the product surfaces `context_graph_missing` /
 * `context_graph_stale` plus `sks wiki refresh --code`; it does not run this.
 *
 * Everything the instrument cannot observe is reported as unobserved rather
 * than guessed. In particular it reports no provenance, no gate topology, no
 * write-scope conflicts, no freshness verdict and no exact-reference
 * preservation, because a lexical engine genuinely has none of those — that
 * gap is the measurement, not a defect in the adapter.
 */
import { contextGraphNodeId } from '../../ids.js';
import { isTestPath } from '../../extractors/code/inventory.js';
import { emptyBenchmarkSafety } from '../types.js';
import type {
  ContextGraphBenchmarkAdapter,
  ContextGraphBenchmarkQuery,
  ContextGraphBenchmarkRun
} from '../types.js';
import {
  runLexicalContextSearch,
  type LexicalSearchAnswer,
  type LexicalSearchLimits
} from './lexical-search.js';

export const BASELINE_LEXICAL_ADAPTER_ID = 'baseline-lexical';

export interface BaselineLexicalAdapterOptions {
  /** Override only when two lexical variants must appear in one report. */
  readonly id?: string;
  readonly limits?: Partial<LexicalSearchLimits>;
}

/**
 * The instrument's own answer, kept alongside the benchmark run so a test can
 * assert on the retrieval behaviour (channels, hydration) without re-deriving
 * it from the flattened run record.
 */
export interface BaselineLexicalOutcome {
  readonly run: ContextGraphBenchmarkRun;
  readonly answer: LexicalSearchAnswer;
}

function rankedPaths(answer: LexicalSearchAnswer): string[] {
  return answer.matches.map((match) => match.path);
}

/**
 * Tests are recognised by filename convention, which is all a lexical engine
 * has. This is deliberately generous to the baseline: it is a real capability
 * of the pre-graph path, so withholding it would understate the control.
 */
function testPathsIn(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const candidate of paths) {
    if (isTestPath(candidate) && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * Build the benchmark record for one lexical answer.
 *
 * Fields left empty are empty by observation:
 *  - `selectedGateIds` / `writeScopeConflicts`: the release DAG and the slice
 *    write scopes are relations, and a text scan observes no relations;
 *  - `provenanceCoverage`: a `context_pack` hit cites no path+hash provenance
 *    record, so coverage is 0 rather than "unknown";
 *  - `staleIncluded` / `invalidatedIncluded`: the instrument has no freshness
 *    signal, so it cannot report that it returned a retired file — which is
 *    exactly why the corpus checks retired files through `mustExcludePaths`;
 *  - `exactSeedsPreserved`: nothing here is ever labelled an exact reference,
 *    so no exact seed survives as exact.
 */
export function toBaselineRun(
  query: ContextGraphBenchmarkQuery,
  adapterId: string,
  answer: LexicalSearchAnswer,
  latencyMs: number
): ContextGraphBenchmarkRun {
  const paths = rankedPaths(answer);
  return {
    caseId: query.caseId,
    adapterId,
    mode: query.mode,
    iteration: query.iteration,
    ok: answer.ok,
    errorCode: answer.ok ? null : 'adapter_error:search_provider_failed',
    matchedPaths: paths,
    matchedNodeIds: paths.map((item) => contextGraphNodeId({ kind: 'file', path: item })),
    selectedGateIds: [],
    selectedTestPaths: testPathsIn(paths),
    writeScopeConflicts: [],
    tokenCost: answer.tokenCost,
    latencyMs,
    cacheHit: answer.cacheHit,
    provenanceCoverage: 0,
    staleIncluded: [],
    invalidatedIncluded: [],
    exactSeedsPreserved: [],
    safety: emptyBenchmarkSafety({
      // No graph is compiled, so there is no snapshot to hash and no recompile
      // to compare it against. The determinism floor falls back to comparing
      // the answers themselves, which is the right check for this instrument.
      snapshotHash: null,
      determinismHash: null,
      // `silentTextFallback` asks whether a *missing or stale graph* was
      // quietly answered from text. This adapter consults no graph at all and
      // declares its method up front, so there is no graph state for it to
      // swallow. The behaviour the floor guards against is the query engine
      // degrading into text search; that path does not exist.
      silentTextFallback: false,
      unsupportedLanguageExactClaims: [],
      projectCodeExecutions: 0,
      processSpawns: answer.processSpawns,
      scannedFiles: answer.scannedFiles,
      scanBudget: answer.scanBudget
    })
  };
}

/**
 * Run the instrument once and return both the benchmark record and the raw
 * answer. `changedPaths` and `focusPaths` are handed to the lexical search for
 * the same reason the candidate gets them: the harness gives both adapters the
 * same caller input, and a control that ignores half of it is not a control.
 */
export async function runBaselineLexical(
  query: ContextGraphBenchmarkQuery,
  options: BaselineLexicalAdapterOptions = {}
): Promise<BaselineLexicalOutcome> {
  const adapterId = options.id ?? BASELINE_LEXICAL_ADAPTER_ID;
  const startedAt = Date.now();
  const answer = await runLexicalContextSearch(
    query.root,
    query.query,
    { seedPaths: query.changedPaths, focusPaths: query.focusPaths },
    options.limits
  );
  return { run: toBaselineRun(query, adapterId, answer, Date.now() - startedAt), answer };
}

export function createBaselineLexicalAdapter(
  options: BaselineLexicalAdapterOptions = {}
): ContextGraphBenchmarkAdapter {
  const id = options.id ?? BASELINE_LEXICAL_ADAPTER_ID;
  return {
    id,
    kind: 'baseline',
    async run(query: ContextGraphBenchmarkQuery): Promise<ContextGraphBenchmarkRun> {
      const outcome = await runBaselineLexical(query, options);
      return outcome.run;
    }
  };
}
