import './helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  adoptProjectCodexConfig,
  formatSksConfigAdoptText,
  runSksConfigAdopt,
  SKS_CONFIG_ADOPT_RECEIPT_SCHEMA
} from '../config-adopt/config-adopt.js';
import {
  SKS_MANAGED_CODEX_CONFIG_MARKER,
  writeCodexConfigGuarded
} from '../codex/codex-config-guard.js';
import { formatSksUpdateStageText } from '../commands/basic-cli.js';
import { dispatch } from '../../cli/router.js';
import { escapeRegExp } from '../text/regex.js';

test('marker-less project receipt failure prints its config path, marker, and adopt remedy', async (t) => {
  const fixture = await configFixture('model = "gpt-5.4"\n');
  try {
    const line = formatSksUpdateStageText({
      id: 'project_receipt',
      ok: false,
      status: 'failed',
      detail: {
        root: fixture.root,
        required_blockers: ['user_owned_file_without_sks_marker']
      }
    }, fixture.root);

    assert.match(line, new RegExp(escapeRegExp(fixture.configPath)));
    assert.ok(line.includes(SKS_MANAGED_CODEX_CONFIG_MARKER), line);
    assert.ok(line.includes('sks config adopt'), line);
    assert.equal(
      formatSksUpdateStageText({
        id: 'project_receipt',
        ok: false,
        status: 'failed',
        detail: { required_blockers: ['unknown_update_blocker'] }
      }, fixture.root),
      'Stage project_receipt: failed failed — unknown_update_blocker'
    );
    const bounded = formatSksUpdateStageText({
      id: 'project_receipt',
      ok: false,
      status: 'failed',
      detail: {
        required_blockers: Array.from({ length: 20 }, (_, index) => `unknown_blocker_${index}\ncontinued`)
      }
    }, fixture.root);
    assert.doesNotMatch(bounded, /[\r\n]/);
    assert.match(bounded, /unknown_blocker_15 continued/);
    assert.doesNotMatch(bounded, /unknown_blocker_16/);
    t.diagnostic(line);
  } finally {
    await fixture.cleanup();
  }
});

test('config help routes to the module usage export', async () => {
  const output: string[] = [];
  const previousLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  try {
    await dispatch(['config', '--help']);
  } finally {
    console.log = previousLog;
  }
  assert.match(output.join('\n'), /Usage: sks config adopt \[--project-root <path>\] \[--dry-run\] \[--json\]/);
});

test('an identical unmanaged config is verified without any config-file write', async () => {
  const fixture = await configFixture('model = "gpt-5.4"\n');
  try {
    await fsp.chmod(fixture.configPath, 0o640);
    const beforeStat = await fsp.stat(fixture.configPath);
    const beforeNames = await fsp.readdir(path.dirname(fixture.configPath));

    const result = await writeCodexConfigGuarded({
      root: fixture.root,
      configPath: fixture.configPath,
      mutate: (before) => before
    });

    const afterStat = await fsp.stat(fixture.configPath);
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(result.backup_path, null);
    assert.equal(afterStat.dev, beforeStat.dev);
    assert.equal(afterStat.ino, beforeStat.ino);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStat.mode & 0o777, 0o640);
    assert.deepEqual(await fsp.readdir(path.dirname(fixture.configPath)), beforeNames);
  } finally {
    await fixture.cleanup();
  }
});

test('config adopt inserts only the explicit marker and writes a backup plus receipt', async () => {
  const before = '# operator-owned settings\nmodel = "gpt-5.4"\n\n[features]\napps = true\n';
  const fixture = await configFixture(before);
  try {
    const result = await runSksConfigAdopt({ root: fixture.root });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, 'adopted');
    assert.equal(result.changed, true);
    assert.ok(result.backup_path);
    assert.ok(result.receipt_path);
    assert.equal(
      await fsp.readFile(fixture.configPath, 'utf8'),
      `${SKS_MANAGED_CODEX_CONFIG_MARKER}\n${before}`
    );
    assert.equal(await fsp.readFile(result.backup_path!, 'utf8'), before);
    const receipt = JSON.parse(await fsp.readFile(result.receipt_path!, 'utf8'));
    assert.equal(receipt.schema, SKS_CONFIG_ADOPT_RECEIPT_SCHEMA);
    assert.equal(receipt.status, 'adopted');
    assert.equal(receipt.config_path, result.config_path);
    assert.equal(receipt.backup_path, result.backup_path);
    assert.equal(receipt.before_sha256, result.before_sha256);
    assert.equal(receipt.after_sha256, result.after_sha256);
    if (process.platform !== 'win32') {
      assert.equal((await fsp.stat(fixture.configPath)).mode & 0o777, 0o600);
      assert.equal((await fsp.stat(result.backup_path!)).mode & 0o777, 0o600);
      assert.equal((await fsp.stat(result.receipt_path!)).mode & 0o777, 0o600);
    }

    const adoptedStat = await fsp.stat(fixture.configPath);
    const receiptNames = await fsp.readdir(path.dirname(result.receipt_path!));
    const backupNames = (await fsp.readdir(path.dirname(fixture.configPath)))
      .filter((name) => name.endsWith('.bak'));
    const repeated = await runSksConfigAdopt({ root: fixture.root });
    const repeatedStat = await fsp.stat(fixture.configPath);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.status, 'already_adopted');
    assert.equal(repeated.changed, false);
    assert.equal(repeated.receipt_path, null);
    assert.equal(repeatedStat.ino, adoptedStat.ino);
    assert.equal(repeatedStat.mtimeMs, adoptedStat.mtimeMs);
    assert.deepEqual(await fsp.readdir(path.dirname(result.receipt_path!)), receiptNames);
    assert.deepEqual(
      (await fsp.readdir(path.dirname(fixture.configPath))).filter((name) => name.endsWith('.bak')),
      backupNames
    );
  } finally {
    await fixture.cleanup();
  }
});

test('config adopt CAS rejects a concurrent edit without overwriting it', async () => {
  const before = 'model = "gpt-5.4"\n';
  const concurrent = 'model = "gpt-5.6"\n# changed by operator\n';
  const fixture = await configFixture(before);
  try {
    const result = await runSksConfigAdopt({
      root: fixture.root,
      beforeCommit: () => fsp.writeFile(fixture.configPath, concurrent)
    });
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.equal(result.blocker, 'config_adopt_concurrent_change_detected');
    assert.equal(result.backup_path, null);
    assert.equal(await fsp.readFile(fixture.configPath, 'utf8'), concurrent);
    assert.doesNotMatch(concurrent, /SKS-MANAGED-CODEX-CONFIG/);
    assert.ok(result.receipt_path);
    const receipt = JSON.parse(await fsp.readFile(result.receipt_path!, 'utf8'));
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.blocker, 'config_adopt_concurrent_change_detected');
    if (process.platform !== 'win32') {
      assert.equal((await fsp.stat(result.receipt_path!)).mode & 0o777, 0o600);
    }
    const human = formatSksConfigAdoptText(result);
    assert.match(human, new RegExp(`File: ${escapeRegExp(result.config_path)}`));
    assert.match(human, /Blocker: config_adopt_concurrent_change_detected/);
    assert.match(human, /Remedy: .*rerun sks config adopt/i);
  } finally {
    await fixture.cleanup();
  }
});

test('config adopt preserves invalid TOML and returns actionable human diagnostics', async () => {
  const before = '[features\napps = true\n';
  const fixture = await configFixture(before);
  try {
    const result = await runSksConfigAdopt({ root: fixture.root });
    assert.equal(result.ok, false);
    assert.equal(result.blocker, 'config_adopt_toml_invalid');
    assert.equal(result.changed, false);
    assert.equal(result.backup_path, null);
    assert.equal(result.receipt_path, null);
    assert.equal(await fsp.readFile(fixture.configPath, 'utf8'), before);
    const human = formatSksConfigAdoptText(result);
    assert.match(human, /File:/);
    assert.match(human, /Blocker:/);
    assert.match(human, /Remedy:/);
  } finally {
    await fixture.cleanup();
  }
});

test('adoptProjectCodexConfig translates projectRoot and dry-run performs zero writes', async () => {
  const before = 'model = "gpt-5.4"\n';
  const fixture = await configFixture(before);
  try {
    await fsp.chmod(fixture.configPath, 0o640);
    const beforeStat = await fsp.stat(fixture.configPath);
    const beforeCodexNames = await fsp.readdir(path.dirname(fixture.configPath));
    const result = await adoptProjectCodexConfig({
      projectRoot: fixture.root,
      dryRun: true
    });
    const afterStat = await fsp.stat(fixture.configPath);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'would_adopt');
    assert.equal(result.changed, false);
    assert.equal(result.backup_path, null);
    assert.equal(result.receipt_path, null);
    assert.equal(await fsp.readFile(fixture.configPath, 'utf8'), before);
    assert.equal(afterStat.ino, beforeStat.ino);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStat.mode & 0o777, beforeStat.mode & 0o777);
    assert.deepEqual(await fsp.readdir(path.dirname(fixture.configPath)), beforeCodexNames);
    await assert.rejects(fsp.access(path.join(fixture.root, '.sneakoscope')));
  } finally {
    await fixture.cleanup();
  }
});

async function configFixture(text: string) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-config-adopt-'));
  const configPath = path.join(root, '.codex', 'config.toml');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, text);
  return {
    root,
    configPath,
    cleanup: () => fsp.rm(root, { recursive: true, force: true })
  };
}
