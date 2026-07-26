import assert from 'node:assert/strict';
import test from 'node:test';
import { queryContextGraphSnapshot } from '../index.js';
import { buildFixtureIndex, IDS } from './query-fixtures.js';

const index = buildFixtureIndex();

function groupOf(nodePath: string | undefined): string {
  if (!nodePath) return '.';
  const cut = nodePath.lastIndexOf('/');
  return cut > 0 ? nodePath.slice(0, cut) : '.';
}

test('a high risk review query selects the reachable protected gate', () => {
  const result = queryContextGraphSnapshot(index, {
    root: '.',
    query: 'src/app/service.ts',
    profile: 'review',
    risk: 'high'
  });
  assert.ok(result.selected.some((node) => node.nodeId === IDS.gateRelease));
});

test('a protected gate survives a budget too small for the exact seed', () => {
  const result = queryContextGraphSnapshot(index, {
    root: '.',
    query: 'src/app/service.ts',
    profile: 'review',
    risk: 'high',
    tokenBudget: 40
  });
  assert.ok(result.selected.some((node) => node.nodeId === IDS.gateRelease), 'guarantee 4 holds under pressure');
  assert.ok(result.tokenCost <= 40, 'guarantee 7: the budget is never exceeded');
  assert.equal(result.truncated, true);
  assert.ok((result.omissionReasons.token_budget ?? 0) > 0);
  assert.ok(result.warnings.some((warning) => warning.includes('exact seed did not fit')));
});

test('an implementation query keeps a reachable test even on a tight budget', () => {
  const result = queryContextGraphSnapshot(index, {
    root: '.',
    query: 'runService',
    profile: 'implementation',
    tokenBudget: 100
  });
  assert.ok(result.selected.some((node) => node.nodeId === IDS.testService), 'guarantee 3 holds');
  assert.ok(result.selected.some((node) => node.nodeId === IDS.symbolRun), 'guarantee 1 holds');
  assert.ok(result.tokenCost <= 100);
});

test('the token budget is never exceeded and truncation is reported with reasons', () => {
  const result = queryContextGraphSnapshot(index, {
    root: '.',
    query: 'runService',
    tokenBudget: 30
  });
  assert.ok(result.tokenCost <= 30);
  assert.equal(result.tokenBudget, 30);
  assert.equal(result.truncated, true);
  assert.ok((result.omissionReasons.token_budget ?? 0) > 0, 'the omission is named, not silent');
});

test('a zero budget selects nothing and says why', () => {
  const result = queryContextGraphSnapshot(index, { root: '.', query: 'runService', tokenBudget: 0 });
  assert.equal(result.selectedNodes, 0);
  assert.equal(result.tokenCost, 0);
  assert.equal(result.truncated, true);
  assert.ok((result.omissionReasons.token_budget ?? 0) > 0);
  assert.equal(result.provenanceCoverage, 1, 'an empty selection is fully grounded by definition');
});

test('structural diversity keeps one directory from monopolizing the selection', () => {
  const result = queryContextGraphSnapshot(index, {
    root: '.',
    query: 'runService',
    maxSelected: 4
  });
  assert.ok(result.selected.length <= 4);
  const groups = new Set(result.selected.map((node) => groupOf(node.path)));
  assert.ok(groups.size >= 2, 'the selection spans more than one structural group');
});

test('the selection cap is honoured and reported', () => {
  const result = queryContextGraphSnapshot(index, { root: '.', query: 'runService', maxSelected: 1 });
  assert.equal(result.selectedNodes, 1);
  assert.equal(result.truncated, true);
  assert.ok((result.omissionReasons.max_selected ?? 0) > 0);
});

test('every selected node carries a reason path and at least one provenance record', () => {
  const result = queryContextGraphSnapshot(index, { root: '.', query: 'runService', profile: 'planning' });
  for (const node of result.selected) {
    assert.ok(node.reasonPath.length > 0);
    assert.ok(node.provenance.length > 0);
  }
  assert.equal(result.provenanceCoverage, 1);
});

test('the reported token cost equals the sum of the selected node costs', () => {
  const result = queryContextGraphSnapshot(index, { root: '.', query: 'runService' });
  const summed = result.selected.reduce((total, node) => total + node.tokenCost, 0);
  assert.equal(result.tokenCost, summed);
});
