/**
 * Planning and review questions asked in prose.
 *
 * These are the queries with no anchor in them at all, so they are the ones a
 * lexical engine answers plausibly and wrongly: it returns whoever mentions the
 * word rather than whoever the graph says is involved. Each must-include set is
 * the smallest set that would actually let the work start, and each
 * `forbiddenNodeIds` entry names the file a bag-of-words match would wrongly
 * add.
 */
import type { Crk2Case } from './crk2-types.js';
import {
  CRK2_DEFAULT_K,
  CSR,
  EMPTY_GOLD,
  FORMAT,
  GENERATION,
  KERNEL,
  LEGACY_JSON,
  LEXICON,
  READER,
  SCORER,
  STORE,
  file
} from './crk2-corpus-workspace.js';

/** Planning and review natural-language cases, in their authored order. */
export const CRK2_NATURAL_LANGUAGE_CASES: readonly Crk2Case[] = [
  {
    id: 'planning-add-lexical-lane',
    title: 'broad planning query about adding a lane',
    query: 'what do I need to touch to add a lexical retrieval lane',
    category: 'planning_nl',
    workspace: 'crk2-retrieval',
    profile: 'planning',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 12000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(LEXICON), file(KERNEL)],
      relevantNodeIds: [file(SCORER), file(FORMAT), file('src/core/triwiki/context-graph/__tests__/lexicon.test.ts')],
      forbiddenNodeIds: [file(LEGACY_JSON)],
      confidenceCeiling: 'text_candidate'
    },
    rationale: 'A planning answer spans several files; the must-include pair is the smallest set that would actually let the work start.'
  },
  {
    id: 'planning-retire-json-runtime',
    title: 'planning query about a deletion',
    query: 'how do we retire the JSON runtime store without breaking queries',
    category: 'planning_nl',
    workspace: 'crk2-retrieval',
    profile: 'planning',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 12000,
    risk: 'high',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(LEGACY_JSON), file(STORE)],
      relevantNodeIds: [file(READER), file('docs/architecture/context-retrieval-kernel-v2.md')],
      gateIds: ['context-graph-legacy-closure'],
      confidenceCeiling: 'text_candidate'
    },
    rationale: 'The one case where the legacy module is gold rather than forbidden: you cannot delete what retrieval will not show you.'
  },
  {
    id: 'planning-token-budget-tradeoff',
    title: 'planning query about a budget trade-off',
    query: 'if we shrink the token budget which evidence do we lose first',
    category: 'planning_nl',
    workspace: 'crk2-retrieval',
    profile: 'planning',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 12000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: ['config:config/context-graph.json#max_frontier_budget', file(KERNEL)],
      relevantNodeIds: ['config:config/context-graph.json#posting_cap_per_term'],
      confidenceCeiling: 'text_candidate'
    },
    rationale: 'Budget questions must reach the config node, not just the file that happens to mention the word budget.'
  },
  {
    id: 'review-reverse-dependency',
    title: 'reverse dependency review of a changed file',
    query: 'who depends on the binary format module',
    category: 'review_nl',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: [FORMAT],
    focusPaths: [],
    tokenBudget: 10000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(READER), file(GENERATION)],
      relevantNodeIds: [file(CSR), file(STORE)],
      forbiddenNodeIds: [file('src/core/naruto/fanout-planner.ts')]
    },
    rationale: 'Reverse dependencies come from the in-edge CSR; a lexical engine answers this with whoever mentions the word format.'
  },
  {
    id: 'review-affected-tests',
    title: 'affected test selection for a changed file',
    query: 'which tests cover this change',
    category: 'review_nl',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: [LEXICON],
    focusPaths: [],
    tokenBudget: 10000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('src/core/triwiki/context-graph/__tests__/lexicon.test.ts')],
      relevantNodeIds: [file('src/core/triwiki/context-graph/__tests__/kernel.test.ts')],
      forbiddenNodeIds: [file('src/cli/__tests__/search-context.test.ts')]
    },
    rationale: 'Test selection has to be edge-driven; the forbidden entry is the test a bag-of-words match would wrongly include.'
  },
  {
    id: 'review-high-risk-change',
    title: 'review of a change inside a protected risk domain',
    query: 'what is risky about changing the redaction guard',
    category: 'review_nl',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: ['src/core/security/redaction-guard.ts'],
    focusPaths: [],
    tokenBudget: 10000,
    risk: 'high',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('src/core/security/redaction-guard.ts')],
      relevantNodeIds: ['risk:context-retrieval'],
      gateIds: ['secret-redaction'],
      protectedGateIds: ['secret-redaction']
    },
    rationale: 'A high-risk review that omits its protected gate is worse than no answer, because it reads as an all-clear.'
  }
];
