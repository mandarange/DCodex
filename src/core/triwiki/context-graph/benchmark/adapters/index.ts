/**
 * The two benchmark adapters.
 *
 * The harness takes retrieval implementations as injected adapters so the
 * scoring code never imports an engine. This directory is where the engines are
 * bound: `candidate-graph` answers through the Context Graph, and
 * `baseline-lexical` reproduces the pre-graph path search + text search purely
 * as a control.
 *
 * `baseline-lexical` is a MEASUREMENT INSTRUMENT ONLY. No production module may
 * import anything from `benchmark/adapters/`, and it must never be re-attached
 * to `src/core/search/context.ts`: when the graph is missing or stale the
 * product surfaces `context_graph_missing` / `context_graph_stale` plus
 * `sks align run`, and never a silent text answer.
 */
export {
  BASELINE_LEXICAL_ADAPTER_ID,
  createBaselineLexicalAdapter,
  runBaselineLexical,
  toBaselineRun,
  type BaselineLexicalAdapterOptions,
  type BaselineLexicalOutcome
} from './baseline-lexical.js';

export {
  CANDIDATE_GRAPH_ADAPTER_ID,
  CandidateGraphAdapter,
  createCandidateGraphAdapter,
  toCandidateRun,
  type CandidateGraphAdapterOptions,
  type CandidateGraphOutcome
} from './candidate-graph.js';

export {
  DEFAULT_LEXICAL_SEARCH_LIMITS,
  LEXICAL_MATCH_CONFIDENCE,
  LEXICAL_PACK_CANDIDATES,
  lexicalPackPresent,
  runLexicalContextSearch,
  type LexicalMatch,
  type LexicalMatchChannel,
  type LexicalSearchAnswer,
  type LexicalSearchInput,
  type LexicalSearchLimits
} from './lexical-search.js';

export {
  LEXICAL_STOP_WORDS,
  MAX_LEXICAL_TERMS,
  MIN_LEXICAL_TERM_LENGTH,
  lexicalAlternationPattern,
  lexicalQueryTerms,
  lexicalTermHits
} from './lexical-terms.js';

export {
  PROJECTION_EDGE_SCAN_CAP,
  WRITE_SCOPE_EDGE_TYPE,
  projectContextGraphAnswer,
  type ContextGraphAnswerProjection
} from './graph-projection.js';

export {
  ContextGraphSessionCache,
  measureSnapshotSafety,
  type ContextGraphSession,
  type ContextGraphSessionOptions,
  type ContextGraphSessionResult,
  type ContextGraphSnapshotSafety
} from './graph-session.js';

import { createBaselineLexicalAdapter, type BaselineLexicalAdapterOptions } from './baseline-lexical.js';
import { createCandidateGraphAdapter, type CandidateGraphAdapterOptions } from './candidate-graph.js';
import type { ContextGraphBenchmarkAdapter } from '../types.js';

export interface ContextGraphBenchmarkAdapterSetOptions {
  readonly baseline?: BaselineLexicalAdapterOptions;
  readonly candidate?: CandidateGraphAdapterOptions;
}

/**
 * Baseline first, candidate second. The runner needs exactly one of each kind
 * before it will compute a composite score, and this is the pair it expects.
 */
export function contextGraphBenchmarkAdapters(
  options: ContextGraphBenchmarkAdapterSetOptions = {}
): ContextGraphBenchmarkAdapter[] {
  return [
    createBaselineLexicalAdapter(options.baseline ?? {}),
    createCandidateGraphAdapter(options.candidate ?? {})
  ];
}
