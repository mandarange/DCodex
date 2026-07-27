import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeContextGraphCacheKey,
  type ExtractorIdentity
} from '../cache-key.js';
import {
  gitAvailable,
  initGitRepo,
  makeFixtureRoot,
  removeFixtureRoot,
  writeFixtureFile
} from './graph-test-fixtures.js';

const EXTRACTORS: readonly ExtractorIdentity[] = [{ id: 'fixture', revision: '1.0.0' }];

test('generated code-pack files do not invalidate the context graph cache key', async (t) => {
  if (!gitAvailable()) {
    t.skip('git is required to prove a reusable cache key');
    return;
  }

  const root = makeFixtureRoot('cg-cache-key-generated');
  try {
    writeFixtureFile(root, 'package.json', '{"name":"fixture","version":"0.0.0"}\n');
    writeFixtureFile(root, 'src/a.ts', 'export const A = 1;\n');
    writeFixtureFile(root, '.sneakoscope/wiki/code-pack.json', '{"generation":0}\n');
    writeFixtureFile(root, '.sneakoscope/wiki/code-pack.prev.json', '{"generation":-1}\n');
    writeFixtureFile(root, '.sneakoscope/memory/q2_facts/current.md', 'current fact\n');
    initGitRepo(root);

    const before = await computeContextGraphCacheKey({ root, extractors: EXTRACTORS });
    assert.equal(before.reusable, true);

    writeFixtureFile(root, '.sneakoscope/wiki/code-pack.json', '{"generation":1}\n');
    writeFixtureFile(root, '.sneakoscope/wiki/code-pack.prev.json', '{"generation":0}\n');
    const afterCreate = await computeContextGraphCacheKey({ root, extractors: EXTRACTORS });

    writeFixtureFile(root, '.sneakoscope/wiki/code-pack.json', '{"generation":2}\n');
    writeFixtureFile(root, '.sneakoscope/wiki/code-pack.prev.json', '{"generation":1}\n');
    const afterRewrite = await computeContextGraphCacheKey({ root, extractors: EXTRACTORS });

    assert.equal(afterCreate.key, before.key);
    assert.equal(afterRewrite.key, before.key);
    assert.equal(afterCreate.parts.wikiContextHash, before.parts.wikiContextHash);
    assert.equal(afterRewrite.parts.wikiContextHash, before.parts.wikiContextHash);

    writeFixtureFile(root, '.sneakoscope/memory/q2_facts/current.md', 'changed fact\n');
    const afterTrackedMemoryChange = await computeContextGraphCacheKey({ root, extractors: EXTRACTORS });
    assert.notEqual(afterTrackedMemoryChange.key, before.key);
    assert.notEqual(afterTrackedMemoryChange.parts.trackedDirtyFingerprint, before.parts.trackedDirtyFingerprint);
  } finally {
    removeFixtureRoot(root);
  }
});
