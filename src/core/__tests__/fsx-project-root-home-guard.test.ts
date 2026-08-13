import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findProjectRoot, globalSksRoot, projectRoot, sksRoot } from '../fsx.js';

/**
 * `~/.sneakoscope` is the product's own global state directory (menubar
 * assets, update cache, skill quarantine), so it exists on most machines.
 * Root discovery must never read it — or any marker sitting directly in the
 * home directory — as a project marker: home-as-project poisoned entry
 * locality, init-deep, menubar target checks, and Codex `[projects]` trust.
 */
async function withFakeHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  // os.homedir() follows $HOME on POSIX, so redirecting HOME redirects the guard.
  const home = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-fsx-home-guard-')));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await run(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fsp.rm(home, { recursive: true, force: true });
  }
}

test('a marker directly in the home directory never makes home the project root', async () => {
  await withFakeHome(async (home) => {
    await fsp.mkdir(path.join(home, '.sneakoscope'), { recursive: true });
    await fsp.mkdir(path.join(home, '.git'), { recursive: true });
    const markerlessSubdir = path.join(home, 'Desktop', 'notes');
    await fsp.mkdir(markerlessSubdir, { recursive: true });

    assert.equal(await findProjectRoot(home), null, 'home itself must not resolve as a project root');
    assert.equal(await findProjectRoot(markerlessSubdir), null, 'a markerless dir under home must not inherit home as its project root');
  });
});

test('projects nested under home still resolve normally (control for the home guard)', async () => {
  await withFakeHome(async (home) => {
    await fsp.mkdir(path.join(home, '.sneakoscope'), { recursive: true });
    const project = path.join(home, 'devs', 'app');
    await fsp.mkdir(path.join(project, '.sneakoscope'), { recursive: true });
    const nested = path.join(project, 'src', 'deep');
    await fsp.mkdir(nested, { recursive: true });
    const gitRepo = path.join(home, 'devs', 'repo');
    await fsp.mkdir(path.join(gitRepo, '.git'), { recursive: true });

    assert.equal(await findProjectRoot(project), project);
    assert.equal(await findProjectRoot(nested), project, 'the nearest non-home marker wins, even with residue in home above it');
    assert.equal(await findProjectRoot(gitRepo), gitRepo, 'the .git pass applies the same home guard, nothing more');
  });
});

test('home-rooted runs fall back to cwd for projectRoot and to the global root for sksRoot', async () => {
  await withFakeHome(async (home) => {
    await fsp.mkdir(path.join(home, '.sneakoscope'), { recursive: true });

    // The doctor relies on this exact fallback to detect a home-rooted run:
    // no marker semantics, plain cwd.
    assert.equal(await projectRoot(home), home);
    // Runtime state for non-project runs belongs to the global runtime root,
    // not to `~/.sneakoscope`.
    assert.equal(await sksRoot(home), globalSksRoot());
  });
});
