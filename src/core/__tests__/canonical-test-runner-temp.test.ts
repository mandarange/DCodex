import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { managedSksTmpRoot } from '../fsx.js';

const repoRoot = process.cwd();
const runner = path.join(repoRoot, 'dist', 'scripts', 'canonical-test-runner.js');

test('canonical test runner isolates direct os.tmpdir allocations and removes the run root on close', async () => {
  const fixture = await fixtureRoot('sks-canonical-runner-close-');
  try {
    await writeFixtureTests(fixture, `
      const fs = require('node:fs');
      const path = require('node:path');
      const test = require('node:test');
      test('records canonical temp environment', () => {
        const lease = JSON.parse(fs.readFileSync(path.join(process.env.SKS_TMP_DIR, '.sks-temp-lease.json'), 'utf8'));
        const values = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, SKS_TMP_DIR: process.env.SKS_TMP_DIR, lease };
        fs.writeFileSync(path.join(process.cwd(), 'observed.json'), JSON.stringify(values));
      });
    `);
    const run = spawnSync(process.execPath, [runner], {
      cwd: fixture,
      env: standaloneTestEnv(),
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const observed = JSON.parse(await fsp.readFile(path.join(fixture, 'observed.json'), 'utf8'));
    assert.equal(observed.TMPDIR, observed.TMP);
    assert.equal(observed.TMPDIR, observed.TEMP);
    assert.equal(observed.TMPDIR, observed.SKS_TMP_DIR);
    assert.equal(observed.lease.schema, 'sks.temp-lease.v1');
    assert.equal(observed.lease.kind, 'canonical-test-runner');
    assert.ok(Number(observed.lease.pid) > 0);
    assert.ok(String(observed.TMPDIR).startsWith(`${managedSksTmpRoot()}${path.sep}sks-canonical-test-`));
    assert.equal(fs.existsSync(observed.TMPDIR), false);
    const proof = JSON.parse(await fsp.readFile(path.join(fixture, '.sneakoscope', 'reports', 'canonical-test-proof.json'), 'utf8'));
    assert.equal(proof.schema, 'sks.canonical-test-proof.v1');
    assert.equal(proof.ok, true);
    assert.equal(proof.total_tests, 2);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('canonical test runner removes the run root after a forwarded termination signal', async () => {
  const fixture = await fixtureRoot('sks-canonical-runner-signal-');
  let child: ReturnType<typeof spawn> | null = null;
  try {
    await writeFixtureTests(fixture, `
      const fs = require('node:fs');
      const path = require('node:path');
      const test = require('node:test');
      test('waits for forwarded termination', async () => {
        fs.writeFileSync(path.join(process.cwd(), 'observed.json'), JSON.stringify({ TMPDIR: process.env.TMPDIR }));
        await new Promise(() => {});
      });
    `);
    await fsp.mkdir(path.join(fixture, '.sneakoscope', 'reports'), { recursive: true });
    await fsp.writeFile(path.join(fixture, '.sneakoscope', 'reports', 'canonical-test-proof.json'), '{"stale":true}\n');
    child = spawn(process.execPath, [runner], { cwd: fixture, env: standaloneTestEnv(), stdio: 'ignore' });
    await waitForFile(path.join(fixture, 'observed.json'));
    const observed = JSON.parse(await fsp.readFile(path.join(fixture, 'observed.json'), 'utf8'));
    child.kill('SIGTERM');
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('canonical runner did not terminate after SIGTERM')), 5_000);
      child!.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    child = null;
    assert.ok(closed.signal === 'SIGTERM' || closed.code === 143, JSON.stringify(closed));
    assert.equal(fs.existsSync(observed.TMPDIR), false);
    assert.equal(fs.existsSync(path.join(fixture, '.sneakoscope', 'reports', 'canonical-test-proof.json')), false);
  } finally {
    child?.kill('SIGKILL');
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('canonical test runner rejects successful tests when release state drifts', async () => {
  const fixture = await fixtureRoot('sks-canonical-runner-drift-');
  try {
    await writeFixtureTests(fixture, `
      const fs = require('node:fs');
      const path = require('node:path');
      const test = require('node:test');
      test('mutates tracked release state', () => {
        fs.appendFileSync(path.join(process.cwd(), 'src', 'index.ts'), '// drift\\n');
      });
    `);
    const run = spawnSync(process.execPath, [runner], {
      cwd: fixture,
      env: standaloneTestEnv(),
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024
    });
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /canonical_test_release_authorization_drift/);
    assert.equal(fs.existsSync(path.join(fixture, '.sneakoscope', 'reports', 'canonical-test-proof.json')), false);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('canonical test runner removes a child-forged current proof when the child fails', async () => {
  const fixture = await fixtureRoot('sks-canonical-runner-forged-proof-');
  try {
    const proofModule = pathToFileURL(path.join(repoRoot, 'dist', 'core', 'release', 'canonical-test-proof.js')).href;
    const authorizationModule = pathToFileURL(path.join(repoRoot, 'dist', 'core', 'release', 'release-authorization-snapshot.js')).href;
    await writeFixtureTests(fixture, `
      const fs = require('node:fs');
      const path = require('node:path');
      const assert = require('node:assert/strict');
      const test = require('node:test');
      test('writes a current-looking canonical proof before failing', async () => {
        const proof = await import(${JSON.stringify(proofModule)});
        const authorization = await import(${JSON.stringify(authorizationModule)});
        const root = process.cwd();
        const now = new Date().toISOString();
        await proof.writeCanonicalTestProof(root, {
          started_at: now,
          completed_at: now,
          corpus: proof.canonicalTestCorpus(root),
          release_authorization_snapshot: authorization.releaseAuthorizationSnapshot(
            root,
            JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
          )
        });
        assert.fail('intentional failure after proof recreation');
      });
    `);
    const run = spawnSync(process.execPath, [runner], {
      cwd: fixture,
      env: standaloneTestEnv(),
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024
    });
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /intentional failure after proof recreation/);
    assert.equal(fs.existsSync(path.join(fixture, '.sneakoscope', 'reports', 'canonical-test-proof.json')), false);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('canonical test runner does not allow ambient NODE_OPTIONS to skip the corpus', async () => {
  const fixture = await fixtureRoot('sks-canonical-runner-node-options-');
  try {
    await writeFixtureTests(fixture, `
      const assert = require('node:assert/strict');
      const test = require('node:test');
      test('must execute despite an ambient name filter', () => {
        assert.fail('canonical corpus executed');
      });
    `);
    const run = spawnSync(process.execPath, [runner], {
      cwd: fixture,
      env: { ...standaloneTestEnv(), NODE_OPTIONS: '--test-name-pattern=__definitely_no_match__' },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024
    });
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /canonical corpus executed/);
    assert.equal(fs.existsSync(path.join(fixture, '.sneakoscope', 'reports', 'canonical-test-proof.json')), false);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('canonical test runner settles surviving test descendants before removing the run root', { skip: process.platform === 'win32' }, async () => {
  const fixture = await fixtureRoot('sks-canonical-runner-descendant-');
  try {
    await writeFixtureTests(fixture, `
      const fs = require('node:fs');
      const path = require('node:path');
      const { spawn } = require('node:child_process');
      const test = require('node:test');
      test('leaves a same-group descendant for the runner to settle', () => {
        const child = spawn(process.execPath, ['-e', \"const fs=require('node:fs');const path=require('node:path');const root=process.env.TMPDIR;setInterval(()=>{fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'late-writer.txt'),String(Date.now()))},10)\"], { stdio: 'ignore' });
        child.unref();
        fs.writeFileSync(path.join(process.cwd(), 'observed.json'), JSON.stringify({ TMPDIR: process.env.TMPDIR, pid: child.pid }));
      });
    `);
    const run = spawnSync(process.execPath, [runner], {
      cwd: fixture,
      env: standaloneTestEnv(),
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const observed = JSON.parse(await fsp.readFile(path.join(fixture, 'observed.json'), 'utf8'));
    assert.equal(fs.existsSync(observed.TMPDIR), false);
    assert.equal(pidAlive(observed.pid), false, `descendant ${observed.pid} survived canonical cleanup`);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

async function fixtureRoot(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  await Promise.all([
    // Must land inside the release-authorization compiled corpus
    // (`dist/core/release/__tests__/**` or CURRENT_COMPILED_TESTS).
    fsp.mkdir(path.join(root, 'dist', 'core', 'release', '__tests__'), { recursive: true }),
    fsp.mkdir(path.join(root, 'test', 'unit'), { recursive: true }),
    fsp.mkdir(path.join(root, 'src'), { recursive: true })
  ]);
  await Promise.all([
    fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'runner-fixture', version: '1.0.0', files: ['dist', 'src', 'test'] })),
    fsp.writeFile(path.join(root, 'release-gates.v2.json'), '{}'),
    fsp.writeFile(path.join(root, 'infra-harness-gates.json'), '{}'),
    fsp.writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1\n')
  ]);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Fixture']);
  return root;
}

async function writeFixtureTests(root: string, compiledSource: string): Promise<void> {
  await Promise.all([
    fsp.writeFile(path.join(root, 'dist', 'core', 'release', '__tests__', 'fixture.test.js'), compiledSource),
    // Basename must match CURRENT_UNIT_TEST (`release-*.test.mjs`).
    fsp.writeFile(path.join(root, 'test', 'unit', 'release-fixture.test.mjs'), `
      import test from 'node:test';
      import assert from 'node:assert/strict';
      test('unit surface exists', () => assert.ok(true));
    `)
  ]);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function standaloneTestEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
