import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { actionScriptSource, smokeSksMenuBarAction } from '../menubar/index.js';

test('smoke check fails with a distinct non-executable signal when the action script lost its +x bit', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-smoke-noexec-'));
  t.after(async () => {
    await fs.rm(temp, { recursive: true, force: true });
  });
  const script = path.join(temp, 'sks-menubar-action.sh');
  // Write a script that WOULD succeed if invoked through an interpreter — the exact
  // condition that used to mask a missing +x bit and let doctor report a healthy
  // action target while the menu bar showed "action script broken".
  await fs.writeFile(script, '#!/bin/sh\necho "sneakoscope 9.9.9"\n', { mode: 0o644 });

  const broken = await smokeSksMenuBarAction(script);
  assert.equal(broken.ok, false);
  assert.equal(broken.executable, false);
  assert.match(String(broken.output), /not executable/);

  await fs.chmod(script, 0o755);
  const repaired = await smokeSksMenuBarAction(script);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.executable, true);
  assert.equal(repaired.versionDetected, true);
});

test('SKS menu bar action script resolves sks dynamically from the login shell PATH first', async (t) => {
  if (process.platform !== 'darwin') return t.skip('generated Menu Bar action scripts require macOS /bin/zsh');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-action-'));
  t.after(async () => {
    await fs.rm(temp, { recursive: true, force: true });
  });
  const home = path.join(temp, 'home');
  const bin = path.join(temp, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(bin, 'sks'), '#!/bin/sh\necho "fake-sks:$*"\n', { mode: 0o755 });

  const script = path.join(temp, 'sks-menubar-action.sh');
  await fs.writeFile(script, actionScriptSource({ nodeBin: '/missing/node', sksEntry: '/missing/sks.js' }), { mode: 0o755 });

  const result = await run('/bin/zsh', [script, 'version'], {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /fake-sks:version/);
});

test('SKS menu bar action script prepends the resolved NVM Node bin before running the pinned entry', async (t) => {
  if (process.platform !== 'darwin') return t.skip('generated Menu Bar action scripts require macOS /bin/zsh');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-action-nvm-'));
  t.after(async () => {
    await fs.rm(temp, { recursive: true, force: true });
  });
  const home = path.join(temp, 'home');
  const nvmBin = path.join(home, '.nvm', 'versions', 'node', 'v24.0.2', 'bin');
  const node = path.join(nvmBin, 'node');
  const entry = path.join(temp, 'sks.js');
  await fs.mkdir(nvmBin, { recursive: true });
  await fs.writeFile(node, '#!/bin/sh\nprintf "%s\\n" "$PATH"\n', { mode: 0o755 });
  await fs.writeFile(entry, '// fixture\n');
  const script = path.join(temp, 'sks-menubar-action.sh');
  await fs.writeFile(script, actionScriptSource({ nodeBin: '/missing/node', sksEntry: entry }), { mode: 0o755 });

  const result = await run('/bin/zsh', [script, 'version'], {
    HOME: home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim().split(':')[0], nvmBin);
});

test('SKS menu bar action script exits 127 when every candidate is unavailable', async (t) => {
  if (process.platform !== 'darwin') return t.skip('generated Menu Bar action scripts require macOS /bin/zsh');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-action-missing-'));
  t.after(async () => {
    await fs.rm(temp, { recursive: true, force: true });
  });
  const home = path.join(temp, 'home');
  const npmPrefix = path.join(temp, 'npm-prefix');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(path.join(npmPrefix, 'lib', 'node_modules'), { recursive: true });
  const script = path.join(temp, 'sks-menubar-action.sh');
  await fs.writeFile(script, actionScriptSource({ nodeBin: '/missing/node', sksEntry: '/missing/sks.js' }), { mode: 0o755 });

  const result = await run('/bin/zsh', [script, 'version'], {
    HOME: home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    // The generated script shells out to `npm root -g` via a login shell, whose PATH
    // (rebuilt by /etc/zprofile's path_helper) can legitimately resolve a REAL npm binary
    // on the developer's machine regardless of this test's own PATH restriction. Pinning
    // NPM_CONFIG_PREFIX ensures `npm root -g` reports this isolated, empty prefix — which
    // provably has no `sneakoscope` package installed — instead of a real global root that
    // might, making the "nothing found" assertion deterministic on any real dev machine.
    NPM_CONFIG_PREFIX: npmPrefix
  });
  assert.equal(result.code, 127);
  assert.match(result.stderr, /SKS command not found/);
});

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
