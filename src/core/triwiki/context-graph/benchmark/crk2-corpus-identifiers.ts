/**
 * Identifier-shaped queries: the anchor lane's territory.
 *
 * Everything here is a string a developer could have copied out of the codebase
 * — a symbol, a stable node id, a path, a basename, an acronym, or half of a
 * camelCase/snake_case pair. ADR §4 maps these to `exact` confidence, so the
 * cases carrying a `requiredConfidence` are asserting that an anchor did not
 * silently decay into a text candidate.
 *
 * The v1 baseline's two slowest cases were `basename` (p50 17.16 ms) and
 * `acronym` (p50 15.01 ms), both of which fell through to a full key scan.
 * Their recall must stay at 1.0 as they get fast; speed bought by matching less
 * is not the improvement this corpus is measuring.
 */
import type { Crk2Case } from './crk2-types.js';
import {
  CACHE,
  CRK2_DEFAULT_K,
  CSR,
  EMPTY_GOLD,
  FORMAT,
  GENERATION,
  KERNEL,
  LEGACY_JSON,
  LEXICON,
  MANIFEST,
  READER,
  SCORER,
  SMOKE_PY,
  STORE,
  confidence,
  file,
  symbolAt
} from './crk2-corpus-workspace.js';

const EXACT_CASES: readonly Crk2Case[] = [
  {
    id: 'exact-symbol-compile-context-index',
    title: 'exact symbol defined in the compiler',
    query: 'compileContextIndex',
    category: 'exact_symbol',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(GENERATION)],
      mustIncludeMatchers: [symbolAt(GENERATION, 'compileContextIndex')],
      relevantNodeIds: [file(STORE), file(MANIFEST)],
      forbiddenNodeIds: [file(LEGACY_JSON)],
      requiredConfidence: confidence(file(GENERATION), 'exact_definition')
    },
    rationale: 'An exact symbol hit is the anchor lane; ADR §4 maps it to exact and nothing weaker.'
  },
  {
    id: 'exact-symbol-read-section-descriptor',
    title: 'exact symbol defined in the binary format module',
    query: 'readSectionDescriptor',
    category: 'exact_symbol',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(FORMAT)],
      mustIncludeMatchers: [symbolAt(FORMAT, 'readSectionDescriptor')],
      relevantNodeIds: [file(READER), file('src/core/triwiki/context-graph/__tests__/format.test.ts')],
      forbiddenNodeIds: [file(LEGACY_JSON)]
    },
    rationale: 'Proves the anchor lane reaches a symbol whose file is never the top BM25F hit for its own name.'
  },
  {
    id: 'exact-node-id-format-file',
    title: 'a caller pastes a stable node id',
    query: `file:${FORMAT}`,
    category: 'exact_node_id',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 4000,
    risk: 'normal',
    k: 5,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(FORMAT)],
      forbiddenNodeIds: [file(LEGACY_JSON)],
      requiredConfidence: confidence(file(FORMAT), 'exact_definition')
    },
    rationale: 'A stable node id must resolve without a text lane; it is the cheapest exact seed there is.'
  },
  {
    id: 'exact-path-kernel',
    title: 'exact workspace-relative path',
    query: KERNEL,
    category: 'exact_path',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 4000,
    risk: 'normal',
    k: 5,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(KERNEL)],
      relevantNodeIds: [file('src/core/triwiki/context-graph/__tests__/kernel.test.ts')],
      requiredConfidence: confidence(file(KERNEL), 'file_path')
    },
    rationale: 'Exact path is an anchor; ADR §4 gives it exact confidence, and it must not degrade to a text candidate.'
  },
  {
    id: 'exact-path-config-key',
    title: 'exact config key inside a JSON file',
    query: 'config/context-graph.json max_frontier_budget',
    category: 'exact_path',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 4000,
    risk: 'normal',
    k: 5,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: ['config:config/context-graph.json#max_frontier_budget', file('config/context-graph.json')],
      relevantNodeIds: ['config:config/context-graph.json#posting_cap_per_term']
    },
    rationale: 'Config nodes are addressable by key; losing them collapses budget questions into whole-file answers.'
  }
];

const NAMING_CASES: readonly Crk2Case[] = [
  {
    id: 'basename-reader-ts',
    title: 'basename with a single owner',
    query: 'reader.ts',
    category: 'basename',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 4000,
    risk: 'normal',
    k: 5,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(READER)],
      relevantNodeIds: [file('src/core/triwiki/context-graph/__tests__/reader.test.ts')]
    },
    rationale: 'Basename was one of the two slowest v1 cases because it fell through to a full key scan; recall must stay 1.0 as it gets fast.'
  },
  {
    id: 'basename-index-ts-collision',
    title: 'basename shared by several modules',
    query: 'index.ts',
    category: 'basename',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [
        file('src/core/triwiki/context-graph/index.ts'),
        file('src/core/triwiki/context-graph/query/index.ts'),
        file('src/core/triwiki/context-graph/runtime-index/index.ts')
      ]
    },
    rationale: 'A colliding basename must return every owner; returning the first one is a precision win that hides a recall failure.'
  },
  {
    id: 'acronym-crk2',
    title: 'project acronym for the kernel itself',
    query: 'CRK2',
    category: 'acronym',
    workspace: 'crk2-retrieval',
    profile: 'answer',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('docs/architecture/context-retrieval-kernel-v2.md')],
      relevantNodeIds: [file(KERNEL), file(FORMAT)],
      confidenceCeiling: 'text_candidate'
    },
    rationale: 'Acronyms were the other slow v1 case; the answer is a text candidate however strong the score, per ADR §4.'
  },
  {
    id: 'acronym-bm25f',
    title: 'acronym naming a ranking function',
    query: 'BM25F',
    category: 'acronym',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(SCORER)],
      relevantNodeIds: [file(LEXICON)],
      confidenceCeiling: 'text_candidate'
    },
    rationale: 'An acronym embedded in a filename must be reachable without a substring scan over every key.'
  },
  {
    id: 'acronym-csr',
    title: 'acronym naming a data structure',
    query: 'CSR adjacency',
    category: 'acronym',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(CSR)],
      relevantNodeIds: [file(FORMAT)],
      confidenceCeiling: 'text_candidate'
    },
    rationale: 'Three-letter acronyms are where a naive tokenizer drops the term entirely as a stopword-length token.'
  },
  {
    id: 'camel-fragment-frontier-budget',
    title: 'camelCase fragment of a plan field',
    query: 'frontierBudget',
    category: 'camel_case_fragment',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(KERNEL), 'config:config/context-graph.json#max_frontier_budget'],
      relevantNodeIds: [file(CACHE)]
    },
    rationale: 'A camelCase identifier and its snake_case config key name the same budget; the tokenizer must join them.'
  },
  {
    id: 'camel-fragment-hydrate-node',
    title: 'camelCase fragment of a reader method',
    query: 'hydrateNode',
    category: 'camel_case_fragment',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(READER)],
      mustIncludeMatchers: [symbolAt(READER, 'hydrateNode')],
      relevantNodeIds: [file(KERNEL)]
    },
    rationale: 'ADR §3 removes getNode entirely; hydrateNode is the only materialization point, so it must always be findable.'
  },
  {
    id: 'snake-fragment-max-frontier-budget',
    title: 'snake_case config key',
    query: 'max_frontier_budget',
    category: 'snake_case_fragment',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 4000,
    risk: 'normal',
    k: 5,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: ['config:config/context-graph.json#max_frontier_budget'],
      relevantNodeIds: [file('config/context-graph.json'), file(KERNEL)]
    },
    rationale: 'The snake_case half of the same identifier pair; asymmetric recall between the two is a tokenizer bug.'
  },
  {
    id: 'snake-fragment-context-graph-smoke',
    title: 'snake_case module name in a tooling script',
    query: 'context_graph_smoke',
    category: 'snake_case_fragment',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 4000,
    risk: 'normal',
    k: 5,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(SMOKE_PY)],
      confidenceCeiling: 'file_path'
    },
    rationale: 'The file is in an unsupported language, so its path may anchor but its contents may never claim an exact symbol relation.'
  }
];

/** Exact-anchor and naming-variant cases, in their authored order. */
export const CRK2_IDENTIFIER_CASES: readonly Crk2Case[] = [
  ...EXACT_CASES,
  ...NAMING_CASES
];
