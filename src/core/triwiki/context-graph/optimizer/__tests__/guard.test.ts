import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  contextGraphGuardedPaths,
  contextGraphSurfaceDrift,
  contextGraphSurfaceUnchanged,
  fingerprintContextGraphTuningSurface
} from '../guard.js';
import { seedGuardedSurface, tempRoot } from './harness.js';

test('the guard watches both tuning files and the benchmark corpus', () => {
  const root = tempRoot();
  try {
    seedGuardedSurface(root);
    const guarded = contextGraphGuardedPaths(root);
    assert.ok(guarded.includes('src/core/triwiki/context-graph/query/ranking-config.ts'));
    assert.ok(guarded.includes('src/core/triwiki/context-graph/profiles.ts'));
    assert.ok(guarded.includes('config/context-graph-benchmark.json'));
    assert.deepEqual([...guarded], [...guarded].sort(), 'the guarded list is deterministic');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unchanged surface fingerprints identically twice', () => {
  const root = tempRoot();
  try {
    seedGuardedSurface(root);
    const first = fingerprintContextGraphTuningSurface(root);
    const second = fingerprintContextGraphTuningSurface(root);
    assert.equal(first.digest, second.digest);
    assert.deepEqual(contextGraphSurfaceDrift(first, second), []);
    assert.equal(contextGraphSurfaceUnchanged(first, second), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a mutated, deleted or added guarded file is named in the drift', () => {
  const root = tempRoot();
  try {
    seedGuardedSurface(root);
    const before = fingerprintContextGraphTuningSurface(root);

    const profiles = path.join(root, 'src', 'core', 'triwiki', 'context-graph', 'profiles.ts');
    fs.writeFileSync(profiles, '// tampered\n', 'utf8');
    const mutated = contextGraphSurfaceDrift(before, fingerprintContextGraphTuningSurface(root));
    assert.deepEqual(mutated, ['src/core/triwiki/context-graph/profiles.ts:mutated']);

    fs.rmSync(profiles);
    const deleted = contextGraphSurfaceDrift(before, fingerprintContextGraphTuningSurface(root));
    assert.deepEqual(deleted, ['src/core/triwiki/context-graph/profiles.ts:deleted']);

    fs.writeFileSync(profiles, '// seeded src/core/triwiki/context-graph/profiles.ts\n', 'utf8');
    const restored = contextGraphSurfaceDrift(before, fingerprintContextGraphTuningSurface(root));
    assert.deepEqual(restored, [], 'restoring the exact bytes clears the drift');

    fs.writeFileSync(
      path.join(root, 'src', 'core', 'triwiki', 'context-graph', 'benchmark-extra.json'),
      '{}\n',
      'utf8'
    );
    assert.deepEqual(
      contextGraphSurfaceDrift(before, fingerprintContextGraphTuningSurface(root)),
      [],
      'a file outside the guarded set is not drift'
    );

    const benchmarkDir = path.join(root, 'src', 'core', 'triwiki', 'context-graph', 'benchmark');
    fs.mkdirSync(benchmarkDir, { recursive: true });
    fs.writeFileSync(path.join(benchmarkDir, 'score.ts'), '// injected scorer\n', 'utf8');
    assert.deepEqual(contextGraphSurfaceDrift(before, fingerprintContextGraphTuningSurface(root)), [
      'src/core/triwiki/context-graph/benchmark/score.ts:added'
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the fingerprint records hashes and workspace-relative paths only', () => {
  const root = tempRoot();
  try {
    seedGuardedSurface(root);
    const fingerprint = fingerprintContextGraphTuningSurface(root);
    const serialized = JSON.stringify(fingerprint);
    assert.ok(!serialized.includes(root), 'the absolute root must never appear');
    assert.match(fingerprint.digest, /^[0-9a-f]{64}$/);
    for (const file of fingerprint.files) {
      assert.ok(!file.path.startsWith('/'));
      assert.ok(!file.path.includes('..'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
