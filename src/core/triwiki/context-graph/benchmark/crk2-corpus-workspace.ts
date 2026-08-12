/**
 * The workspace inventory the CRK2 corpus is authored against, and the small
 * builders every case group shares.
 *
 * This file is the reason a gold set cannot be quietly retuned. Every literal
 * node id a case names has to appear in the inventory below, and
 * `validateCrk2Corpus` rejects one that does not — so a case can only ever be
 * written from what the workspace actually contains, never from what an engine
 * happened to return.
 *
 * The inventory doubles as the fixture contract: whoever materializes
 * `crk2-retrieval` and `crk2-fault` builds exactly these files, gates and
 * structural nodes, and the two cannot drift apart without the validator saying
 * so.
 */
import type {
  Crk2Case,
  Crk2GoldMatcher,
  Crk2QueryCategory,
  Crk2RetrievalGold
} from './crk2-types.js';
import type { ContextGraphSeedConfidence } from '../query-types.js';

export const CRK2_CORPUS_REVISION = '1' as const;
export const CRK2_DEFAULT_K = 10;

/**
 * Every file the `crk2-retrieval` workspace contains.
 *
 * This doubles as the fixture contract handed to whoever materializes the
 * workspace: a gold id outside this list is rejected, so the corpus and the
 * fixture cannot drift apart silently.
 */
export const CRK2_RETRIEVAL_FILES: readonly string[] = [
  '.sneakoscope/naruto/slice-plan.json',
  '.sneakoscope/wiki/claims/context-budget-ko.md',
  '.sneakoscope/wiki/claims/context-budget-legacy.md',
  '.sneakoscope/wiki/proof-index.json',
  'config/context-graph.json',
  'docs/architecture/context-retrieval-kernel-v2.md',
  'release-gates.v2.json',
  'src/cli/__tests__/search-context.test.ts',
  'src/cli/command-registry.json',
  'src/cli/commands/search-context.ts',
  'src/cli/routes/search-context-route.ts',
  'src/core/legacy/json-runtime-store.ts',
  'src/core/naruto/fanout-planner.ts',
  'src/core/naruto/slice-writer-a.ts',
  'src/core/naruto/slice-writer-b.ts',
  'src/core/naruto/slice-writer-c.ts',
  'src/core/pipeline/context-retrieval-pipeline.ts',
  'src/core/security/redaction-guard.ts',
  'src/core/shared/registry.ts',
  'src/core/triwiki/align-runner.ts',
  'src/core/triwiki/context-graph/__tests__/format.test.ts',
  'src/core/triwiki/context-graph/__tests__/generation-store.test.ts',
  'src/core/triwiki/context-graph/__tests__/kernel.test.ts',
  'src/core/triwiki/context-graph/__tests__/lexicon.test.ts',
  'src/core/triwiki/context-graph/__tests__/reader.test.ts',
  'src/core/triwiki/context-graph/compiler/fragment-manifest.ts',
  'src/core/triwiki/context-graph/compiler/generation.ts',
  'src/core/triwiki/context-graph/ids.ts',
  'src/core/triwiki/context-graph/index.ts',
  'src/core/triwiki/context-graph/paths.ts',
  'src/core/triwiki/context-graph/query/cache.ts',
  'src/core/triwiki/context-graph/query/index.ts',
  'src/core/triwiki/context-graph/query/kernel.ts',
  'src/core/triwiki/context-graph/runtime-index/bm25f-scorer.ts',
  'src/core/triwiki/context-graph/runtime-index/csr-builder.ts',
  'src/core/triwiki/context-graph/runtime-index/format.ts',
  'src/core/triwiki/context-graph/runtime-index/index.ts',
  'src/core/triwiki/context-graph/runtime-index/lexicon.ts',
  'src/core/triwiki/context-graph/runtime-index/reader.ts',
  'src/core/triwiki/context-graph/store/generation-store.ts',
  'src/core/triwiki/context-graph/store/operation-journal.ts',
  'tools/context_graph_smoke.py'
];

/** Gate ids the workspace declares. `CRK2_PROTECTED_GATE_IDS` is a subset. */
export const CRK2_GATE_IDS: readonly string[] = [
  'context-graph-contract',
  'context-graph-legacy-closure',
  'context-graph-performance',
  'context-graph-quality',
  'release-proof-integrity',
  'secret-redaction',
  'write-scope-isolation'
];

/** Losing one of these to a token budget is a floor breach, not a ranking preference. */
export const CRK2_PROTECTED_GATE_IDS: readonly string[] = [
  'release-proof-integrity',
  'secret-redaction',
  'write-scope-isolation'
];

/** Non-file, non-gate nodes: commands, routes, pipelines, config keys, proofs, risk domains. */
export const CRK2_STRUCTURAL_NODE_IDS: readonly string[] = [
  'command:search-context',
  'config:config/context-graph.json#max_frontier_budget',
  'config:config/context-graph.json#posting_cap_per_term',
  'module:context-graph-runtime-index',
  'pipeline:context-retrieval',
  'proof:context-retrieval-baseline',
  'risk:context-retrieval',
  'route:search-context',
  'schema:sks.context-graph-index-meta.v1'
];

export function file(relativePath: string): string {
  return `file:${relativePath}`;
}

export function gate(gateId: string): string {
  return `gate:${gateId}`;
}

export function symbolAt(path: string, name: string): Crk2GoldMatcher {
  return { kind: 'symbol', path, name };
}

/** Keeps a computed-key confidence map from widening its values to `string`. */
export function confidence(nodeId: string, value: ContextGraphSeedConfidence): Readonly<Record<string, ContextGraphSeedConfidence>> {
  return { [nodeId]: value };
}

/** All literal node ids the retrieval workspace can produce. */
export function crk2RetrievalNodeUniverse(): ReadonlySet<string> {
  return new Set<string>([
    ...CRK2_RETRIEVAL_FILES.map(file),
    ...CRK2_GATE_IDS.map(gate),
    ...CRK2_STRUCTURAL_NODE_IDS
  ]);
}

/**
 * Shorthands for the paths the case groups name most often.
 *
 * These are a shared vocabulary across the group modules, so a path typo becomes
 * an unresolved identifier at compile time instead of a gold id the validator
 * has to catch at runtime. Every one of them appears in `CRK2_RETRIEVAL_FILES`.
 */
export const KERNEL = 'src/core/triwiki/context-graph/query/kernel.ts';
export const FORMAT = 'src/core/triwiki/context-graph/runtime-index/format.ts';
export const LEXICON = 'src/core/triwiki/context-graph/runtime-index/lexicon.ts';
export const READER = 'src/core/triwiki/context-graph/runtime-index/reader.ts';
export const SCORER = 'src/core/triwiki/context-graph/runtime-index/bm25f-scorer.ts';
export const CSR = 'src/core/triwiki/context-graph/runtime-index/csr-builder.ts';
export const CACHE = 'src/core/triwiki/context-graph/query/cache.ts';
export const GENERATION = 'src/core/triwiki/context-graph/compiler/generation.ts';
export const MANIFEST = 'src/core/triwiki/context-graph/compiler/fragment-manifest.ts';
export const STORE = 'src/core/triwiki/context-graph/store/generation-store.ts';
export const JOURNAL = 'src/core/triwiki/context-graph/store/operation-journal.ts';
export const LEGACY_JSON = 'src/core/legacy/json-runtime-store.ts';
export const KO_CLAIM = '.sneakoscope/wiki/claims/context-budget-ko.md';
export const LEGACY_CLAIM = '.sneakoscope/wiki/claims/context-budget-legacy.md';
export const SMOKE_PY = 'tools/context_graph_smoke.py';

export const EMPTY_GOLD: Crk2RetrievalGold = {
  mustIncludeNodeIds: [],
  mustIncludeMatchers: [],
  relevantNodeIds: [],
  forbiddenNodeIds: [],
  protectedGateIds: [],
  gateIds: [],
  conflicts: []
};

/**
 * A rejection case. The engine must fail closed with exactly `errorCode` and
 * return nothing; ADR §5 makes corrupt input an error with a named repair, never
 * a partial read.
 */
export function faultCase(
  id: string,
  title: string,
  query: string,
  errorCode: string,
  rationale: string,
  category: Crk2QueryCategory = 'corrupt_input'
): Crk2Case {
  return {
    id,
    title,
    query,
    category,
    workspace: 'crk2-fault',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: { ...EMPTY_GOLD, expectedErrorCode: errorCode },
    rationale
  };
}
