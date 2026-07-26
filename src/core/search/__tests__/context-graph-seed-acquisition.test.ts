/**
 * Seed acquisition, in isolation.
 *
 * Seeding is the only place the context path is allowed to be lexical, so the
 * property that matters is that each channel's confidence survives: a symbol
 * definition is a definition, a path hit is a path hit, and a substring hit is
 * never promoted above `text_candidate`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acquireContextGraphSeeds, contextGraphFocusPaths } from '../context-graph-seeds.js';
import { buildFixtureIndex, IDS } from '../../triwiki/context-graph/query/__tests__/query-fixtures.js';

describe('context graph seed acquisition', () => {
  it('keeps a symbol definition at exact_definition on the symbol channel', () => {
    const acquired = acquireContextGraphSeeds({ index: buildFixtureIndex(), query: 'runService' });
    const seed = acquired.seeds.find((entry) => entry.nodeId === IDS.symbolRun);
    assert.ok(seed, 'the symbol must be seeded');
    assert.equal(seed.confidence, 'exact_definition');
    assert.equal(seed.channel, 'symbol');
    assert.equal(seed.origin, 'exact');
    assert.equal(seed.path, 'src/app/service.ts');
    assert.ok(acquired.exactSeeds >= 1);
  });

  it('keeps an exact workspace path at file_path on the path channel', () => {
    const acquired = acquireContextGraphSeeds({ index: buildFixtureIndex(), query: 'src/other/a.ts' });
    const seed = acquired.seeds.find((entry) => entry.nodeId === IDS.fileOtherA);
    assert.ok(seed, 'the path must be seeded');
    assert.equal(seed.confidence, 'file_path');
    assert.equal(seed.channel, 'path');
    assert.equal(
      acquired.seeds.some((entry) => entry.confidence === 'exact_definition'),
      false,
      'a path hit must not be promoted to a definition'
    );
  });

  it('resolves a bare basename to a path seed rather than a text candidate', () => {
    const acquired = acquireContextGraphSeeds({ index: buildFixtureIndex(), query: 'consumer.ts' });
    const seed = acquired.seeds.find((entry) => entry.nodeId === IDS.fileConsumer);
    assert.ok(seed);
    assert.equal(seed.confidence, 'file_path');
    assert.notEqual(seed.channel, 'text');
  });

  it('leaves a substring-only hit as a lexical text candidate', () => {
    const acquired = acquireContextGraphSeeds({ index: buildFixtureIndex(), query: 'servic' });
    assert.ok(acquired.seeds.length > 0, 'the sweep must find the service nodes');
    assert.equal(acquired.exactSeeds, 0);
    for (const seed of acquired.seeds) {
      assert.equal(seed.confidence, 'text_candidate');
      assert.equal(seed.origin, 'lexical');
      assert.equal(seed.channel, 'text');
    }
    assert.ok(acquired.scannedKeys > 0, 'the sweep must report the keys it touched');
  });

  it('does not sweep at all when the query has no usable token', () => {
    const acquired = acquireContextGraphSeeds({ index: buildFixtureIndex(), query: '   ' });
    assert.deepEqual(acquired.seeds, []);
    assert.deepEqual([...acquired.tokens], []);
  });

  it('confines seeding to the requested focus paths', () => {
    const acquired = acquireContextGraphSeeds({
      index: buildFixtureIndex(),
      query: 'service.ts',
      focusPaths: ['src/app']
    });
    assert.ok(acquired.seeds.length > 0);
    for (const seed of acquired.seeds) {
      assert.ok(seed.path, 'a focused seed must carry a path');
      assert.ok(seed.path.startsWith('src/app/'), `unexpected focus escape: ${String(seed.path)}`);
    }
  });

  it('drops glob patterns and escaping paths from the focus list', () => {
    assert.deepEqual(contextGraphFocusPaths(['src/app', './src/other/', 'src/**/*.ts', '../outside', '/etc']), [
      'src/app',
      'src/other'
    ]);
    assert.deepEqual(contextGraphFocusPaths(undefined), []);
  });

  it('caps the seed set', () => {
    const acquired = acquireContextGraphSeeds({ index: buildFixtureIndex(), query: 'servic', maxSeeds: 2 });
    assert.equal(acquired.seeds.length, 2);
  });
});
