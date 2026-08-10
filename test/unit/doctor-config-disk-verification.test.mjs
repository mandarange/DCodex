import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyCodexConfigsOnDisk } from '../../dist/core/doctor/doctor-repair-postcheck.js';
import { changedFilesFromRepairReport } from '../../dist/core/doctor/doctor-transaction.js';

async function fixture(project = '', home = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-disk-verify-'));
  const codexHome = path.join(root, 'home', '.codex');
  await fs.mkdir(path.join(root, '.codex'), { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  if (project !== null) await fs.writeFile(path.join(root, '.codex', 'config.toml'), project);
  if (home !== null) await fs.writeFile(path.join(codexHome, 'config.toml'), home);
  return { root, codexHome, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

const HEALTHY = [
  '# SKS-MANAGED-CODEX-CONFIG',
  '[agents]',
  'enabled = true',
  'max_depth = 1',
  'max_concurrent_threads_per_session = 256',
  '',
  '[features.multi_agent_v2]',
  'enabled = true',
  'max_concurrent_threads_per_session = 257',
  'expose_spawn_agent_model_overrides = true',
  ''
].join('\n');

test('disk verification passes for a healthy managed config', async () => {
  const f = await fixture(HEALTHY, '');
  try {
    const report = await verifyCodexConfigsOnDisk({ root: f.root, home: path.join(f.root, 'home'), codexHome: f.codexHome });
    assert.equal(report.ok, true, `unexpected blockers: ${report.blockers.join(', ')}`);
    assert.equal(report.multi_agent_v2_enabled, true);
    assert.equal(report.agents_enabled, true);
    assert.deepEqual(report.blockers, []);
  } finally {
    await f.cleanup();
  }
});

test('disk verification catches a config a repair left unparseable', async () => {
  // The whole point of reading back from disk: a phase can report success while
  // the file it wrote no longer parses.
  const f = await fixture('[agents\nenabled = true\n', '');
  try {
    const report = await verifyCodexConfigsOnDisk({ root: f.root, home: path.join(f.root, 'home'), codexHome: f.codexHome });
    assert.equal(report.ok, false);
    assert.ok(report.blockers.includes('project_codex_config_unparseable_after_repair'), report.blockers.join(', '));
  } finally {
    await f.cleanup();
  }
});

test('disk verification catches the official subagent lane left switched off', async () => {
  const off = HEALTHY.replace('[features.multi_agent_v2]\nenabled = true', '[features.multi_agent_v2]\nenabled = false');
  const f = await fixture(off, '');
  try {
    const report = await verifyCodexConfigsOnDisk({ root: f.root, home: path.join(f.root, 'home'), codexHome: f.codexHome });
    assert.equal(report.ok, false);
    assert.ok(report.blockers.includes('official_subagent_multi_agent_v2_disabled_after_repair'), report.blockers.join(', '));
  } finally {
    await f.cleanup();
  }
});

test('agents.enabled = false alone is not a blocker while v2 is on', async () => {
  // Codex resolves an enabled multi_agent_v2 to V2 regardless of agents.enabled
  // (verified against Codex 0.147), so blocking on it alone is a false positive.
  const f = await fixture(HEALTHY.replace('[agents]\nenabled = true', '[agents]\nenabled = false'), '');
  try {
    const report = await verifyCodexConfigsOnDisk({ root: f.root, home: path.join(f.root, 'home'), codexHome: f.codexHome });
    assert.equal(report.agents_enabled, false);
    assert.equal(report.multi_agent_v2_enabled, true);
    assert.equal(report.ok, true, `unexpected blockers: ${report.blockers.join(', ')}`);
  } finally {
    await f.cleanup();
  }
});

test('changed-file extraction reports written paths and ignores untouched ones', () => {
  // The doctor idempotence gate reads this. It previously found nothing at all,
  // so a second, mutating doctor run looked like a clean no-op.
  const written = changedFilesFromRepairReport({
    role_repair: {
      created: ['.codex/agents/worker.toml'],
      updated: ['.codex/agents/expert.toml'],
      existing: ['.codex/agents/debugger.toml'],
      preserved: ['.codex/agents/user-owned.toml'],
      generated_files: ['.codex/agents/debugger.toml']
    },
    config_file_repair: { repaired_paths: ['/tmp/p/.codex/config.toml'], created_files: [] }
  });
  assert.deepEqual(written, [
    '.codex/agents/expert.toml',
    '.codex/agents/worker.toml',
    '/tmp/p/.codex/config.toml'
  ]);

  // A report that changed nothing must extract nothing, or every run looks
  // non-idempotent and the gate becomes noise.
  assert.deepEqual(changedFilesFromRepairReport({
    existing: ['.codex/agents/debugger.toml'],
    preserved: ['.codex/agents/user.toml'],
    generated_files: ['.codex/agents/debugger.toml'],
    changed: false,
    config_path: '/tmp/p/.codex/config.toml'
  }), []);

  // config_path counts only when the same report says the write happened.
  assert.deepEqual(
    changedFilesFromRepairReport({ changed: true, config_path: '/tmp/p/.codex/config.toml' }),
    ['/tmp/p/.codex/config.toml']
  );
});
