// First import: update-migration stages (fastmode normalize, skills install,
// managed role configs) resolve os.homedir() directly and ignore injected env.
import './helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  UPDATE_STAGE_ORDER,
  runSksUpdateNow,
  runSksUpdateReview,
  runSksUpdateRollback
} from '../update-check.js';
import {
  authorizeUpdateRollback,
  UpdateOperationRecorder,
  updateOperationLatestPath
} from '../update/update-operation.js';

test('update review exposes the target, paths, rollback command, and documented stages without mutation', async () => {
  const fixture = await updateFailureFixture('success');
  try {
    const review = await runSksUpdateReview(fixture.options);
    assert.equal(review.ok, true, review.error || 'review failed');
    assert.equal(review.current, '6.2.0');
    assert.equal(review.target, '6.3.0');
    assert.equal(review.npm_bin, fixture.options.npmBin);
    assert.equal(review.node_path, process.execPath);
    assert.equal(review.rollback_command, 'sks update rollback --version 6.2.0 --json');
    assert.deepEqual(review.stages, [...UPDATE_STAGE_ORDER]);
    assert.equal(review.project_mutation, true);
  } finally {
    await fixture.cleanup();
  }
});

test('dry-run uses documented progress ids and never marks side effects as started', async () => {
  const fixture = await updateFailureFixture('success');
  try {
    const result = await runSksUpdateNow({ ...fixture.options, dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'dry_run');
    assert.deepEqual(result.stages.map((stage) => stage.id), [
      'preflight',
      'download_or_registry_check',
      'temporary_install_smoke',
      'global_install'
    ]);
    const operation = JSON.parse(await fs.readFile(result.operation_receipt_path!, 'utf8'));
    assert.equal(operation.side_effects_started, false);
  } finally {
    await fixture.cleanup();
  }
});

test('already-current update covers every documented stage so the Control Center checklist can complete', async () => {
  const fixture = await updateFailureFixture('success');
  try {
    const options: any = { ...fixture.options };
    delete options.version;
    options.env = { ...fixture.options.env, SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: '6.2.0' };
    const result = await runSksUpdateNow(options);
    assert.equal(result.status, 'current', result.error || result.status);
    const ids = result.stages.map((stage) => stage.id);
    assert.deepEqual([...new Set(ids)].sort(), [...UPDATE_STAGE_ORDER].sort());
    // The Swift Control Center rejects receipts carrying more stages than the
    // declared order, so the receipt must never exceed it.
    const operation = JSON.parse(await fs.readFile(result.operation_receipt_path!, 'utf8'));
    assert.ok(operation.stages.length <= UPDATE_STAGE_ORDER.length, `receipt stages ${operation.stages.length} > ${UPDATE_STAGE_ORDER.length}`);
    assert.ok(result.stages.every((stage) => stage.ok), JSON.stringify(result.stages.filter((stage) => !stage.ok)));
  } finally {
    await fixture.cleanup();
  }
});

test('rollback rejects malformed versions before attempting package mutation', async () => {
  const result = await runSksUpdateRollback({
    version: 'not-a-semver',
    npmBin: null,
    env: { HOME: '/tmp/sks-invalid-rollback' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.update, null);
  assert.equal(result.requested_version, null);
  assert.match(result.error || '', /valid semantic version/);
});

test('rollback requires the exact previous version from the latest successful update receipt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-rollback-auth-'));
  const env: NodeJS.ProcessEnv = { HOME: root, SKS_GLOBAL_ROOT: path.join(root, '.sneakoscope-global') };
  try {
    const recorder = await UpdateOperationRecorder.create({
      env, kind: 'update', fromVersion: '6.2.0', targetVersion: '6.3.0'
    });
    recorder.recordStage('global_install', true, 'installed', { code: 0, timed_out: false });
    await recorder.finish({ state: 'succeeded', resultStatus: 'updated' });

    const arbitrary = await runSksUpdateRollback({
      version: '6.1.0', currentVersion: '6.3.0', npmBin: null, env
    });
    assert.equal(arbitrary.ok, false);
    assert.equal(arbitrary.update, null);
    assert.equal(arbitrary.error, 'rollback_target_not_previous_version');

    const wrongCurrent = await runSksUpdateRollback({
      version: '6.2.0', currentVersion: '6.4.0', npmBin: null, env
    });
    assert.equal(wrongCurrent.ok, false);
    assert.equal(wrongCurrent.error, 'rollback_receipt_not_current_install');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rollback rejects stale receipts before invoking npm', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-rollback-stale-'));
  const env: NodeJS.ProcessEnv = { HOME: root, SKS_GLOBAL_ROOT: path.join(root, '.sneakoscope-global') };
  try {
    const recorder = await UpdateOperationRecorder.create({
      env, kind: 'update', fromVersion: '6.2.0', targetVersion: '6.3.0'
    });
    recorder.recordStage('global_install', true, 'installed', { code: 0, timed_out: false });
    const receipt = await recorder.finish({ state: 'succeeded', resultStatus: 'updated' });
    const stale = { ...receipt, updated_at: '2025-01-01T00:00:00.000Z' };
    await fs.writeFile(receipt.receipt_path, `${JSON.stringify(stale, null, 2)}\n`, { mode: 0o600 });
    await fs.writeFile(updateOperationLatestPath(env), `${JSON.stringify(stale, null, 2)}\n`, { mode: 0o600 });

    const result = await runSksUpdateRollback({
      version: '6.2.0', currentVersion: '6.3.0', npmBin: null, env
    });
    assert.equal(result.ok, false);
    assert.equal(result.update, null);
    assert.equal(result.error, 'rollback_receipt_stale');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rollback rejects a source receipt whose install stages differ from the atomic latest copy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-rollback-stage-tamper-'));
  const env: NodeJS.ProcessEnv = { HOME: root, SKS_GLOBAL_ROOT: path.join(root, '.sneakoscope-global') };
  try {
    const recorder = await UpdateOperationRecorder.create({
      env, kind: 'update', fromVersion: '6.2.0', targetVersion: '6.3.0'
    });
    recorder.recordStage('global_install', false, 'failed', { code: 7, timed_out: false });
    const receipt = await recorder.finish({ state: 'failed', resultStatus: 'failed' });
    const tampered = JSON.parse(await fs.readFile(receipt.receipt_path, 'utf8'));
    tampered.stages = [{ id: 'global_install', ok: true, status: 'installed', detail: { code: 0, timed_out: false } }];
    await fs.writeFile(receipt.receipt_path, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });

    const authorization = await authorizeUpdateRollback({
      targetVersion: '6.2.0', currentVersion: '6.3.0', env
    });
    assert.equal(authorization.ok, false);
    if (!authorization.ok) assert.equal(authorization.blocker, 'rollback_receipt_changed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('global install failure remains failed and its operation receipt cannot authorize rollback', async () => {
  const fixture = await updateFailureFixture('fail');
  try {
    const result = await runSksUpdateNow(fixture.options);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.install_code, 7);
    assert.ok(result.stages.some((stage) => stage.id === 'global_install' && stage.ok === false));
    assert.equal(result.rollback.previous_version, '6.2.0');
    const operation = JSON.parse(await fs.readFile(result.operation_receipt_path!, 'utf8'));
    assert.equal(operation.state, 'failed');
    assert.equal(operation.side_effects_started, true);
    const authorization = await authorizeUpdateRollback({
      targetVersion: '6.2.0', currentVersion: '6.3.0', env: fixture.options.env
    });
    assert.equal(authorization.ok, false);
    if (!authorization.ok) assert.equal(authorization.blocker, 'rollback_receipt_not_install');
  } finally {
    await fixture.cleanup();
  }
});

test('rollback authorization rejects started, failed, timed-out, uncertain, and non-terminal installs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-rollback-stage-auth-'));
  const env: NodeJS.ProcessEnv = { HOME: root, SKS_GLOBAL_ROOT: path.join(root, '.sneakoscope-global') };
  const cases: Array<{
    name: string;
    receiptState: 'running' | 'failed' | 'terminal_uncertain';
    stageOk: boolean;
    stageStatus: string;
    detail: Record<string, unknown>;
  }> = [
    {
      name: 'started',
      receiptState: 'failed',
      stageOk: true,
      stageStatus: 'started',
      detail: { code: 0, timed_out: false }
    },
    {
      name: 'failed',
      receiptState: 'failed',
      stageOk: false,
      stageStatus: 'failed',
      detail: { code: 7, timed_out: false }
    },
    {
      name: 'timed-out',
      receiptState: 'terminal_uncertain',
      stageOk: false,
      stageStatus: 'failed',
      detail: { code: 1, timed_out: true }
    },
    {
      name: 'uncertain',
      receiptState: 'terminal_uncertain',
      stageOk: true,
      stageStatus: 'terminal_uncertain',
      detail: { code: 0, timed_out: false }
    },
    {
      name: 'non-terminal',
      receiptState: 'running',
      stageOk: true,
      stageStatus: 'installed',
      detail: { code: 0, timed_out: false }
    }
  ];
  try {
    for (const row of cases) {
      const recorder = await UpdateOperationRecorder.create({
        env, kind: 'update', fromVersion: '6.2.0', targetVersion: '6.3.0'
      });
      recorder.recordStage('global_install', row.stageOk, row.stageStatus, row.detail);
      if (row.receiptState === 'running') await recorder.flush();
      else await recorder.finish({ state: row.receiptState, resultStatus: row.receiptState });

      const authorization = await authorizeUpdateRollback({
        targetVersion: '6.2.0', currentVersion: '6.3.0', env
      });
      assert.equal(authorization.ok, false, `${row.name} install must not authorize rollback`);
      if (!authorization.ok) assert.equal(authorization.blocker, 'rollback_receipt_not_install');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('new-version doctor failure blocks migration and final success', async () => {
  const fixture = await updateFailureFixture('success');
  try {
    const entrypoint = path.join(fixture.root, 'new-sks.mjs');
    await fs.writeFile(entrypoint, "if (process.argv.includes('--version')) { console.log('6.3.0'); process.exit(0); } process.exit(1);\n");
    const result = await runSksUpdateNow({
      ...fixture.options,
      env: {
        ...fixture.options.env,
        SKS_UPDATE_FAKE_INSTALL: '1',
        SKS_UPDATE_FAKE_NEW_ENTRYPOINT: entrypoint,
        SKS_TEST_DOCTOR_OK: undefined,
        SKS_TEST_DOCTOR_FAIL: '1'
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.new_version, '6.3.0');
    assert.equal(result.new_version_doctor?.ok, false);
    assert.equal(result.new_version_doctor?.cwd, fixture.options.projectRoot);
    assert.ok(result.new_version_doctor?.args.includes(path.join(
      fixture.options.projectRoot,
      '.sneakoscope',
      'update',
      'new-version-doctor.json'
    )));
    assert.equal(result.project_receipt, null);
    assert.ok(result.stages.some((stage) => stage.id === 'new_version_doctor' && stage.ok === false));

    const operation = JSON.parse(await fs.readFile(result.operation_receipt_path!, 'utf8'));
    const installStage = operation.stages.find((stage: any) => stage.id === 'global_install');
    assert.equal(operation.state, 'failed');
    assert.equal(installStage?.ok, true);
    assert.equal(installStage?.status, 'fake_installed');
    assert.equal(installStage?.detail?.code, 0);
    assert.equal(installStage?.detail?.timed_out, false);

    const rollbackAuthorization = await authorizeUpdateRollback({
      targetVersion: '6.2.0',
      currentVersion: '6.3.0',
      env: fixture.options.env
    });
    assert.equal(rollbackAuthorization.ok, true, rollbackAuthorization.ok ? '' : rollbackAuthorization.blocker);
  } finally {
    await fixture.cleanup();
  }
});

test('timed-out global install is reported as terminal_uncertain', async () => {
  const fixture = await updateFailureFixture('hang');
  try {
    const result = await runSksUpdateNow({ ...fixture.options, timeoutMs: 200 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'terminal_uncertain');
    assert.match(result.error || '', /completion is uncertain/);
    const operation = JSON.parse(await fs.readFile(result.operation_receipt_path!, 'utf8'));
    assert.equal(operation.state, 'terminal_uncertain');
  } finally {
    await fixture.cleanup();
  }
});

test('hard crash after global-install start leaves an atomic non-authorizing interruption receipt', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX SIGKILL crash-point proof required');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-crash-point-'));
  const globalRoot = path.join(root, '.sneakoscope-global');
  const handoff = path.join(root, 'receipt-path.txt');
  const fixture = path.join(root, 'crash-after-global-install.mjs');
  try {
    await fs.writeFile(fixture, [
      `import { UpdateOperationRecorder } from ${JSON.stringify(new URL('../update/update-operation.js', import.meta.url).href)};`,
      "import fs from 'node:fs';",
      "const recorder = await UpdateOperationRecorder.create({ env: process.env, kind: 'update', fromVersion: '6.2.0', targetVersion: '6.3.0' });",
      "recorder.recordStage('preflight', true, 'verified');",
      "await recorder.flush();",
      "recorder.recordStage('global_install', true, 'started');",
      "await recorder.flush();",
      `fs.writeFileSync(${JSON.stringify(handoff)}, recorder.receiptPath);`,
      "process.kill(process.pid, 'SIGKILL');"
    ].join('\n'), { mode: 0o700 });
    const crashed = spawnSync(process.execPath, [fixture], {
      cwd: root,
      env: { ...process.env, HOME: root, SKS_GLOBAL_ROOT: globalRoot },
      encoding: 'utf8',
      timeout: 10_000
    });
    assert.equal(crashed.signal, 'SIGKILL');
    const receiptPath = await fs.readFile(handoff, 'utf8');
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    const latest = JSON.parse(await fs.readFile(path.join(globalRoot, 'operations', 'update-latest.json'), 'utf8'));
    assert.equal(receipt.state, 'running');
    assert.equal(receipt.current_stage, 'global_install');
    assert.equal(receipt.side_effects_started, true);
    assert.equal(receipt.previous_version, '6.2.0');
    assert.equal(receipt.target_version, '6.3.0');
    assert.equal(receipt.rollback_command, 'sks update rollback --version 6.2.0 --json');
    assert.ok(receipt.stages.some((stage: any) => stage.id === 'global_install' && stage.status === 'started'));
    assert.deepEqual(latest, receipt);
    const authorization = await authorizeUpdateRollback({
      targetVersion: '6.2.0', currentVersion: '6.3.0', env: { HOME: root, SKS_GLOBAL_ROOT: globalRoot }
    });
    assert.equal(authorization.ok, false);
    if (!authorization.ok) assert.equal(authorization.blocker, 'rollback_receipt_not_install');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function updateFailureFixture(mode: 'success' | 'fail' | 'hang') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `sks-update-${mode}-`));
  const npmBin = path.join(root, 'npm-fixture.mjs');
  const globalRoot = path.join(root, 'node_modules');
  await fs.mkdir(path.join(root, 'project'), { recursive: true });
  await fs.writeFile(npmBin, [
    `#!${process.execPath}`,
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'list' && args[1] === '-g') { console.log(JSON.stringify({ dependencies: { sneakoscope: { version: '6.2.0' } } })); process.exit(0); }",
    `if (args[0] === 'root') { console.log(${JSON.stringify(globalRoot)}); process.exit(0); }`,
    "if (args[0] === 'install' && args[1] === '--global') {",
    `  if (${JSON.stringify(mode)} === 'fail') process.exit(7);`,
    `  if (${JSON.stringify(mode)} === 'hang') { setTimeout(() => {}, 10000); } else { console.log('installed'); }`,
    "} else { console.error('unexpected args ' + args.join(' ')); process.exit(2); }"
  ].join('\n'));
  await fs.chmod(npmBin, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    PATH: '/usr/bin:/bin',
    SKS_GLOBAL_ROOT: path.join(root, '.sneakoscope-global'),
    SKS_MUTATION_LEDGER_ROOT: path.join(root, 'project'),
    SKS_UPDATE_STATUS_PATH: path.join(root, 'update-status.json'),
    SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: '6.3.0',
    SKS_UPDATE_SKIP_TEMP_INSTALL_SMOKE: '1',
    SKS_UPDATE_SKIP_SKS_MENUBAR: '1',
    SKS_UPDATE_QUIET: '1',
    SKS_TEST_DOCTOR_OK: '1'
  };
  return {
    root,
    options: {
      npmBin,
      currentVersion: '6.2.0',
      version: '6.3.0',
      projectRoot: path.join(root, 'project'),
      env,
      timeoutMs: 5000,
      json: true
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}
