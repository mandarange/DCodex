import assert from 'node:assert/strict';
import test from 'node:test';
import { queryContextGraphSnapshot } from '../index.js';
import { buildFixtureIndex, IDS } from './query-fixtures.js';

const index = buildFixtureIndex();

function selectedIds(result: { selected: readonly { nodeId: string }[] }): string[] {
  return result.selected.map((node) => node.nodeId);
}

test('an exact symbol hit stays an exact definition seed end to end', () => {
  const result = queryContextGraphSnapshot(index, { root: '.', query: 'runService' });
  assert.equal(result.ok, true);
  const seed = result.seeds.find((entry) => entry.nodeId === IDS.symbolRun);
  assert.ok(seed, 'the symbol is seeded');
  assert.equal(seed.confidence, 'exact_definition');
  assert.equal(seed.origin, 'exact');
  const selected = result.selected.find((node) => node.nodeId === IDS.symbolRun);
  assert.ok(selected, 'the symbol survives packing');
  assert.equal(selected.seedConfidence, 'exact_definition');
  assert.equal(selected.seed, true);
  assert.equal(result.processSpawns, 0);
});

test('a path-only query seeds by path and never as a text candidate', () => {
  const result = queryContextGraphSnapshot(index, { root: '.', query: 'src/app/service.ts' });
  assert.ok(result.seeds.length >= 1);
  for (const seed of result.seeds) {
    assert.equal(seed.confidence, 'file_path');
    assert.equal(seed.origin, 'exact');
  }
  assert.ok(result.seeds.some((seed) => seed.nodeId === IDS.fileService));
});

test('a lexical fallback seed is never promoted above a text candidate', () => {
  const result = queryContextGraphSnapshot(index, { root: '.', query: 'servic' });
  assert.ok(result.seeds.length > 0, 'the bounded sweep found something');
  for (const seed of result.seeds) {
    assert.equal(seed.confidence, 'text_candidate');
    assert.equal(seed.origin, 'lexical');
  }
});

test('a caller-supplied seed keeps its own confidence', () => {
  const result = queryContextGraphSnapshot(index, {
    root: '.',
    query: 'no-token-matches-this-query',
    profile: 'review',
    seeds: [{ nodeId: IDS.gateRelease, confidence: 'manifest', origin: 'provided' }]
  });
  const seed = result.seeds.find((entry) => entry.nodeId === IDS.gateRelease);
  assert.ok(seed);
  assert.equal(seed.confidence, 'manifest');
  assert.equal(seed.origin, 'provided');
});

test('a caller-supplied seed that is not in the snapshot is reported, not invented', () => {
  const result = queryContextGraphSnapshot(index, {
    root: '.',
    query: 'runService',
    seeds: [{ nodeId: 'file:src/does/not/exist.ts', confidence: 'exact_definition', origin: 'provided' }]
  });
  assert.ok(result.seeds.every((seed) => seed.nodeId !== 'file:src/does/not/exist.ts'));
  assert.ok(result.warnings.some((warning) => warning.includes('not present in this snapshot')));
});

test('reverse dependencies are reachable, which is the point of the reverse hop', () => {
  const result = queryContextGraphSnapshot(index, { root: '.', query: 'runService' });
  const ids = selectedIds(result);
  assert.ok(ids.includes(IDS.fileConsumer), 'the importer of the seeded file is reachable');
  assert.ok(ids.includes(IDS.testService), 'the test that binds the seeded file is reachable');
  const consumer = result.selected.find((node) => node.nodeId === IDS.fileConsumer);
  assert.ok(consumer);
  assert.ok(consumer.reasonPath.includes('imports:reverse'), 'a reverse hop is labelled as one');
});

test('a stale node is excluded, counted and explained', () => {
  const result = queryContextGraphSnapshot(index, { root: '.', query: 'runService' });
  assert.ok(!selectedIds(result).includes(IDS.fileLegacy));
  assert.equal(result.staleExcluded, 1);
  assert.equal(result.omissionReasons.stale_node, 1);
});

test('an invalidated proof is excluded, counted and explained', () => {
  const result = queryContextGraphSnapshot(index, { root: '.', query: 'runService' });
  assert.ok(!selectedIds(result).includes(IDS.proofInvalid));
  assert.equal(result.invalidatedExcluded, 1);
  assert.equal(result.omissionReasons.invalidated_proof, 1);
});

test('every explanation edge exists in the snapshot', () => {
  const result = queryContextGraphSnapshot(index, { root: '.', query: 'runService' });
  assert.ok(result.selected.length > 0);
  let steps = 0;
  for (const node of result.selected) {
    for (const step of node.explanation) {
      steps += 1;
      const edge = index.edgesById.get(step.edgeId);
      assert.ok(edge, `explanation edge ${step.edgeId} exists`);
      assert.equal(edge.type, step.type);
      assert.equal(edge.from, step.from);
      assert.equal(edge.to, step.to);
      assert.equal(edge.provenance.path, step.path);
    }
    assert.ok(node.reasonPath.length > 0, 'every selected node carries a reason path');
  }
  assert.ok(steps > 0, 'the walk produced real hop chains');
  assert.equal(result.explanationPathCount, result.selected.filter((node) => node.explanation.length > 0).length);
});

test('provenance coverage is 1.00 and every record is workspace relative', () => {
  const result = queryContextGraphSnapshot(index, { root: '.', query: 'runService' });
  assert.equal(result.provenanceCoverage, 1);
  for (const node of result.selected) {
    assert.ok(node.provenance.length > 0, `${node.nodeId} is grounded`);
    for (const ref of node.provenance) {
      assert.ok(ref.path.length > 0);
      assert.ok(!ref.path.startsWith('/'), 'no absolute path');
      assert.ok(!ref.path.startsWith('~'), 'no home path');
      assert.ok(!ref.path.includes('..'), 'no escaping path');
      assert.ok(ref.hash.length > 0);
    }
  }
});

test('ordering and selection are identical across three runs', () => {
  const runs = [0, 1, 2].map(() => {
    const result = queryContextGraphSnapshot(index, { root: '.', query: 'runService', profile: 'implementation' });
    return JSON.stringify({ ...result, durationMs: 0 });
  });
  assert.equal(runs[0], runs[1]);
  assert.equal(runs[1], runs[2]);
});

test('focus paths restrict the answer and the exclusion is reported', () => {
  const result = queryContextGraphSnapshot(index, {
    root: '.',
    query: 'runService',
    focusPaths: ['src/other']
  });
  const ids = selectedIds(result);
  assert.ok(ids.includes(IDS.fileOtherA));
  assert.ok(ids.includes(IDS.fileOtherB));
  assert.ok(!ids.includes(IDS.fileService), 'a node outside the focus is not selected');
  assert.ok(result.warnings.some((warning) => warning.includes('outside the requested focus paths')));
});

test('a query that matches nothing says so instead of guessing', () => {
  const result = queryContextGraphSnapshot(index, { root: '.', query: 'zzz-no-such-token-zzz' });
  assert.equal(result.ok, true);
  assert.equal(result.seedCount, 0);
  assert.equal(result.selectedNodes, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('no text fallback')));
});

test('a high risk query deepens the walk instead of widening the profile', () => {
  const normal = queryContextGraphSnapshot(index, { root: '.', query: 'runService', profile: 'review' });
  const high = queryContextGraphSnapshot(index, { root: '.', query: 'runService', profile: 'review', risk: 'high' });
  assert.ok(high.visitedNodes >= normal.visitedNodes);
  assert.equal(high.processSpawns, 0);
});
