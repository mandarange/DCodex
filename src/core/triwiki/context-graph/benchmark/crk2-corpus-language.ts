/**
 * Jargon, Korean, mixed Korean/English, and unsupported-language queries.
 *
 * This is the file the baseline warns about. v1 answered `korean` in 1.20 ms
 * and `jargon` in 1.36 ms — its two fastest cases — because it matched nothing
 * at all. Every case here therefore declares a non-empty must-include set, which
 * turns that speed back into the recall failure it always was.
 *
 * Every case also declares a `confidenceCeiling`. ADR §4 is explicit that a
 * BM25F match never yields `exact` at any magnitude and that an
 * unsupported-language result is never promoted to an exact relation, so the
 * ceiling is what makes "we fixed Korean recall" by relabelling a text hit
 * register as a floor breach instead of an improvement. Removing either the
 * must-include set or the ceiling inverts the benchmark.
 */
import type { Crk2Case } from './crk2-types.js';
import {
  CRK2_DEFAULT_K,
  EMPTY_GOLD,
  GENERATION,
  KERNEL,
  KO_CLAIM,
  SMOKE_PY,
  STORE,
  confidence,
  file
} from './crk2-corpus-workspace.js';

/** Non-Latin, jargon and unsupported-language cases, in their authored order. */
export const CRK2_LANGUAGE_CASES: readonly Crk2Case[] = [
  {
    id: 'jargon-naruto-fanout',
    title: 'project jargon with no generic synonym',
    query: 'naruto fanout ceiling',
    category: 'jargon',
    workspace: 'crk2-retrieval',
    profile: 'planning',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('src/core/naruto/fanout-planner.ts')],
      relevantNodeIds: [file('.sneakoscope/naruto/slice-plan.json')],
      confidenceCeiling: 'text_candidate'
    },
    rationale: 'v1 answered jargon in 1.36 ms by matching nothing; a non-empty must-include set is the floor that reading replaces.'
  },
  {
    id: 'jargon-align-run-repair',
    title: 'jargon naming the repair command',
    query: 'align run rebuild index',
    category: 'jargon',
    workspace: 'crk2-retrieval',
    profile: 'planning',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('src/core/triwiki/align-runner.ts')],
      relevantNodeIds: [file(STORE), file(GENERATION)],
      confidenceCeiling: 'text_candidate'
    },
    rationale: 'Every ADR §5 error names this command; a caller asking about it must land on the code that implements it.'
  },
  {
    id: 'jargon-triwiki-claim-freshness',
    title: 'jargon spanning two subsystems',
    query: 'triwiki claim freshness proof',
    category: 'jargon',
    workspace: 'crk2-retrieval',
    profile: 'answer',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('.sneakoscope/wiki/proof-index.json')],
      mustIncludeMatchers: [{ kind: 'id_prefix', prefix: 'claim:' }],
      relevantNodeIds: ['proof:context-retrieval-baseline'],
      confidenceCeiling: 'text_candidate'
    },
    rationale: 'Claim ids are content hashes, so the gold uses a matcher; an exact-id gold here would be unwritable and therefore untested.'
  },
  {
    id: 'korean-budget-question',
    title: 'Korean natural-language question about a budget',
    query: '컨텍스트 검색 예산은 어디서 정하나',
    category: 'korean',
    workspace: 'crk2-retrieval',
    profile: 'answer',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(KO_CLAIM)],
      relevantNodeIds: [file('config/context-graph.json'), 'config:config/context-graph.json#max_frontier_budget'],
      confidenceCeiling: 'text_candidate'
    },
    rationale: 'v1 returned nothing in 1.20 ms. This case exists to make that a recall failure rather than a latency headline.'
  },
  {
    id: 'korean-protected-gate-question',
    title: 'Korean question about what a protected gate blocks',
    query: '보호 게이트가 무엇을 막는지 알려줘',
    category: 'korean',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'high',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('release-gates.v2.json')],
      gateIds: ['release-proof-integrity', 'secret-redaction'],
      protectedGateIds: ['release-proof-integrity', 'secret-redaction'],
      confidenceCeiling: 'text_candidate'
    },
    rationale: 'Protected-gate recall is 1.0 in every language; a query the tokenizer cannot segment is still a safety query.'
  },
  {
    id: 'korean-conflict-question',
    title: 'Korean question about two slices writing one file',
    query: '슬라이스 두 개가 같은 파일을 쓰면 어떻게 되나',
    category: 'korean',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'high',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('src/core/shared/registry.ts')],
      conflicts: [{ path: 'src/core/shared/registry.ts', slices: ['slice-writer-a', 'slice-writer-b'] }],
      gateIds: ['write-scope-isolation'],
      protectedGateIds: ['write-scope-isolation'],
      confidenceCeiling: 'text_candidate'
    },
    rationale: 'Conflict recall must not depend on query language; the collision is a graph fact, not a text match.'
  },
  {
    id: 'mixed-korean-kernel-symbol',
    title: 'Korean sentence carrying an English identifier',
    query: 'kernel.ts 에서 frontierBudget 는 어디서 계산해',
    category: 'mixed_korean_english',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(KERNEL)],
      relevantNodeIds: ['config:config/context-graph.json#max_frontier_budget'],
      requiredConfidence: confidence(file(KERNEL), 'file_path')
    },
    rationale: 'The embedded basename and identifier are exact anchors even though the surrounding sentence is not tokenizable.'
  },
  {
    id: 'mixed-korean-gate-id',
    title: 'Korean sentence carrying a gate id',
    query: 'context-graph:quality 게이트 통과 조건이 뭐야',
    category: 'mixed_korean_english',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('release-gates.v2.json')],
      gateIds: ['context-graph-quality']
    },
    rationale: 'A gate id is an exact anchor per ADR §4; wrapping it in Korean must not demote it to a text candidate.'
  },
  {
    id: 'unsupported-language-python-tool',
    title: 'a file in a language no extractor parses',
    query: 'context graph smoke script',
    category: 'unsupported_language',
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
    rationale: 'ADR §4: an unsupported-language result is never promoted to an exact relation, however well the path matches.'
  }
];
