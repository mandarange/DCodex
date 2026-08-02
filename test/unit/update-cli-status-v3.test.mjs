import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('update status, update check, and update-check expose the same v3 schema', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-cli-v3-'));
  const projectRoot = path.join(home, 'selected project');
  const registry = 'https://registry.example.test/custom';
  try {
    await fs.mkdir(projectRoot, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global'),
      SKS_UPDATE_STATUS_PATH: path.join(home, 'update-status.json'),
      SKS_DISABLE_UPDATE_CHECK: '1'
    };
    const commands = [
      ['update', 'status', '--refresh', '--project-root', projectRoot, '--registry', registry, '--json'],
      ['update', 'check', '--project-root', projectRoot, '--registry', registry, '--json'],
      ['update-check', '--project-root', projectRoot, '--registry', registry, '--json']
    ];
    for (const args of commands) {
      const run = spawnSync(process.execPath, ['dist/bin/sks.js', ...args], {
        cwd: process.cwd(), env, encoding: 'utf8'
      });
      assert.equal(run.status, 0, `${args.join(' ')}: ${run.stderr || run.stdout}`);
      const value = JSON.parse(run.stdout);
      assert.equal(value.schema, 'sks.update-status.v3');
      assert.equal(typeof value.update_count, 'number');
      assert.ok(value.sks && value.codex_cli && value.menubar);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('update CLI binds a Center-style explicit project root into dry-run and rollback receipts', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-cli-project-root-'));
  const projectRoot = path.join(home, 'selected project');
  const projectRootAlias = path.join(home, 'selected-project-link');
  const registry = 'https://registry.example.test/custom';
  const sksEntrypoint = path.resolve('dist/bin/sks.js');
  try {
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.symlink(projectRoot, projectRootAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const canonicalProjectRoot = await fs.realpath(projectRoot);
    const env = {
      ...process.env,
      HOME: home,
      SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global'),
      SKS_UPDATE_STATUS_PATH: path.join(home, 'update-status.json'),
      SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: '99.99.99',
      SKS_UPDATE_SKIP_SKS_MENUBAR: '1'
    };
    const run = spawnSync(process.execPath, [
      sksEntrypoint,
      'update',
      'now',
      '--version',
      '99.99.99',
      '--project-root',
      projectRootAlias,
      '--registry',
      registry,
      '--dry-run',
      '--json'
    ], {
      cwd: home,
      env,
      encoding: 'utf8'
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const value = JSON.parse(run.stdout);
    assert.equal(value.status, 'dry_run');
    assert.equal(value.project_root, canonicalProjectRoot);
    assert.equal(value.registry, registry);
    assert.deepEqual(value.npm_args.slice(-2), ['--registry', registry]);
    assert.equal(
      value.rollback.command,
      `sks update rollback --version ${value.from} --project-root '${canonicalProjectRoot}' --registry ${registry} --json`
    );
    const receipt = JSON.parse(await fs.readFile(value.operation_receipt_path, 'utf8'));
    assert.equal(receipt.project_root, canonicalProjectRoot);
    assert.equal(receipt.rollback_command, value.rollback.command);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
