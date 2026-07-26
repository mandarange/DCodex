import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_GRAPH_QUERY_PROFILES,
  CONTEXT_GRAPH_TRAVERSAL_CAPS,
  profileTraversesEdge
} from '../../profiles.js';
import { CONTEXT_GRAPH_RANKING_CONFIG } from '../../query/ranking-config.js';
import { generateContextGraphCandidates } from '../candidates.js';
import { baselineContextGraphTuning, readNumberAtPointer, resolveContextGraphTuning } from '../resolve.js';
import { validateContextGraphCandidate } from '../validate.js';

test('resolving with no overrides reproduces the checked-in tuning', () => {
  const tuning = baselineContextGraphTuning();
  assert.deepEqual(tuning.ranking, CONTEXT_GRAPH_RANKING_CONFIG);
  assert.deepEqual(tuning.traversalCaps, CONTEXT_GRAPH_TRAVERSAL_CAPS);
  assert.deepEqual(tuning.profiles.implementation, CONTEXT_GRAPH_QUERY_PROFILES.implementation);
  assert.deepEqual(tuning.appliedPointers, []);
});

test('an override is applied to the clone and never to the checked-in objects', () => {
  const before = CONTEXT_GRAPH_RANKING_CONFIG.depthDecay;
  const beforeWeight = CONTEXT_GRAPH_QUERY_PROFILES.review.edgeWeights.tests;
  const resolved = resolveContextGraphTuning([
    { target: 'ranking-config', pointer: 'depthDecay', value: 0.42 },
    { target: 'profiles', pointer: 'profiles.review.edgeWeights.tests', value: 3.5 },
    { target: 'profiles', pointer: 'traversalCaps.maxSelectedNodes', value: 32 }
  ]);
  assert.deepEqual(resolved.unresolved, []);
  assert.equal(resolved.tuning.ranking.depthDecay, 0.42);
  assert.equal(resolved.tuning.profiles.review.edgeWeights.tests, 3.5);
  assert.equal(resolved.tuning.traversalCaps.maxSelectedNodes, 32);
  assert.deepEqual(resolved.tuning.appliedPointers, [
    'profiles:profiles.review.edgeWeights.tests',
    'profiles:traversalCaps.maxSelectedNodes',
    'ranking-config:depthDecay'
  ]);

  assert.equal(CONTEXT_GRAPH_RANKING_CONFIG.depthDecay, before, 'the module constant must be untouched');
  assert.equal(CONTEXT_GRAPH_QUERY_PROFILES.review.edgeWeights.tests, beforeWeight);
  assert.equal(CONTEXT_GRAPH_TRAVERSAL_CAPS.maxSelectedNodes, 64);
});

test('a zero weight removes an edge from a profile edge set and a positive weight adds one', () => {
  const removal = resolveContextGraphTuning([
    { target: 'profiles', pointer: 'profiles.implementation.edgeWeights.tests', value: 0 }
  ]).tuning;
  assert.equal(profileTraversesEdge(removal.profiles.implementation, 'tests'), false);
  assert.ok(!removal.profiles.implementation.edges.includes('tests'));
  assert.ok(removal.profiles.implementation.edges.includes('defines'), 'the other edges survive');

  const addition = resolveContextGraphTuning([
    { target: 'profiles', pointer: 'profiles.answer.edgeWeights.gated_by', value: 1.5 }
  ]).tuning;
  assert.equal(profileTraversesEdge(addition.profiles.answer, 'gated_by'), true);
  assert.ok(addition.profiles.answer.edges.includes('gated_by'));
  assert.equal(CONTEXT_GRAPH_QUERY_PROFILES.answer.edges.includes('gated_by'), false);
});

test('the declared edge order is deterministic across resolutions', () => {
  const overrides = [{ target: 'profiles' as const, pointer: 'profiles.answer.edgeWeights.tests', value: 2 }];
  const first = resolveContextGraphTuning(overrides).tuning.profiles.answer.edges;
  const second = resolveContextGraphTuning(overrides).tuning.profiles.answer.edges;
  assert.deepEqual(first, second);
});

test('a pointer that does not lead to a writable slot is reported, not silently ignored', () => {
  const resolved = resolveContextGraphTuning([
    { target: 'profiles', pointer: 'profiles.nonexistent.maxDepth', value: 2 }
  ]);
  assert.deepEqual(resolved.unresolved, ['profiles:profiles.nonexistent.maxDepth']);
});

test('readNumberAtPointer reads through nested records and refuses non-numbers', () => {
  assert.equal(readNumberAtPointer(CONTEXT_GRAPH_RANKING_CONFIG, 'seedConfidenceScore.exact_definition'), 6);
  assert.equal(readNumberAtPointer(CONTEXT_GRAPH_RANKING_CONFIG, 'schema'), null);
  assert.equal(readNumberAtPointer(CONTEXT_GRAPH_RANKING_CONFIG, 'missing.path'), null);
});

test('generated candidates are deterministic, single-parameter and always valid', () => {
  const first = generateContextGraphCandidates({ maxCandidates: 8 });
  const second = generateContextGraphCandidates({ maxCandidates: 8 });
  assert.ok(first.length > 0);
  assert.deepEqual(
    first.map((item) => item.id),
    second.map((item) => item.id)
  );
  const ids = new Set(first.map((item) => item.id));
  assert.equal(ids.size, first.length, 'candidate ids must be unique');
  for (const item of first) {
    assert.equal(item.overrides.length, 1, 'a generated candidate changes exactly one parameter');
    const verdict = validateContextGraphCandidate(item);
    assert.equal(verdict.kind, 'accepted', `${item.id}: ${verdict.rejections.map((r) => r.code).join(',')}`);
  }
});

test('a generated candidate never restates the checked-in value', () => {
  for (const item of generateContextGraphCandidates({ maxCandidates: 24 })) {
    const override = item.overrides[0];
    assert.ok(override);
    const baseline =
      override.target === 'ranking-config'
        ? readNumberAtPointer(CONTEXT_GRAPH_RANKING_CONFIG, override.pointer)
        : readNumberAtPointer({ profiles: CONTEXT_GRAPH_QUERY_PROFILES, traversalCaps: CONTEXT_GRAPH_TRAVERSAL_CAPS }, override.pointer);
    assert.notEqual(override.value, baseline);
  }
});
