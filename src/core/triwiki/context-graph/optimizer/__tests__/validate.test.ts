import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyContextGraphPatchTarget, CONTEXT_GRAPH_TUNABLE_FILES } from '../allowlist.js';
import { contextGraphTunableParameters, resolveContextGraphTunableParameter } from '../parameter-space.js';
import { validateContextGraphCandidate } from '../validate.js';
import type { ContextGraphExperimentCandidate, ContextGraphParameterOverride } from '../types.js';

function candidate(overrides: readonly ContextGraphParameterOverride[], id = 'exp-001-test'): ContextGraphExperimentCandidate {
  return { id, label: 'test candidate', rationale: 'test', overrides };
}

test('the allowlist admits exactly the two tuning files', () => {
  assert.deepEqual(CONTEXT_GRAPH_TUNABLE_FILES, [
    'src/core/triwiki/context-graph/profiles.ts',
    'src/core/triwiki/context-graph/query/ranking-config.ts'
  ]);
  for (const file of CONTEXT_GRAPH_TUNABLE_FILES) {
    assert.equal(classifyContextGraphPatchTarget(file), 'tunable');
  }
});

test('a candidate that names a file outside the allowlist is rejected', () => {
  for (const file of [
    'src/core/triwiki/context-graph/query/rank.ts',
    'src/core/triwiki/context-graph/compiler/index.ts',
    'package.json',
    'src/cli/command-registry.ts',
    '../outside/ranking-config.ts',
    '/etc/passwd'
  ]) {
    assert.equal(classifyContextGraphPatchTarget(file), 'forbidden', file);
    const verdict = validateContextGraphCandidate(
      candidate([{ target: file as never, pointer: 'depthDecay', value: 0.5 }])
    );
    assert.equal(verdict.kind, 'rejected', file);
    assert.equal(verdict.tuning, null);
    assert.ok(
      verdict.rejections.some((item) => item.code === 'file_not_allowlisted'),
      `${file} must be rejected as non-allowlisted`
    );
  }
});

test('a candidate that touches the benchmark corpus, its fixtures or its scorer is an integrity violation', () => {
  const measurement = [
    'config/context-graph-benchmark.json',
    'src/core/triwiki/context-graph/benchmark/score.ts',
    'src/core/triwiki/context-graph/benchmark/floors.ts',
    'src/core/triwiki/context-graph/benchmark/metrics.ts',
    'src/core/triwiki/context-graph/benchmark/corpus.ts',
    'src/core/triwiki/context-graph/benchmark/fixtures/definitions-code.ts',
    'dist/core/triwiki/context-graph/benchmark/score.js'
  ];
  for (const file of measurement) {
    assert.equal(classifyContextGraphPatchTarget(file), 'measurement', file);
    const verdict = validateContextGraphCandidate(
      candidate([{ target: file as never, pointer: 'depthDecay', value: 0.5 }])
    );
    assert.equal(verdict.kind, 'integrity_violation', file);
    assert.equal(verdict.tuning, null);
    assert.deepEqual(
      verdict.rejections.map((item) => item.code),
      ['benchmark_integrity_violation']
    );
  }
});

test('an integrity violation outranks an ordinary rejection in the same candidate', () => {
  const verdict = validateContextGraphCandidate(
    candidate([
      { target: 'src/cli/command-registry.ts' as never, pointer: 'depthDecay', value: 0.5 },
      { target: 'config/context-graph-benchmark.json' as never, pointer: 'depthDecay', value: 0.5 }
    ])
  );
  assert.equal(verdict.kind, 'integrity_violation');
});

test('a tuning file may be addressed by target name or by its workspace path', () => {
  const byName = validateContextGraphCandidate(candidate([{ target: 'ranking-config', pointer: 'depthDecay', value: 0.5 }]));
  const byPath = validateContextGraphCandidate(
    candidate([
      { target: 'src/core/triwiki/context-graph/query/ranking-config.ts' as never, pointer: 'depthDecay', value: 0.5 }
    ])
  );
  assert.equal(byName.kind, 'accepted');
  assert.equal(byPath.kind, 'accepted');
  assert.equal(byName.tuning?.ranking.depthDecay, 0.5);
  assert.equal(byPath.tuning?.ranking.depthDecay, 0.5);
});

test('every checked-in value sits inside its own declared bounds', () => {
  const parameters = contextGraphTunableParameters();
  assert.ok(parameters.length > 40, 'the derived parameter space must cover the whole tuning surface');
  for (const parameter of parameters) {
    assert.ok(parameter.min <= parameter.baseline, `${parameter.pointer} baseline below its floor`);
    assert.ok(parameter.baseline <= parameter.max, `${parameter.pointer} baseline above its ceiling`);
    assert.ok(parameter.rule.length > 0, `${parameter.pointer} matched no bound rule`);
    if (parameter.kind === 'integer') {
      assert.ok(Number.isInteger(parameter.baseline), `${parameter.pointer} declared integer but is not`);
    }
  }
});

test('an unknown pointer, a non-finite value and an out-of-bounds value are all rejected', () => {
  const unknown = validateContextGraphCandidate(candidate([{ target: 'ranking-config', pointer: 'nope', value: 1 }]));
  assert.equal(unknown.kind, 'rejected');
  assert.equal(unknown.rejections[0]?.code, 'unknown_parameter');

  const nonFinite = validateContextGraphCandidate(
    candidate([{ target: 'ranking-config', pointer: 'depthDecay', value: Number.NaN }])
  );
  assert.equal(nonFinite.rejections[0]?.code, 'value_not_finite');

  const parameter = resolveContextGraphTunableParameter('ranking-config', 'depthDecay');
  assert.ok(parameter);
  const tooHigh = validateContextGraphCandidate(
    candidate([{ target: 'ranking-config', pointer: 'depthDecay', value: (parameter?.max ?? 1) + 1 }])
  );
  assert.equal(tooHigh.rejections[0]?.code, 'value_out_of_bounds');
});

test('a count parameter refuses a fractional value', () => {
  const verdict = validateContextGraphCandidate(
    candidate([{ target: 'profiles', pointer: 'profiles.implementation.maxDepth', value: 2.5 }])
  );
  assert.equal(verdict.kind, 'rejected');
  assert.equal(verdict.rejections[0]?.code, 'value_not_integer');
});

test('an empty candidate, a duplicated pointer and a no-op restatement are all refused', () => {
  assert.equal(validateContextGraphCandidate(candidate([])).rejections[0]?.code, 'empty_candidate');

  const duplicated = validateContextGraphCandidate(
    candidate([
      { target: 'ranking-config', pointer: 'depthDecay', value: 0.5 },
      { target: 'ranking-config', pointer: 'depthDecay', value: 0.55 }
    ])
  );
  assert.equal(duplicated.rejections[0]?.code, 'duplicate_parameter');

  const parameter = resolveContextGraphTunableParameter('ranking-config', 'depthDecay');
  const noop = validateContextGraphCandidate(
    candidate([{ target: 'ranking-config', pointer: 'depthDecay', value: parameter?.baseline ?? 0 }])
  );
  assert.equal(noop.rejections[0]?.code, 'no_op_candidate');
});

test('a candidate may not overrun the per-candidate override budget', () => {
  const verdict = validateContextGraphCandidate(
    candidate([
      { target: 'ranking-config', pointer: 'depthDecay', value: 0.5 },
      { target: 'ranking-config', pointer: 'trustBonus', value: 1 },
      { target: 'ranking-config', pointer: 'stalePenalty', value: 2 },
      { target: 'ranking-config', pointer: 'invalidatedPenalty', value: 3 },
      { target: 'ranking-config', pointer: 'redundancyPenalty', value: 0.5 }
    ]),
    { maxOverrides: 4 }
  );
  assert.equal(verdict.kind, 'rejected');
  assert.ok(verdict.rejections.some((item) => item.code === 'too_many_overrides'));
});

test('a rejection carries codes and pointers, never file contents', () => {
  const verdict = validateContextGraphCandidate(
    candidate([{ target: 'config/context-graph-benchmark.json' as never, pointer: 'depthDecay', value: 0.5 }])
  );
  const serialized = JSON.stringify(verdict);
  assert.ok(!serialized.includes('/Users/'));
  assert.ok(!serialized.includes(process.cwd()));
});
