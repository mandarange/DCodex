import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

/**
 * `context-graph.prev.json` is no longer written, and its name has to stay in the
 * cache-key exclusion set regardless: every workspace built by an older build is
 * still carrying one, and reclaiming it must not look like a workspace change.
 * Dropping the entry as "dead" would move the key on exactly those workspaces.
 */
test('a retired prev snapshot never moves the cache key, present or reclaimed', async (t) => {
  if (!gitAvailable()) {
    t.skip('git is required to prove a reusable cache key');
    return;
  }

  const root = makeFixtureRoot('cg-cache-key-retired-prev');
  try {
    writeFixtureFile(root, 'package.json', '{"name":"fixture","version":"0.0.0"}\n');
    writeFixtureFile(root, 'src/a.ts', 'export const A = 1;\n');
    writeFixtureFile(root, '.sneakoscope/wiki/context-graph.json', '{"generation":0}\n');
    writeFixtureFile(root, '.sneakoscope/wiki/context-graph.meta.json', '{"generation":0}\n');
    writeFixtureFile(root, '.sneakoscope/wiki/context-graph.prev.json', '{"generation":-1}\n');
    initGitRepo(root);

    const before = await computeContextGraphCacheKey({ root, extractors: EXTRACTORS });
    assert.equal(before.reusable, true);

    // A workspace that has not been migrated yet: the duplicate is still there and
    // still being rewritten by whichever build produced it.
    writeFixtureFile(root, '.sneakoscope/wiki/context-graph.prev.json', '{"generation":0}\n');
    const afterRewrite = await computeContextGraphCacheKey({ root, extractors: EXTRACTORS });
    assert.equal(afterRewrite.key, before.key);
    assert.equal(afterRewrite.parts.wikiContextHash, before.parts.wikiContextHash);

    // The migration itself: the commit reclaims the duplicate. Staleness detection
    // must not read that as a changed workspace.
    fs.rmSync(path.join(root, '.sneakoscope', 'wiki', 'context-graph.prev.json'));
    const afterReclaim = await computeContextGraphCacheKey({ root, extractors: EXTRACTORS });
    assert.equal(afterReclaim.key, before.key, 'reclaiming the retired duplicate must not invalidate the index');
    assert.equal(afterReclaim.parts.wikiContextHash, before.parts.wikiContextHash);
    assert.equal(afterReclaim.parts.trackedDirtyFingerprint, before.parts.trackedDirtyFingerprint);
    assert.equal(afterReclaim.reusable, true);
    assert.deepEqual(afterReclaim.dirtyPaths, before.dirtyPaths);

    // The control: a real source change is still detected while all of that is true.
    writeFixtureFile(root, 'src/a.ts', 'export const A = 2;\n');
    const afterSourceChange = await computeContextGraphCacheKey({ root, extractors: EXTRACTORS });
    assert.notEqual(afterSourceChange.key, before.key);
  } finally {
    removeFixtureRoot(root);
  }
});
