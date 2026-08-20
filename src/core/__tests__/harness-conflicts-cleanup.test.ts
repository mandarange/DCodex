import './helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupOtherHarnessConflicts,
  scanHarnessConflicts
} from '../harness-conflicts.js';
import { runOtherHarnessCleanupStage } from '../update/update-migration-state/simple-stages.js';

const CONFIG_FIXTURE = [
  'model = "keep-me"',
  'provider = "openai"',
  '# user comment to preserve',
  '',
  '[mcp_servers."acas-tools"]',
  'command = "node"',
  'args = ["acas-tools.js"]',
  'env_vars = ["FOO"]',
  'enabled = true',
  'required = false',
  'startup_timeout_sec = 10',
  'tool_timeout_sec = 120',
  '',
  '[harness]',
  'name = "omx"',
  'note = "dcodex leftover"',
  ''
].join('\n');

test('cleanupOtherHarnessConflicts quarantines OMX/DCodex markers and strips config deps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-other-harness-'));
  const home = path.join(root, 'home');
  try {
    await fs.mkdir(path.join(root, '.omx'), { recursive: true });
    await fs.mkdir(path.join(root, '.dcodex'), { recursive: true });
    await fs.mkdir(path.join(root, '.codex'), { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(root, '.codex', 'config.toml'), CONFIG_FIXTURE);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: {
        leftpad: '1.0.0',
        '@scope/omx-harness': '1.2.3',
        'dcodex-cli': '0.1.0'
      }
    }, null, 2) + '\n');

    const before = await scanHarnessConflicts(root, { home });
    assert.equal(before.hard_block, true);

    const cleanup = await cleanupOtherHarnessConflicts(root, { home });
    assert.equal(cleanup.ok, true, JSON.stringify(cleanup.errors));
    assert.ok(cleanup.cleaned.length >= 3);

    await assert.rejects(fs.access(path.join(root, '.omx')));
    await assert.rejects(fs.access(path.join(root, '.dcodex')));
    const config = await fs.readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
    assert.match(config, /keep-me/);
    assert.match(config, /provider = "openai"/);
    assert.match(config, /# user comment to preserve/);
    assert.match(config, /\[mcp_servers\."acas-tools"\]/);
    assert.match(config, /command = "node"/);
    assert.match(config, /args = \["acas-tools\.js"\]/);
    assert.match(config, /env_vars = \["FOO"\]/);
    assert.match(config, /enabled = true/);
    assert.match(config, /required = false/);
    assert.match(config, /startup_timeout_sec = 10/);
    assert.match(config, /tool_timeout_sec = 120/);
    assert.doesNotMatch(config, /omx|dcodex/i);
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.leftpad, '1.0.0');
    assert.equal(pkg.dependencies['@scope/omx-harness'], undefined);
    assert.equal(pkg.dependencies['dcodex-cli'], undefined);

    const after = await scanHarnessConflicts(root, { home });
    assert.equal(after.hard_block, false);

    const quarantineRoot = path.join(root, '.sneakoscope', 'quarantine', 'other-harness', cleanup.run_id);
    await fs.access(quarantineRoot);
    const quarantineEntries = await fs.readdir(quarantineRoot, { recursive: true });
    assert.ok(quarantineEntries.length >= 1, 'expected quarantine backup entries');

    const second = await cleanupOtherHarnessConflicts(root, { home });
    assert.equal(second.ok, true);
    assert.equal(second.cleaned.length, 0);
    const afterSecond = await scanHarnessConflicts(root, { home });
    assert.equal(afterSecond.hard_block, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('update other-harness stage quarantines conflicts instead of only reporting them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-other-harness-'));
  try {
    await fs.mkdir(path.join(root, '.omx'), { recursive: true });
    const result = await runOtherHarnessCleanupStage(root);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.actions.includes('other_harness_conflicts_quarantined'));
    await assert.rejects(fs.access(path.join(root, '.omx')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
