import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRK2_CASES,
  CRK2_CORPUS,
  CRK2_PROTECTED_GATE_IDS,
  crk2CasesByCategory,
  crk2RetrievalNodeUniverse,
  validateCrk2Corpus
} from '../crk2-corpus.js';
import { CRK2_IDENTIFIER_CASES } from '../crk2-corpus-identifiers.js';
import { CRK2_LANGUAGE_CASES } from '../crk2-corpus-language.js';
import { CRK2_NATURAL_LANGUAGE_CASES } from '../crk2-corpus-natural-language.js';
import { CRK2_SAFETY_CASES } from '../crk2-corpus-safety.js';
import { CRK2_GRAPH_CASES } from '../crk2-corpus-graph.js';
import { CRK2_STATE_CASES } from '../crk2-corpus-state.js';
import { CRK2_QUERY_CATEGORIES, type Crk2Case } from '../crk2-types.js';
import { scanForLeaks } from '../floors.js';
import { isWorkspaceRelativePosixPath } from '../../paths.js';

/** ADR §5 fixes the error vocabulary; a rejection case may not invent a code. */
const ADR_ERROR_CODES = new Set([
  'context_index_missing',
  'context_index_stale',
  'context_index_format_unsupported',
  'context_index_checksum_mismatch',
  'context_index_truncated',
  'context_index_pointer_meta_divergent',
  'context_operation_journal_corrupt'
]);

function cloneCase(testCase: Crk2Case, gold: Partial<Crk2Case['gold']>): Crk2Case {
  return { ...testCase, gold: { ...testCase.gold, ...gold } };
}

test('the corpus carries at least the forty cases the work order requires', () => {
  assert.ok(CRK2_CASES.length >= 40, `expected 40+ cases, got ${CRK2_CASES.length}`);
  assert.equal(CRK2_CORPUS.cases.length, CRK2_CASES.length);
  assert.equal(new Set(CRK2_CASES.map((item) => item.id)).size, CRK2_CASES.length, 'case ids must be unique');
});

/**
 * Exact counts, not bounds.
 *
 * The corpus is split across six category modules that are composed in
 * `crk2-corpus.ts`. A case dropped during a refactor is a floor that silently
 * stops being checked, and nothing else in the harness would notice — so the
 * totals are pinned here. Raising them is a corpus change and belongs in the
 * same commit as the new cases; lowering one is the edit this test exists to
 * stop.
 */
test('every case and gold target survives composition across the group modules', () => {
  assert.equal(CRK2_CASES.length, 62);
  const goldTargets = CRK2_CASES.reduce(
    (sum, item) => sum + item.gold.mustIncludeNodeIds.length + item.gold.mustIncludeMatchers.length,
    0
  );
  assert.equal(goldTargets, 76);
});

test('each category group contributes its cases and none contributes them twice', () => {
  const groups = [
    CRK2_IDENTIFIER_CASES,
    CRK2_LANGUAGE_CASES,
    CRK2_NATURAL_LANGUAGE_CASES,
    CRK2_SAFETY_CASES,
    CRK2_GRAPH_CASES,
    CRK2_STATE_CASES
  ];
  for (const group of groups) assert.ok(group.length > 0, 'an empty group module means a lost cluster');
  const composed = groups.reduce((sum, group) => sum + group.length, 0);
  assert.equal(composed, CRK2_CASES.length, 'composition must be a partition, not a filter');
  assert.deepEqual(
    CRK2_CASES.map((item) => item.id),
    groups.flatMap((group) => group.map((item) => item.id)),
    'CRK2_CASES order is what the comparison report is keyed on'
  );
});

test('the shipped corpus passes every structural invariant', () => {
  assert.deepEqual(validateCrk2Corpus(), []);
});

test('every declared query category has at least one case', () => {
  const byCategory = crk2CasesByCategory();
  for (const category of CRK2_QUERY_CATEGORIES) {
    const bucket = byCategory.get(category) ?? [];
    assert.ok(bucket.length > 0, `category ${category} has no case`);
  }
});

test('korean and jargon cases are a recall floor, not a latency budget', () => {
  const languageCases = CRK2_CASES.filter((item) => item.category === 'korean' || item.category === 'jargon');
  assert.ok(languageCases.length >= 6, 'both language categories need real coverage, not a token case each');
  for (const testCase of languageCases) {
    const targets = testCase.gold.mustIncludeNodeIds.length + testCase.gold.mustIncludeMatchers.length;
    assert.ok(targets > 0, `${testCase.id}: the v1 baseline answered these in ~1 ms by matching nothing`);
    assert.equal(
      testCase.gold.confidenceCeiling,
      'text_candidate',
      `${testCase.id}: ADR §4 forbids promoting one of these hits to an exact relation`
    );
  }
});

test('rejection cases and the fault workspace are the same set, with ADR error codes', () => {
  const faultCases = CRK2_CASES.filter((item) => item.workspace === 'crk2-fault');
  const rejectionCases = CRK2_CASES.filter((item) => item.gold.expectedErrorCode !== undefined);
  assert.deepEqual(faultCases.map((item) => item.id).sort(), rejectionCases.map((item) => item.id).sort());
  assert.ok(faultCases.length >= 5, 'corrupt-input rejection is a 100% floor, so it needs more than a token case');
  for (const testCase of faultCases) {
    assert.ok(ADR_ERROR_CODES.has(String(testCase.gold.expectedErrorCode)), `${testCase.id} names an unknown error code`);
  }
});

test('every protected gate the corpus declares is one of the declared protected gates', () => {
  const declared = new Set(CRK2_PROTECTED_GATE_IDS);
  const exercised = new Set<string>();
  for (const testCase of CRK2_CASES) {
    for (const gateId of testCase.gold.protectedGateIds) {
      assert.ok(declared.has(gateId), `${testCase.id}: ${gateId} is not a protected gate`);
      exercised.add(gateId);
    }
  }
  assert.deepEqual([...exercised].sort(), [...declared].sort(), 'every protected gate needs at least one case');
});

test('conflict recall has cases to measure', () => {
  const withConflicts = CRK2_CASES.filter((item) => item.gold.conflicts.length > 0);
  assert.ok(withConflicts.length >= 3, 'a 1.0 conflict-recall floor measured on one case is barely measured');
  const widest = Math.max(...withConflicts.flatMap((item) => item.gold.conflicts.map((conflict) => conflict.slices.length)));
  assert.ok(widest >= 3, 'an n-way collision is not the same shape as a pair, so the corpus must contain one');
  for (const testCase of withConflicts) {
    for (const conflict of testCase.gold.conflicts) {
      assert.ok(isWorkspaceRelativePosixPath(conflict.path));
      assert.ok(conflict.slices.length >= 2);
    }
  }
});

test('nothing in the corpus leaks an absolute, home, temp or secret-shaped value', () => {
  const serialized = JSON.stringify(CRK2_CORPUS);
  const scan = scanForLeaks(serialized);
  assert.deepEqual(scan.secretRules, []);
  assert.deepEqual(scan.pathRules, []);
  for (const testCase of CRK2_CASES) {
    for (const relativePath of [...testCase.changedPaths, ...testCase.focusPaths]) {
      assert.ok(isWorkspaceRelativePosixPath(relativePath), `${testCase.id}: ${relativePath} must be workspace-relative`);
    }
  }
});

test('every literal gold id names a node the declared workspace can produce', () => {
  const universe = crk2RetrievalNodeUniverse();
  for (const testCase of CRK2_CASES) {
    if (testCase.workspace === 'crk2-fault') continue;
    for (const nodeId of [...testCase.gold.mustIncludeNodeIds, ...testCase.gold.relevantNodeIds, ...testCase.gold.forbiddenNodeIds]) {
      assert.ok(universe.has(nodeId), `${testCase.id}: ${nodeId} is outside the workspace inventory`);
    }
  }
});

test('the validator rejects a gold id the workspace cannot contain', () => {
  const target = CRK2_CASES.find((item) => item.workspace === 'crk2-retrieval');
  assert.ok(target);
  const issues = validateCrk2Corpus([cloneCase(target, { mustIncludeNodeIds: ['file:src/invented/module.ts'] })]);
  assert.ok(issues.some((issue) => issue.includes('not in the declared workspace inventory')), issues.join('\n'));
});

test('the validator rejects a node that is both required and forbidden', () => {
  const target = CRK2_CASES.find((item) => item.workspace === 'crk2-retrieval' && item.gold.mustIncludeNodeIds.length > 0);
  assert.ok(target);
  const nodeId = target.gold.mustIncludeNodeIds[0];
  assert.ok(nodeId);
  const issues = validateCrk2Corpus([cloneCase(target, { forbiddenNodeIds: [nodeId] })]);
  assert.ok(issues.some((issue) => issue.includes('both required and forbidden')), issues.join('\n'));
});

test('the validator rejects a protected gate that is not also a declared gate', () => {
  const target = CRK2_CASES.find((item) => item.gold.protectedGateIds.length > 0);
  assert.ok(target);
  const issues = validateCrk2Corpus([cloneCase(target, { gateIds: [] })]);
  assert.ok(issues.some((issue) => issue.includes('is missing from gateIds')), issues.join('\n'));
});

test('the validator rejects a language case that lost its confidence ceiling', () => {
  const target = CRK2_CASES.find((item) => item.category === 'korean');
  assert.ok(target);
  const stripped: Crk2Case = { ...target, gold: { ...target.gold } };
  delete (stripped.gold as { confidenceCeiling?: unknown }).confidenceCeiling;
  const issues = validateCrk2Corpus([stripped]);
  assert.ok(issues.some((issue) => issue.includes('confidenceCeiling')), issues.join('\n'));
});

test('the validator rejects a rejection case that also expects results', () => {
  const target = CRK2_CASES.find((item) => item.workspace === 'crk2-fault');
  assert.ok(target);
  const issues = validateCrk2Corpus([cloneCase(target, { mustIncludeNodeIds: ['file:config/context-graph.json'] })]);
  assert.ok(issues.some((issue) => issue.includes('must not also expect results')), issues.join('\n'));
});

test('the validator reports a category that lost its only case', () => {
  const remaining = CRK2_CASES.filter((item) => item.category !== 'focus_path');
  const issues = validateCrk2Corpus(remaining);
  assert.ok(issues.some((issue) => issue === 'corpus: category focus_path has no case'), issues.join('\n'));
});

test('every case explains why it exists', () => {
  for (const testCase of CRK2_CASES) {
    assert.ok(testCase.rationale.length > 20, `${testCase.id}: a one-word rationale survives no review`);
    assert.ok(testCase.query.length > 0);
  }
});
