import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LEGACY_BRIDGE_GENERATION_KEEP_COUNT,
  LEGACY_CONFIG_BACKUP_KEEP_COUNT,
  reconcileLegacyRuntimeData
} from '../legacy-runtime-data-gc.js';

const GEN = (seed: string) => `${seed.repeat(64)}.${seed.repeat(64)}.${seed.repeat(64)}`;

async function fixture(): Promise<{ home: string; codexHome: string; stateRoot: string }> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-legacy-gc-'));
  const codexHome = path.join(home, '.codex');
  const stateRoot = path.join(home, '.sneakoscope');
  await fsp.mkdir(path.join(codexHome, 'sks', '.sks-bridge-generations'), { recursive: true });
  await fsp.mkdir(stateRoot, { recursive: true });
  return { home, codexHome, stateRoot };
}

async function writeAged(file: string, ageMinutes: number, content = '{}\n'): Promise<void> {
  await fsp.writeFile(file, content);
  const when = new Date(Date.now() - ageMinutes * 60_000);
  await fsp.utimes(file, when, when);
}

test('legacy runtime data GC keeps the newest config backups and removes the rest', async () => {
  const { home, codexHome } = await fixture();
  try {
    const names = [
      'config.toml.bak',
      'config.toml.bak-8.3.1',
      'config.toml.bak.20260529183341',
      'config.toml.backup-2026-07-01T17-30-55-163Z',
      'config.toml.backup-codex-lb-20260508-143713',
      'config.toml.codex-app-ui-repair-mssptjaw.bak',
      'config.toml.pre-session-restore-20260728-233430.bak'
    ];
    for (const [index, name] of names.entries()) {
      await writeAged(path.join(codexHome, name), (index + 1) * 60, '# backup\n');
    }
    // The live config and non-backup files are never candidates.
    await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');
    await fsp.writeFile(path.join(codexHome, 'auth.json'), '{}\n');

    const check = await reconcileLegacyRuntimeData({ codexHome, stateRoots: [], fix: false });
    assert.equal(check.config_backups.detected, names.length);
    assert.equal(check.config_backups.kept, LEGACY_CONFIG_BACKUP_KEEP_COUNT);
    assert.equal(check.config_backups.remaining, names.length - LEGACY_CONFIG_BACKUP_KEEP_COUNT);
    assert.equal(check.config_backups.removed, 0);
    assert.equal(check.ok, false);

    const fixed = await reconcileLegacyRuntimeData({ codexHome, stateRoots: [], fix: true });
    assert.equal(fixed.config_backups.removed, names.length - LEGACY_CONFIG_BACKUP_KEEP_COUNT);
    assert.equal(fixed.ok, true);
    const survivors = (await fsp.readdir(codexHome)).filter((name) => name.startsWith('config.toml.'));
    // Newest by mtime = the first entries written with the smallest age.
    assert.deepEqual(survivors.sort(), names.slice(0, LEGACY_CONFIG_BACKUP_KEEP_COUNT).sort());
    assert.equal((await fsp.readFile(path.join(codexHome, 'config.toml'), 'utf8')).includes('gpt-5.6-sol'), true);

    const idempotent = await reconcileLegacyRuntimeData({ codexHome, stateRoots: [], fix: true });
    assert.equal(idempotent.config_backups.removed, 0);
    assert.equal(idempotent.ok, true);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('legacy runtime data GC never deletes bridge generations without an active pointer', async () => {
  const { home, codexHome } = await fixture();
  const generationsRoot = path.join(codexHome, 'sks', '.sks-bridge-generations');
  try {
    for (const [index, seed] of ['a', 'b', 'c', 'd'].entries()) {
      const dir = path.join(generationsRoot, GEN(seed));
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'sks-bridge-catalog.json'), '{}\n');
      const when = new Date(Date.now() - (index + 1) * 3_600_000);
      await fsp.utimes(dir, when, when);
    }

    // No pointer: nothing is provably inactive, so everything is kept.
    const unproven = await reconcileLegacyRuntimeData({ codexHome, stateRoots: [], fix: true });
    assert.equal(unproven.bridge_generations.detected, 4);
    assert.equal(unproven.bridge_generations.removed, 0);
    assert.equal(unproven.bridge_generations.kept, 4);
    assert.equal(unproven.ok, true);

    // Pointer names 'c' active; newest inactive ('a') is kept as rollback.
    await fsp.writeFile(path.join(codexHome, 'sks', 'sks-bridge-active-generation.json'), `${JSON.stringify({
      schema: 'sks.bridge-active-generation.v1',
      bundle_directory: `.sks-bridge-generations/${GEN('c')}`
    })}\n`);
    const fixed = await reconcileLegacyRuntimeData({ codexHome, stateRoots: [], fix: true });
    assert.equal(fixed.bridge_generations.detected, 4);
    assert.equal(fixed.bridge_generations.kept, 1 + LEGACY_BRIDGE_GENERATION_KEEP_COUNT);
    assert.equal(fixed.bridge_generations.removed, 4 - 1 - LEGACY_BRIDGE_GENERATION_KEEP_COUNT);
    const survivors = await fsp.readdir(generationsRoot);
    assert.deepEqual(survivors.sort(), [GEN('a'), GEN('c')].sort());
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('legacy runtime data GC removes retired version caches and the superseded chrome hosts record', async () => {
  const { home, codexHome, stateRoot } = await fixture();
  try {
    await fsp.writeFile(path.join(stateRoot, 'codex-0138-capability.json'), '{}\n');
    await fsp.writeFile(path.join(stateRoot, 'codex-0138-doctor.json'), '{}\n');
    await fsp.writeFile(path.join(stateRoot, 'codex-0139-capability.json'), '{}\n');
    await fsp.writeFile(path.join(stateRoot, 'codex-current-app-capability.json'), '{}\n');
    await fsp.writeFile(path.join(codexHome, 'chrome-native-hosts.json'), '{}\n');

    // v1 chrome hosts without v2 is still the only copy: kept.
    const before = await reconcileLegacyRuntimeData({ codexHome, stateRoots: [stateRoot], fix: true });
    assert.equal(before.retired_singletons.detected, 1);
    assert.equal(before.retired_singletons.kept, 1);
    assert.equal(before.retired_singletons.removed, 0);
    assert.equal(before.retired_version_caches.removed, 3);

    await fsp.writeFile(path.join(codexHome, 'chrome-native-hosts-v2.json'), '{}\n');
    const after = await reconcileLegacyRuntimeData({ codexHome, stateRoots: [stateRoot], fix: true });
    assert.equal(after.retired_singletons.removed, 1);
    assert.equal(after.ok, true);
    const stateSurvivors = await fsp.readdir(stateRoot);
    assert.deepEqual(stateSurvivors.sort(), ['codex-current-app-capability.json']);
    const codexSurvivors = (await fsp.readdir(codexHome)).filter((name) => name.startsWith('chrome-'));
    assert.deepEqual(codexSurvivors, ['chrome-native-hosts-v2.json']);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('legacy runtime data GC is inert on a machine with nothing to clean', async () => {
  const { home, codexHome, stateRoot } = await fixture();
  try {
    const report = await reconcileLegacyRuntimeData({
      codexHome,
      stateRoots: [stateRoot, path.join(home, 'missing', '.sneakoscope')],
      fix: true
    });
    assert.equal(report.ok, true);
    assert.equal(report.remaining_count, 0);
    assert.equal(report.error_count, 0);
    for (const category of [report.config_backups, report.bridge_generations, report.retired_version_caches, report.retired_singletons]) {
      assert.deepEqual(category, { detected: 0, removed: 0, kept: 0, remaining: 0, errors: [] });
    }
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
