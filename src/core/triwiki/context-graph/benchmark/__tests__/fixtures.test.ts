import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  contextGraphBenchmarkFixtureFamilies,
  fixtureDefinition,
  gitAvailable,
  materializeFixture,
  missingFixtureDefinitions,
  withFixture
} from '../fixtures/index.js';
import { FIXTURE_ABSOLUTE_PATH, FIXTURE_SECRET_TOKEN } from '../fixtures/definitions-safety.js';
import { scanForLeaks } from '../floors.js';
import { isSymlinkEscape, isWorkspaceRelativePosixPath } from '../../paths.js';

test('every declared fixture family has a definition with workspace-relative paths', () => {
  assert.deepEqual(missingFixtureDefinitions(), []);
  for (const family of contextGraphBenchmarkFixtureFamilies()) {
    const definition = fixtureDefinition(family);
    assert.ok(definition.files.length > 0, `${family} must declare files`);
    for (const file of definition.files) {
      assert.ok(isWorkspaceRelativePosixPath(file.path), `${family}:${file.path} must be workspace-relative POSIX`);
    }
  }
});

test('a fixture materializes into a temp dir and is fully cleaned up again', () => {
  const handle = materializeFixture('command-route-pipeline-gate');
  const root = handle.root;
  try {
    assert.ok(fs.existsSync(root));
    assert.ok(root.startsWith(os.tmpdir()), 'a fixture only ever lives under the system temp dir');
    assert.equal(handle.fileCount, fixtureDefinition('command-route-pipeline-gate').files.length);
    assert.ok(fs.existsSync(path.join(root, 'src', 'cli', 'commands', 'search.ts')));
    assert.ok(fs.existsSync(path.join(root, 'config', 'gates.json')));
  } finally {
    handle.dispose();
  }
  assert.equal(fs.existsSync(root), false, 'dispose must remove the whole fixture');
  handle.dispose();
});

test('withFixture cleans up even when the body throws', async () => {
  let captured = '';
  await assert.rejects(
    withFixture('reexport-chain', (handle) => {
      captured = handle.root;
      throw new Error('boom');
    }),
    /boom/
  );
  assert.ok(captured);
  assert.equal(fs.existsSync(captured), false);
});

test('the redaction fixture carries a canary that the leak scanner catches', async () => {
  await withFixture('secret-and-path-redaction', (handle) => {
    const notes = fs.readFileSync(path.join(handle.root, 'notes', 'leaky-notes.md'), 'utf8');
    assert.ok(notes.includes(FIXTURE_SECRET_TOKEN));
    assert.ok(notes.includes(FIXTURE_ABSOLUTE_PATH));
    const scan = scanForLeaks(notes);
    assert.ok(scan.secretRules.includes('fixture_secret_canary'));
    assert.ok(scan.pathRules.includes('fixture_absolute_path_canary'));
  });
});

test('the symlink fixture creates a link that resolves outside the workspace', async () => {
  await withFixture('symlink-escape', (handle) => {
    if (!handle.symlinkSupported) return;
    assert.equal(handle.symlinksCreated, 1);
    assert.equal(isSymlinkEscape(handle.root, 'src/core/outside-link'), true);
  });
});

test('the malformed manifest fixture really is unparseable', async () => {
  await withFixture('malformed-manifest', (handle) => {
    const text = fs.readFileSync(path.join(handle.root, 'config', 'gates.json'), 'utf8');
    assert.throws(() => JSON.parse(text));
  });
});

test('the large repository fixture generates enough modules to expose an unbounded scan', async () => {
  await withFixture('large-repo-incremental', (handle) => {
    assert.ok(handle.fileCount > 400, `expected a large tree, got ${handle.fileCount} files`);
    assert.ok(fs.existsSync(path.join(handle.root, 'src', 'gen', 'mod-0', 'index.ts')));
    assert.ok(fs.existsSync(path.join(handle.root, 'src', 'gen', 'mod-399', 'index.ts')));
  });
});

test('the stale wiki claim fixture disagrees with the source it cites', async () => {
  await withFixture('stale-wiki-claim', (handle) => {
    const source = fs.readFileSync(path.join(handle.root, 'src', 'core', 'config', 'limits.ts'), 'utf8');
    const claim = fs.readFileSync(path.join(handle.root, '.sneakoscope', 'wiki', 'claims', 'max-parallel.md'), 'utf8');
    assert.ok(source.includes('MAX_PARALLEL = 8'));
    assert.ok(claim.includes('MAX_PARALLEL is 4'));
  });
});

test('the git fixture keeps its dirty and untracked files out of the commit', { skip: !gitAvailable() }, async () => {
  await withFixture('dirty-and-untracked', (handle) => {
    assert.equal(handle.gitInitialized, true);
    assert.deepEqual([...handle.dirtyPaths], ['src/core/a.ts']);
    assert.deepEqual([...handle.untrackedPaths], ['src/core/c.ts']);
    assert.ok(fs.existsSync(path.join(handle.root, '.git')));
    assert.ok(fs.readFileSync(path.join(handle.root, 'src', 'core', 'a.ts'), 'utf8').includes('uncommitted local edit'));
    assert.ok(fs.existsSync(path.join(handle.root, 'src', 'core', 'c.ts')));
  });
});
