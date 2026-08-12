/**
 * Graph shape and freshness: the cases only a graph can answer.
 *
 * Fan-in, fan-out and cycles are where a frontier budget silently truncates, and
 * they come in matched pairs so a traversal bounded in only one direction shows
 * up. The focus-path case checks that a focus path is a hard filter rather than
 * an advisory preference.
 *
 * The freshness cases turn stale evidence into a measurable failure: a
 * superseded claim or an invalidated proof returned as support is how a wrong
 * answer acquires a citation. Note that `conflict-invalidated-proof` and
 * `freshness-invalidated-proof-excluded` use the same fixture with opposite
 * demands — asked about, the proof is required; cited as support, it is
 * forbidden.
 */
import type { Crk2Case } from './crk2-types.js';
import {
  CACHE,
  CRK2_DEFAULT_K,
  CSR,
  EMPTY_GOLD,
  GENERATION,
  KERNEL,
  LEGACY_CLAIM,
  LEXICON,
  READER,
  SCORER,
  confidence,
  file
} from './crk2-corpus-workspace.js';

const GRAPH_SHAPE_CASES: readonly Crk2Case[] = [
  {
    id: 'graph-high-fan-in-ids',
    title: 'a module almost everything imports',
    query: 'what imports the id builder',
    category: 'graph_shape',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: ['src/core/triwiki/context-graph/ids.ts'],
    focusPaths: [],
    tokenBudget: 12000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('src/core/triwiki/context-graph/ids.ts'), file(GENERATION), file(KERNEL)],
      mustIncludeMatchers: [{ kind: 'path_prefix', prefix: 'src/core/triwiki/context-graph/runtime-index/' }]
    },
    rationale: 'High fan-in is where a frontier budget silently truncates; the matcher requires at least one runtime-index dependant.'
  },
  {
    id: 'graph-high-fan-out-registry',
    title: 'a module that pulls in most of the tree',
    query: 'what does the shared registry reach',
    category: 'graph_shape',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: ['src/core/shared/registry.ts'],
    focusPaths: [],
    tokenBudget: 12000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('src/core/shared/registry.ts'), file('src/core/naruto/fanout-planner.ts')],
      relevantNodeIds: [file('src/core/naruto/slice-writer-a.ts'), file('src/core/naruto/slice-writer-b.ts')]
    },
    rationale: 'The fan-out twin of the case above; the two together catch a traversal that is bounded in only one direction.'
  },
  {
    id: 'graph-dependency-cycle',
    title: 'a dependency cycle between three modules',
    query: 'is there an import cycle around the query index',
    category: 'graph_shape',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 10000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [
        file('src/core/triwiki/context-graph/query/index.ts'),
        file(KERNEL),
        file(CACHE)
      ]
    },
    rationale: 'A cycle must terminate traversal without dropping a member; returning two of three is the usual failure.'
  },
  {
    id: 'focus-path-restricted-answer',
    title: 'focus path narrows the answer',
    query: 'where is the posting cap applied',
    category: 'focus_path',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: ['src/core/triwiki/context-graph/runtime-index/'],
    tokenBudget: 8000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(LEXICON)],
      relevantNodeIds: [file(SCORER)],
      forbiddenNodeIds: [file(KERNEL), file(CACHE)],
      requiredConfidence: confidence(file(LEXICON), 'file_path')
    },
    rationale: 'A focus path is an exact anchor and a hard filter; a node outside it in the answer means the filter is advisory.'
  }
];

const FRESHNESS_CASES: readonly Crk2Case[] = [
  {
    id: 'freshness-stale-wiki-claim',
    title: 'a claim that disagrees with the source it cites',
    query: 'what is the maximum frontier budget',
    category: 'freshness',
    workspace: 'crk2-retrieval',
    profile: 'answer',
    changedPaths: ['config/context-graph.json'],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'high',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: ['config:config/context-graph.json#max_frontier_budget'],
      forbiddenNodeIds: [file(LEGACY_CLAIM)]
    },
    rationale: 'The stale claim states an older number; returning it as evidence is how a wrong answer acquires a citation.'
  },
  {
    id: 'freshness-invalidated-proof-excluded',
    title: 'an invalidated proof must not be cited as support',
    query: 'cite the proof that the kernel meets its latency floor',
    category: 'freshness',
    workspace: 'crk2-retrieval',
    profile: 'answer',
    changedPaths: [KERNEL],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'high',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('.sneakoscope/wiki/proof-index.json')],
      forbiddenNodeIds: ['proof:context-retrieval-baseline'],
      gateIds: ['release-proof-integrity'],
      protectedGateIds: ['release-proof-integrity']
    },
    rationale: 'Same fixture as conflict-invalidated-proof, opposite demand: cited as support it is forbidden, asked about it is required.'
  },
  {
    id: 'freshness-dirty-tracked-file',
    title: 'a tracked file with uncommitted edits',
    query: 'what changed in the reader',
    category: 'freshness',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [READER],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(READER)],
      relevantNodeIds: [file('src/core/triwiki/context-graph/__tests__/reader.test.ts')]
    },
    rationale: 'ADR §7 redefines hydrated as fresh-index rather than per-node stat; a dirty file must still be answerable.'
  },
  {
    id: 'freshness-relevant-untracked-file',
    title: 'an untracked file that is nonetheless the answer',
    query: 'where is the csr builder',
    category: 'freshness',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: 5,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(CSR)]
    },
    rationale: 'Untracked does not mean irrelevant; a git-filtered index would drop this file and quietly lose recall.'
  }
];

/** Graph-shape, focus-path and freshness cases, in their authored order. */
export const CRK2_GRAPH_CASES: readonly Crk2Case[] = [
  ...GRAPH_SHAPE_CASES,
  ...FRESHNESS_CASES
];
