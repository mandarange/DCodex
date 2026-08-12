/**
 * CRK2 benchmark corpus: composition, integrity and structural validation.
 *
 * The gold set is what makes recall measurable instead of asserted: every case
 * names the node ids it must retrieve, so a run either produced them or did not.
 * The cases are authored from the workspace inventory in
 * `crk2-corpus-workspace.ts` — never from an engine's output — and
 * `validateCrk2Corpus` refuses a gold id that the declared workspace cannot
 * contain, which is the mechanism that stops a case from being quietly retuned
 * to whatever the candidate happened to return.
 *
 * Cases live in six category-grouped modules and are composed here in their
 * authored order, because `CRK2_CASES` order is what the comparison harness
 * reports against. This module is the only entry point: nothing outside the
 * corpus imports a group file directly.
 *
 * Reading order for anyone editing the corpus: the v1 baseline measured `korean`
 * and `jargon` as its two fastest cases, and they were fast because they matched
 * nothing. Those entries therefore carry a non-empty must-include set and a
 * confidence ceiling. Lowering either one to make a run pass inverts the
 * benchmark.
 */
import {
  CRK2_BENCHMARK_CORPUS_SCHEMA,
  CRK2_QUERY_CATEGORIES,
  CRK2_WORKSPACES,
  type Crk2Case,
  type Crk2Corpus,
  type Crk2QueryCategory
} from './crk2-types.js';
import { contextGraphIdPrefix } from '../ids.js';
import { CONTEXT_GRAPH_NODE_KINDS } from '../contracts.js';
import { isWorkspaceRelativePosixPath } from '../paths.js';
import {
  CRK2_CORPUS_REVISION,
  CRK2_DEFAULT_K,
  CRK2_GATE_IDS,
  CRK2_PROTECTED_GATE_IDS,
  CRK2_RETRIEVAL_FILES,
  crk2RetrievalNodeUniverse
} from './crk2-corpus-workspace.js';
import { CRK2_IDENTIFIER_CASES } from './crk2-corpus-identifiers.js';
import { CRK2_LANGUAGE_CASES } from './crk2-corpus-language.js';
import { CRK2_NATURAL_LANGUAGE_CASES } from './crk2-corpus-natural-language.js';
import { CRK2_SAFETY_CASES } from './crk2-corpus-safety.js';
import { CRK2_GRAPH_CASES } from './crk2-corpus-graph.js';
import { CRK2_STATE_CASES } from './crk2-corpus-state.js';

export {
  CRK2_CORPUS_REVISION,
  CRK2_DEFAULT_K,
  CRK2_GATE_IDS,
  CRK2_PROTECTED_GATE_IDS,
  CRK2_RETRIEVAL_FILES,
  CRK2_STRUCTURAL_NODE_IDS,
  crk2RetrievalNodeUniverse
} from './crk2-corpus-workspace.js';

/**
 * Every case, in authored order.
 *
 * The count is asserted in `crk2-corpus.test.ts`. A case lost in a refactor is a
 * floor that silently stops being checked, which is exactly the failure a
 * benchmark cannot self-report.
 */
export const CRK2_CASES: readonly Crk2Case[] = [
  ...CRK2_IDENTIFIER_CASES,
  ...CRK2_LANGUAGE_CASES,
  ...CRK2_NATURAL_LANGUAGE_CASES,
  ...CRK2_SAFETY_CASES,
  ...CRK2_GRAPH_CASES,
  ...CRK2_STATE_CASES
];

export const CRK2_CORPUS: Crk2Corpus = {
  schema: CRK2_BENCHMARK_CORPUS_SCHEMA,
  corpusRevision: CRK2_CORPUS_REVISION,
  defaultK: CRK2_DEFAULT_K,
  cases: CRK2_CASES
};

export function crk2CasesByCategory(): ReadonlyMap<Crk2QueryCategory, readonly Crk2Case[]> {
  const byCategory = new Map<Crk2QueryCategory, Crk2Case[]>();
  for (const testCase of CRK2_CASES) {
    const bucket = byCategory.get(testCase.category);
    if (bucket) bucket.push(testCase);
    else byCategory.set(testCase.category, [testCase]);
  }
  return byCategory;
}

const NODE_ID_PREFIXES: ReadonlySet<string> = new Set(
  CONTEXT_GRAPH_NODE_KINDS.map((kind) => `${contextGraphIdPrefix(kind)}:`)
);

function goldLiteralIds(testCase: Crk2Case): readonly string[] {
  return [
    ...testCase.gold.mustIncludeNodeIds,
    ...testCase.gold.relevantNodeIds,
    ...testCase.gold.forbiddenNodeIds,
    ...Object.keys(testCase.gold.requiredConfidence ?? {})
  ];
}

/**
 * Structural checks that hold without running anything.
 *
 * Every rule here is one a plausible edit would otherwise break silently: a gold
 * id for a file the workspace does not contain, a node that is both required and
 * forbidden, a rejection case that also expects results, or a language case that
 * lost the confidence ceiling protecting it from a mislabelled exact hit.
 */
export function validateCrk2Corpus(cases: readonly Crk2Case[] = CRK2_CASES): readonly string[] {
  const issues: string[] = [];
  const universe = crk2RetrievalNodeUniverse();
  const workspaceFiles = new Set(CRK2_RETRIEVAL_FILES);
  const gateIds = new Set(CRK2_GATE_IDS);
  const protectedGates = new Set(CRK2_PROTECTED_GATE_IDS);
  const seenIds = new Set<string>();
  const coveredCategories = new Set<Crk2QueryCategory>();

  for (const testCase of cases) {
    const at = testCase.id;
    if (seenIds.has(testCase.id)) issues.push(`${at}: duplicate case id`);
    seenIds.add(testCase.id);
    coveredCategories.add(testCase.category);

    if (!(CRK2_WORKSPACES as readonly string[]).includes(testCase.workspace)) {
      issues.push(`${at}: unknown workspace ${testCase.workspace}`);
    }
    if (!testCase.query) issues.push(`${at}: query must not be empty`);
    if (!testCase.rationale) issues.push(`${at}: every case states why it exists`);
    if (!Number.isInteger(testCase.k) || testCase.k < 1) issues.push(`${at}: k must be a positive integer`);
    if (!Number.isInteger(testCase.tokenBudget) || testCase.tokenBudget < 1) {
      issues.push(`${at}: tokenBudget must be a positive integer`);
    }

    for (const relativePath of [...testCase.changedPaths, ...testCase.focusPaths]) {
      if (!isWorkspaceRelativePosixPath(relativePath)) {
        issues.push(`${at}: ${relativePath} is not a workspace-relative POSIX path`);
      }
    }

    const gold = testCase.gold;
    const isFault = testCase.workspace === 'crk2-fault';
    if (isFault !== Boolean(gold.expectedErrorCode)) {
      issues.push(`${at}: the fault workspace and expectedErrorCode must be declared together`);
    }
    if (isFault && (gold.mustIncludeNodeIds.length || gold.relevantNodeIds.length || gold.mustIncludeMatchers.length)) {
      issues.push(`${at}: a rejection case must not also expect results`);
    }

    for (const gateId of gold.protectedGateIds) {
      if (!gold.gateIds.includes(gateId)) issues.push(`${at}: protected gate ${gateId} is missing from gateIds`);
      if (!protectedGates.has(gateId)) issues.push(`${at}: ${gateId} is not a declared protected gate`);
    }
    for (const gateId of gold.gateIds) {
      if (!gateIds.has(gateId)) issues.push(`${at}: ${gateId} is not a declared gate`);
    }

    const forbidden = new Set(gold.forbiddenNodeIds);
    for (const nodeId of gold.mustIncludeNodeIds) {
      if (forbidden.has(nodeId)) issues.push(`${at}: ${nodeId} is both required and forbidden`);
    }
    if (!isFault) {
      for (const nodeId of goldLiteralIds(testCase)) {
        if (!universe.has(nodeId)) issues.push(`${at}: ${nodeId} is not in the declared workspace inventory`);
      }
      for (const matcher of gold.mustIncludeMatchers) {
        if (matcher.kind === 'symbol' && !workspaceFiles.has(matcher.path)) {
          issues.push(`${at}: symbol matcher points at ${matcher.path}, which the workspace does not contain`);
        }
        if (matcher.kind === 'path_prefix' && !CRK2_RETRIEVAL_FILES.some((item) => item.startsWith(matcher.prefix))) {
          issues.push(`${at}: path prefix ${matcher.prefix} matches nothing in the workspace`);
        }
        if (matcher.kind === 'id_prefix' && !NODE_ID_PREFIXES.has(matcher.prefix)) {
          issues.push(`${at}: id prefix ${matcher.prefix} is not a Context Graph node-kind prefix`);
        }
      }
    }

    for (const conflict of gold.conflicts) {
      if (!isWorkspaceRelativePosixPath(conflict.path)) {
        issues.push(`${at}: conflict path ${conflict.path} is not workspace-relative`);
      }
      if (conflict.slices.length < 2) issues.push(`${at}: a conflict needs at least two slices`);
    }

    // A language the extractor cannot parse must never yield an exact relation
    // (ADR §4), so these categories are the ones that carry the ceiling.
    const needsCeiling: readonly Crk2QueryCategory[] = ['korean', 'jargon', 'acronym', 'unsupported_language'];
    if (needsCeiling.includes(testCase.category) && !gold.confidenceCeiling) {
      issues.push(`${at}: ${testCase.category} cases must declare a confidenceCeiling`);
    }
    if (gold.maxTokenCost !== undefined && gold.maxTokenCost > testCase.tokenBudget) {
      issues.push(`${at}: maxTokenCost exceeds the case token budget`);
    }
  }

  for (const category of CRK2_QUERY_CATEGORIES) {
    if (!coveredCategories.has(category)) issues.push(`corpus: category ${category} has no case`);
  }
  return issues;
}
