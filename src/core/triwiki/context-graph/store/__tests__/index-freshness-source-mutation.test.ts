import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../../../../fsx.js';
import {
  CONTEXT_GRAPH_META_SCHEMA,
  CONTEXT_GRAPH_SCHEMA_REVISION,
  CONTEXT_GRAPH_STALE_ERROR,
  type ContextGraphMeta
} from '../../contracts.js';
import { computeContextGraphCacheKey } from '../../compiler/cache-key.js';
import { CONTEXT_INDEX_FORMAT_REVISION } from '../../runtime-index/format.js';
import { contextGraphMetaPath, contextGraphSnapshotPath } from '../../paths.js';
import { contextIndexFreshness } from '../index-freshness.js';
import { contextIndexPointerPath, contextIndexStoreDir } from '../generation-layout.js';
import { CONTEXT_INDEX_POINTER_SCHEMA } from '../generation-pointer.js';
import {
  FIXED_OBSERVED_AT,
  commitFixtureChanges,
  gitAvailable,
  initGitRepo,
  makeFixtureRoot,
  removeFixtureRoot,
  writeFixtureFile
} from '../../compiler/__tests__/graph-test-fixtures.js';

/**
 * The regression the release record refused to ship, tested directly.
 *
 * The record's objection to a v2 preflight was specific: replacing the JSON
 * parse with **pointer/meta integrity alone** would let a workspace whose
 * sources changed answer from a stale index with no error. So the property
 * under test is not "the preflight runs" — it is "a source mutation still
 * produces `stale`, with the snapshot never read".
 *
 * `index-freshness.test.ts` already compares the two paths, but it hands every
 * case a **hand-built cache key** and leans on `verifySources: true`. That
 * pins the git-derived half as a constant, which is the right call for an
 * equivalence test and the wrong one here: it is precisely the half that has to
 * do the detecting, and **no production caller uses that shape**.
 * `search/context.ts` passes `verifySources: false`, so the recorded-input
 * re-hash is off and the cache key is the *only* thing standing between a
 * mutated workspace and a confident answer. That is the configuration proven
 * below — a real git repository, a real computed key, source verification off.
 *
 * The snapshot is never written. Where a doubt could remain that the verdict
 * secretly came from it, a deliberately corrupt one is planted instead: the
 * JSON path reports `corrupt` for that file, so a preflight still reading it
 * could not report `fresh`.
 */

const SOURCE_A = 'src/a.ts';
const SOURCE_B = 'src/b.ts';

interface Fixture {
  readonly root: string;
  readonly hashes: Record<string, string>;
}

function seedWorkspace(prefix: string): Fixture {
  const root = makeFixtureRoot(prefix);
  const hashes: Record<string, string> = {
    [SOURCE_A]: writeFixtureFile(root, SOURCE_A, 'export const A = 1;\n'),
    [SOURCE_B]: writeFixtureFile(root, SOURCE_B, 'export const B = 2;\n')
  };
  writeFixtureFile(root, 'package.json', JSON.stringify({ name: 'fixture' }) + '\n');
  writeFixtureFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: {} }) + '\n');
  initGitRepo(root);
  return { root, hashes };
}

/**
 * The published generation the meta describes. Every case here is about source
 * freshness, so the pointer is part of the fixture rather than part of any
 * assertion: without it the verdict is `missing` before a cache key is compared
 * at all, and none of these tests would be exercising what they name.
 */
function publishPointer(root: string, snapshotHash: string): void {
  fs.mkdirSync(contextIndexStoreDir(root), { recursive: true });
  fs.writeFileSync(contextIndexPointerPath(root), JSON.stringify({
    schema: CONTEXT_INDEX_POINTER_SCHEMA,
    formatRevision: CONTEXT_INDEX_FORMAT_REVISION,
    snapshotHash,
    configFingerprint: 'c'.repeat(64),
    sourceFingerprint: 'd'.repeat(64),
    generationPath: `.sneakoscope/wiki/context-graph/generations/${snapshotHash}.idx`,
    previousSnapshotHash: null,
    indexBytes: 1024,
    indexChecksum: 'e'.repeat(64),
    committedAt: FIXED_OBSERVED_AT
  }), 'utf8');
}

/**
 * Record the meta for the workspace exactly as it stands, using the cache key
 * the compiler would have recorded. Writing the meta directly — rather than
 * through `writeContextGraphSnapshot` — is the point: no `context-graph.json`
 * ever exists, so nothing in the verdict can have come from one.
 */
async function recordMeta(fixture: Fixture): Promise<ContextGraphMeta> {
  const snapshotHash = sha256('fixture-snapshot');
  // Published before the key is computed, not after: the generation store lives
  // under `.sneakoscope/wiki`, which `wikiContextHash` fingerprints, so a key
  // taken before publication would describe a workspace that no longer exists
  // and every case here would read `stale` for a reason none of them is about.
  publishPointer(fixture.root, snapshotHash);
  const key = await computeContextGraphCacheKey({ root: fixture.root, extractors: [] });
  assert.equal(key.reusable, true, 'the fixture repository must have a readable git state');
  const meta: ContextGraphMeta = {
    schema: CONTEXT_GRAPH_META_SCHEMA,
    schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION,
    snapshotHash,
    previousSnapshotHash: null,
    generatedAt: FIXED_OBSERVED_AT,
    cacheKey: key.key,
    cacheKeyParts: key.parts,
    inputHashes: fixture.hashes,
    nodeCount: 2,
    edgeCount: 1,
    lint: { ok: true, errors: 0, warnings: 0 },
    skipped: [],
    durationMs: 1
  };
  const file = contextGraphMetaPath(fixture.root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(meta), 'utf8');
  return meta;
}

/** The production shape: extractor list supplied, recorded-input re-hash OFF. */
function preflight(root: string) {
  return contextIndexFreshness(root, { extractors: [], verifySources: false });
}

function assertNoSnapshot(root: string): void {
  assert.equal(
    fs.existsSync(contextGraphSnapshotPath(root)),
    false,
    'the whole point is that no context-graph.json is involved'
  );
}

test('a mutated source file is stale even with the recorded-input re-hash disabled', async (t) => {
  if (!gitAvailable()) return t.skip('git is required to compute a real cache key');
  const fixture = seedWorkspace('cgf-mutation');
  try {
    await recordMeta(fixture);
    assertNoSnapshot(fixture.root);

    const clean = await preflight(fixture.root);
    assert.equal(clean.status, 'fresh', 'an untouched workspace is fresh');
    assert.deepEqual(clean.reasons, []);

    // The mutation the record was worried about: one source file's bytes move
    // underneath an index that was built before them.
    writeFixtureFile(fixture.root, SOURCE_A, 'export const A = 999;\n');

    const mutated = await preflight(fixture.root);
    assert.equal(mutated.status, 'stale', 'a workspace whose sources changed must not answer as fresh');
    assert.equal(mutated.errorCode, CONTEXT_GRAPH_STALE_ERROR, 'staleness is an error the caller can see');
    assert.ok(
      mutated.reasons.includes('dirty_fingerprint_changed'),
      `the reason must name the changed bytes, got: ${mutated.reasons.join(', ')}`
    );
    assertNoSnapshot(fixture.root);

    // Restoring the exact bytes restores the verdict. Without this the test
    // would also pass against a preflight that latched to stale forever.
    writeFixtureFile(fixture.root, SOURCE_A, 'export const A = 1;\n');
    assert.equal((await preflight(fixture.root)).status, 'fresh', 'the verdict tracks content, not history');
  } finally {
    removeFixtureRoot(fixture.root);
  }
});

test('a corrupt snapshot on disk cannot change the verdict, because it is not read', async (t) => {
  if (!gitAvailable()) return t.skip('git is required to compute a real cache key');
  const fixture = seedWorkspace('cgf-corrupt-snapshot');
  try {
    await recordMeta(fixture);

    // The JSON path reports `corrupt` for this file. A preflight that still
    // parsed it therefore could not answer `fresh`, so the assertion below is
    // evidence about the reader rather than about the fixture.
    fs.writeFileSync(contextGraphSnapshotPath(fixture.root), 'this is not JSON at all', 'utf8');

    const status = await preflight(fixture.root);
    assert.equal(status.status, 'fresh', 'the snapshot is not an input to the v2 verdict');

    // And it still detects a mutation with that corrupt file sitting there.
    writeFixtureFile(fixture.root, SOURCE_B, 'export const B = 3;\n');
    assert.equal((await preflight(fixture.root)).status, 'stale');
  } finally {
    removeFixtureRoot(fixture.root);
  }
});

test('a deleted source file is stale; a new untracked one is stale', async (t) => {
  if (!gitAvailable()) return t.skip('git is required to compute a real cache key');
  const fixture = seedWorkspace('cgf-inventory');
  try {
    await recordMeta(fixture);

    fs.rmSync(path.join(fixture.root, SOURCE_B));
    const deleted = await preflight(fixture.root);
    assert.equal(deleted.status, 'stale', 'a deleted source must not be invisible');
    assert.ok(deleted.reasons.includes('dirty_fingerprint_changed'));

    // Put it back and commit, so the next case starts from a clean tree.
    writeFixtureFile(fixture.root, SOURCE_B, 'export const B = 2;\n');
    commitFixtureChanges(fixture.root, 'restore');
    const restoredMeta = await recordMeta(fixture);
    assert.ok(restoredMeta.cacheKeyParts.head, 'the fixture is a real repository with a HEAD');
    assert.equal((await preflight(fixture.root)).status, 'fresh');

    writeFixtureFile(fixture.root, 'src/c.ts', 'export const C = 3;\n');
    const added = await preflight(fixture.root);
    assert.equal(added.status, 'stale', 'a new untracked source must not be invisible');
    assert.ok(added.reasons.includes('dirty_fingerprint_changed'));
    assertNoSnapshot(fixture.root);
  } finally {
    removeFixtureRoot(fixture.root);
  }
});

test('an mtime bump with identical bytes stays fresh — the check is content, not timestamps', async (t) => {
  if (!gitAvailable()) return t.skip('git is required to compute a real cache key');
  const fixture = seedWorkspace('cgf-mtime');
  try {
    await recordMeta(fixture);
    assert.equal((await preflight(fixture.root)).status, 'fresh');

    const absolute = path.join(fixture.root, SOURCE_A);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(absolute, later, later);

    // Recorded as a deliberate non-coverage rather than a gap: a rebuild
    // triggered by `touch` would be a false positive, and the fingerprint is a
    // sha256 of the bytes precisely so it cannot be moved by a clock.
    const touched = await preflight(fixture.root);
    assert.equal(touched.status, 'fresh', 'a timestamp is not a source change');
    assert.deepEqual(touched.reasons, []);
  } finally {
    removeFixtureRoot(fixture.root);
  }
});

test('a workspace that is not a git repository fails closed rather than answering fresh', async (t) => {
  if (!gitAvailable()) return t.skip('git is required for the negative control');
  const fixture = seedWorkspace('cgf-no-git');
  try {
    await recordMeta(fixture);
    assert.equal((await preflight(fixture.root)).status, 'fresh');

    // With git gone the tracked/untracked fingerprints are unknowable. The
    // preflight has no way to prove the sources did not move, and ADR §1
    // forbids resolving that by assuming they did not.
    fs.rmSync(path.join(fixture.root, '.git'), { recursive: true, force: true });

    const blind = await preflight(fixture.root);
    assert.notEqual(blind.status, 'fresh', 'an unverifiable working tree is never fresh');
    assert.ok(blind.reasons.includes('git_state_unknown'));
    assert.equal(blind.errorCode, CONTEXT_GRAPH_STALE_ERROR);
    assert.ok(
      !JSON.stringify(blind).includes(path.resolve(fixture.root)),
      'a status must never carry an absolute path'
    );
  } finally {
    removeFixtureRoot(fixture.root);
  }
});
