import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectInstalledCliResolution } from '../installed-cli-resolution.js';

test('same-version PATH shadow is rejected unless it targets the exact global entrypoint', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX executable and symlink fixture');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-installed-cli-resolution-'));
  const globalRoot = path.join(root, 'lib', 'node_modules');
  const packageRoot = path.join(globalRoot, 'sneakoscope');
  const entrypoint = path.join(packageRoot, 'dist', 'bin', 'sks.js');
  const bin = path.join(root, 'bin');
  const pathSks = path.join(bin, 'sks');
  try {
    await fs.mkdir(path.dirname(entrypoint), { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
      name: 'sneakoscope',
      version: '8.0.4',
      type: 'module'
    }, null, 2)}\n`);
    await fs.writeFile(entrypoint, `#!${process.execPath}\nconsole.log('8.0.4');\n`);
    await fs.chmod(entrypoint, 0o755);
    await fs.writeFile(pathSks, `#!${process.execPath}\nconsole.log('8.0.4');\n`);
    await fs.chmod(pathSks, 0o755);

    const shadowed = await inspectInstalledCliResolution({
      expectedVersion: '8.0.4',
      globalRoot,
      env: { ...process.env, PATH: bin }
    });
    assert.equal(shadowed.manifest_version, '8.0.4');
    assert.equal(shadowed.entrypoint_version, '8.0.4');
    assert.equal(shadowed.path_version, '8.0.4');
    assert.equal(shadowed.path_targets_entrypoint, false);
    assert.equal(shadowed.ok, false);
    assert.ok(shadowed.blockers.includes('installed_cli_path_target_mismatch'));

    await fs.unlink(pathSks);
    await fs.symlink(entrypoint, pathSks);
    const exact = await inspectInstalledCliResolution({
      expectedVersion: '8.0.4',
      globalRoot,
      env: { ...process.env, PATH: bin }
    });
    assert.equal(exact.ok, true, exact.blockers.join(', '));
    assert.equal(exact.path_targets_entrypoint, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
