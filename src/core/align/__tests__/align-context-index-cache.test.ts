/**
 * Align's one seam with the query engine, exercised end to end.
 *
 * Align renames a staged directory over `.sneakoscope/wiki`, which replaces the
 * graph under any reader that already parsed it. The in-process index cache is
 * keyed by snapshot hash, so a stale entry does not merely waste memory — it lets
 * a query in the same process answer from the generation align just deleted.
 *
 * Align therefore invalidates that cache through the query facade rather than by
 * reaching into the cache module, so that when the facade is cut over to the CRK2
 * kernel this call site follows without being edited. That is exactly the kind of
 * wiring an import-path change can silently sever, so it is asserted against a
 * real align run rather than a mock.
 *
 * The workspace is an `fsp.mkdtemp` directory under `os.tmpdir()`, removed in
 * `finally`.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearContextGraphSnapshotCache,
  contextGraphSnapshotCacheStats,
  getCachedContextGraphIndex,
  loadContextGraphIndex
} from '../../triwiki/context-graph/query/index.js';
import { writeAlignRouteArtifacts } from '../align-route.js';
import { executeCodeNavigationAlign } from '../code-navigation-align.js';

async function write(root: string, relative: string, contents: string): Promise<void> {
  const file = path.join(root, relative);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents);
}

async function fixtureRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-align-index-cache-'));
  await write(root, 'package.json', JSON.stringify({ name: 'align-cache-fixture', version: '1.0.0', type: 'module' }));
  await write(
    root,
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022' }, include: ['src/**/*.ts'] })
  );
  await write(root, 'src/main.ts', '/** Main runtime entry. */\nexport function runTask(value: number) { return value + 1; }\n');
  await fsp.mkdir(path.join(root, 'config'), { recursive: true });
  await fsp.copyFile(
    path.join(process.cwd(), 'config/architecture-map-policy.v1.json'),
    path.join(root, 'config/architecture-map-policy.v1.json')
  );
  return root;
}

async function align(root: string, missionId: string): Promise<void> {
  const dir = path.join(root, '.sneakoscope/missions', missionId);
  await fsp.mkdir(dir, { recursive: true });
  await writeAlignRouteArtifacts(dir, missionId, 'index all current code');
  const result = await executeCodeNavigationAlign({ root, missionDir: dir, missionId });
  assert.equal(result.ok, true, result.gate.blockers.join('\n'));
}

test('align invalidates the facade index cache it just made stale', async () => {
  const root = await fixtureRoot();
  try {
    await align(root, 'M-align-cache-first');

    clearContextGraphSnapshotCache();
    const load = await loadContextGraphIndex(root);
    assert.equal(load.ok, true, load.errors.join('\n'));
    assert.notEqual(load.snapshotHash, '');
    assert.equal(contextGraphSnapshotCacheStats().entries, 1);
    assert.notEqual(getCachedContextGraphIndex(root, load.snapshotHash), null);

    await align(root, 'M-align-cache-second');

    // Not "the entry for the old hash is gone" but "nothing is resident": align
    // replaced the whole wiki directory, so every generation cached from it is
    // now describing a directory that no longer exists.
    assert.equal(contextGraphSnapshotCacheStats().entries, 0);
    assert.equal(getCachedContextGraphIndex(root, load.snapshotHash), null);

    // And the facade can still resolve the workspace afterwards: invalidation
    // must not leave the cache in a state the next query cannot recover from.
    const reloaded = await loadContextGraphIndex(root);
    assert.equal(reloaded.ok, true, reloaded.errors.join('\n'));
    assert.equal(reloaded.cacheHit, false);
  } finally {
    clearContextGraphSnapshotCache();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
