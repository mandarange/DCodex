import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTEXT_GRAPH_QUERY_PROFILES } from '../../profiles.js';
import { normalizeLexiconQuery } from '../../runtime-index/lexicon.js';
import { CONTEXT_GRAPH_LEXICON_CONFIG } from '../ranking-config.js';
import { fixedKernelClock, resolveQueryPlan } from '../kernel.js';
import { GATE_ID, KERNEL_PATH, openKernelIndex } from './kernel-fixtures.js';

const clock = fixedKernelClock(1_000);

test('the query is normalized once, by the lexicon, and the plan carries the result', () => {
  const reader = openKernelIndex();
  const context = resolveQueryPlan(reader, { query: '  Kernel Retrieval  ' }, { clock });

  // Identical to what the tokenizer would produce for a document, which is the
  // property that makes a query term and a document term the same string.
  const expected = normalizeLexiconQuery('  Kernel Retrieval  ', CONTEXT_GRAPH_LEXICON_CONFIG);
  assert.equal(context.normalizedQuery, expected.normalized);
  assert.deepEqual([...context.terms], [...expected.terms]);

  // Every plan term id resolves through the same dictionary the lanes read.
  for (const id of context.plan.termIds) assert.ok(id >= 0);
  assert.ok(context.plan.termIds.includes(reader.termId('kernel')));
  assert.ok(context.plan.termIds.includes(reader.termId('retrieval')));
});

test('shape follows the query, and only an identifier-shaped token makes it anchored', () => {
  const reader = openKernelIndex();
  assert.equal(resolveQueryPlan(reader, { query: GATE_ID }, { clock }).plan.shape, 'anchored');
  assert.equal(resolveQueryPlan(reader, { query: KERNEL_PATH }, { clock }).plan.shape, 'anchored');
  assert.equal(
    resolveQueryPlan(reader, { query: 'how does retrieval pick a candidate' }, { clock }).plan.shape,
    'natural',
  );
  assert.equal(
    resolveQueryPlan(reader, { query: `${GATE_ID} how does retrieval pick a lane candidate today` }, { clock }).plan.shape,
    'mixed',
  );
});

test('a plan is resolved once and is a pure function of its inputs', () => {
  const reader = openKernelIndex();
  const request = { query: 'kernel retrieval', profile: 'review' as const, risk: 'high' as const };
  const first = resolveQueryPlan(reader, request, { clock });
  const second = resolveQueryPlan(reader, request, { clock });
  assert.deepEqual(first.plan, second.plan);
  assert.ok(Object.isFrozen(first.plan), 'a lane must not be able to edit the plan it was handed');
});

test('the profile decides depth, mask and lane mix; high risk deepens it', () => {
  const reader = openKernelIndex();
  const normal = resolveQueryPlan(reader, { query: 'kernel', profile: 'implementation' }, { clock });
  const risky = resolveQueryPlan(reader, { query: 'kernel', profile: 'implementation', risk: 'high' }, { clock });
  assert.equal(normal.plan.maxDepth, CONTEXT_GRAPH_QUERY_PROFILES.implementation.maxDepth);
  assert.equal(risky.plan.maxDepth, CONTEXT_GRAPH_QUERY_PROFILES.implementation.maxDepthHighRisk);
  assert.ok(risky.plan.maxDepth > normal.plan.maxDepth);

  // A zero mask selects nothing, so neither may ever be zero.
  assert.notEqual(normal.plan.profileMask, 0);
  assert.notEqual(normal.plan.fieldMask, 0);

  const review = resolveQueryPlan(reader, { query: 'kernel', profile: 'review' }, { clock });
  assert.notEqual(review.plan.profileMask, normal.plan.profileMask);
  // `conflicts_with` is a review edge and not an implementation one; the mask
  // is what makes that difference cost nothing at traversal time.
  assert.notEqual(review.edgeTypeMask, normal.edgeTypeMask);
});

test('the safety edge set is the closure\'s own, not the profile\'s', () => {
  const reader = openKernelIndex();
  const implementation = resolveQueryPlan(reader, { query: 'kernel', profile: 'implementation' }, { clock });
  // A profile that does not rank conflicts must still have them in the closure.
  assert.equal(implementation.edgeTypeMask & implementation.conflictEdgeMask, 0);
  assert.equal(
    implementation.safetyEdgeMask & implementation.conflictEdgeMask,
    implementation.conflictEdgeMask,
  );
});

test('an absolute path in a query is redacted and reported, never indexed or echoed', () => {
  const reader = openKernelIndex();
  const context = resolveQueryPlan(reader, { query: '/Users/someone/secret/kernel.ts' }, { clock });
  assert.equal(context.warnings.length, 1);
  assert.match(context.warnings[0] as string, /redacted/);
  assert.ok(!context.warnings[0]?.includes('someone'), 'a redaction must not echo what it redacted');
});

test('an unusable focus path is reported rather than silently widening the answer', () => {
  const reader = openKernelIndex();
  const context = resolveQueryPlan(reader, { query: 'kernel', focusPaths: ['/etc/passwd', '../up'] }, { clock });
  assert.deepEqual([...context.focusPaths], []);
  assert.equal(context.omissions.focus_filtered, 2);
});

test('the plan never reads the wall clock', () => {
  const reader = openKernelIndex();
  const real = Date.now;
  Date.now = () => {
    throw new Error('Date.now is not available to the kernel');
  };
  try {
    const context = resolveQueryPlan(reader, { query: 'kernel' }, { clock: fixedKernelClock(42) });
    assert.equal(context.startedAt, 42);
    assert.equal(context.deadline, 42 + 1500);
  } finally {
    Date.now = real;
  }
});
