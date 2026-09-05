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
  type SksUpdateNowOptions,
  UPDATE_STAGE_ORDER,
  runSksUpdateNow,
  runSksUpdateReview,
  runSksUpdateRollback
} from '../update-check.js';
import {
  acquireUpdateOperationLock,
  authorizeUpdateRollback,
  buildUpdateRollbackCommand,
  UpdateOperationRecorder,
  updateOperationLastInstallPath
} from '../update/update-operation.js';
import { PACKAGE_VERSION } from '../fsx.js';
import { updateMigrationLockIsStale } from '../update/update-migration-state.js';

test('update review exposes the target, paths, rollback command, and documented stages without mutation', async () => {
  const fixture = await updateFailureFixture('success');
  try {
    const projectRootAlias = path.join(fixture.root, 'project-link');
    await fs.symlink(fixture.options.projectRoot, projectRootAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const review = await runSksUpdateReview({ ...fixture.options, projectRoot: projectRootAlias });
    assert.equal(review.ok, true, review.error || 'review failed');
    assert.equal(review.current, '6.2.0');
    assert.equal(review.target, '6.3.0');
    assert.equal(review.npm_bin, fixture.options.npmBin);
    assert.equal(review.node_path, process.execPath);
    const canonicalProjectRoot = await fs.realpath(fixture.options.projectRoot);
    assert.equal(review.project_root, canonicalProjectRoot);
    assert.equal(
      review.rollback_command,
      buildUpdateRollbackCommand('6.2.0', canonicalProjectRoot, 'https://registry.npmjs.org/')
    );
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

test('an update blocked before receipt creation never advertises rollback', async () => {
  const fixture = await updateFailureFixture('success');
  const lock = await acquireUpdateOperationLock(fixture.options.env);
  assert.equal(lock.ok, true);
  if (!lock.ok) return;
  try {
    const result = await runSksUpdateNow({ ...fixture.options, dryRun: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'update_operation_lock_held');
    assert.equal(result.operation_receipt_path, null);
    assert.equal(result.rollback.available, false);
    assert.equal(result.rollback.receipt_path, null);
  } finally {
    await lock.release();
    await fixture.cleanup();
  }
});

test('already-current update succeeds and carries a bounded guidance warning through migration and operation receipts', async () => {
  const fixture = await updateFailureFixture('success');
  try {
    await createFlatDirectories(fixture.options.projectRoot, 5_001);
    const options = await currentUpdateOptions(fixture);
    const result = await runSksUpdateNow(options);
    assert.equal(result.status, 'current', result.error || result.status);
    const ids = result.stages.map((stage) => stage.id);
    assert.deepEqual(
      [...new Set(ids)].sort(),
      [...UPDATE_STAGE_ORDER].sort(),
      JSON.stringify(result.stages)
    );
    // The Swift Control Center rejects receipts carrying more stages than the
    // declared order, so the receipt must never exceed it.
    const operation = JSON.parse(await fs.readFile(result.operation_receipt_path!, 'utf8'));
    assert.ok(operation.stages.length <= UPDATE_STAGE_ORDER.length, `receipt stages ${operation.stages.length} > ${UPDATE_STAGE_ORDER.length}`);
    assert.ok(result.stages.every((stage) => stage.ok), JSON.stringify(result.stages.filter((stage) => !stage.ok)));
    assert.equal(result.ok, true, result.error || JSON.stringify(result.stages));
    const warning = (result.project_receipt?.optional_warnings || []).find((item) =>
      item.startsWith('current-public-surface-reconcile:guidance_scan_truncated:')
    );
    assert.ok(warning, JSON.stringify(result.project_receipt?.optional_warnings));
    assert.equal(operation.state, 'succeeded');
    const receiptStage = operation.stages.find((stage: any) => stage.id === 'project_receipt');
    assert.ok(receiptStage?.detail?.optional_warnings?.some((item: string) =>
      item.startsWith('current-public-surface-reconcile:guidance_scan_truncated:')
    ), JSON.stringify(receiptStage));
  } finally {
    await fixture.cleanup();
  }
});

test('already-current finalize Doctor preserves structured config-adopt blockers in the operation error', async () => {
  const fixture = await updateFailureFixture('success');
  try {
    const options = await currentUpdateOptions(fixture);
    options.env = {
      ...options.env,
      SKS_TEST_FINALIZE_DOCTOR_USER_CONFIG_PRESERVED: '1'
    };
    const result = await runSksUpdateNow(options);
    assert.equal(result.status, 'failed');
    assert.equal(result.ok, false);
    assert.match(result.error || '', /update_finalize_doctor/);
    const finalizeDoctor = result.stages.find((stage) => stage.id === 'update_finalize_doctor');
    assert.deepEqual(finalizeDoctor?.detail?.required_blockers, [
      'project:user_owned_file_without_sks_marker',
      'user_owned_file_without_sks_marker'
    ]);
    const operation = JSON.parse(await fs.readFile(result.operation_receipt_path!, 'utf8'));
    assert.equal(operation.state, 'failed');
    assert.ok(operation.public_error.includes('/project/.codex/config.toml'), operation.public_error);
    assert.ok(operation.public_error.includes('user_owned_file_without_sks_marker'));
    assert.ok(operation.public_error.includes('# SKS-MANAGED-CODEX-CONFIG'));
    assert.ok(operation.public_error.includes('sks config adopt'));
    assert.doesNotMatch(operation.public_error, /current-version repair verification failed/);
  } finally {
    await fixture.cleanup();
  }
});

test('already-current update rejects a stale doctor receipt even when final health checks pass', async () => {
  const fixture = await updateFailureFixture('success');
  try {
    const options = await currentUpdateOptions(fixture);
    const first = await runSksUpdateNow(options);
    assert.equal(first.ok, true, first.error || JSON.stringify(first.stages));
    const second = await runSksUpdateNow({ ...options, env: { ...options.env, SKS_TEST_DOCTOR_EMIT_MIGRATION_RECEIPT: '0' } });
    assert.equal(second.ok, false);
    assert.equal(second.status, 'failed');
    assert.equal(second.migration_current, false);
    const receiptStage = second.stages.find((stage) => stage.id === 'project_receipt');
    assert.equal(receiptStage?.ok, false);
    assert.equal(receiptStage?.detail?.error, 'new_version_doctor_receipt_missing_or_stale');
    assert.equal(second.rollback.available, false);
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

test('update now refuses a downgrade unless rollback authorization is bound internally', async () => {
  const fixture = await updateFailureFixture('success');
  try {
    const result = await runSksUpdateNow({ ...fixture.options, version: '6.1.0' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'downgrade_requires_authorized_rollback');
    assert.ok(result.stages.some((stage) => stage.id === 'preflight' && stage.status === 'blocked'));
    assert.ok(!result.stages.some((stage) => stage.id === 'global_install'));
  } finally {
    await fixture.cleanup();
  }
});

test('canonical project-root validation refuses a symlink alias to the filesystem root', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX filesystem-root alias proof required');
  const fixture = await updateFailureFixture('success');
  const rootAlias = path.join(fixture.root, 'filesystem-root-link');
  try {
    await fs.symlink(path.parse(fixture.root).root, rootAlias, 'dir');
    await assert.rejects(
      () => runSksUpdateReview({ ...fixture.options, projectRoot: rootAlias }),
      /update_project_root_filesystem_root_refused/
    );
  } finally {
    await fixture.cleanup();
  }
});

test('a live migration lock is never stale solely because its timestamp is old', () => {
  assert.equal(updateMigrationLockIsStale(process.pid, '2020-01-01T00:00:00.000Z'), false);
  assert.equal(updateMigrationLockIsStale(0, new Date().toISOString()), false);
  assert.equal(updateMigrationLockIsStale(0, '2020-01-01T00:00:00.000Z'), true);
});

test('rollback requires the exact previous version from the latest successful update receipt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-rollback-auth-'));
  const env: NodeJS.ProcessEnv = { HOME: root, SKS_GLOBAL_ROOT: path.join(root, '.sneakoscope-global') };
  try {
    const recorder = await UpdateOperationRecorder.create({
      env, kind: 'update', fromVersion: '6.2.0', targetVersion: '6.3.0', projectRoot: root
    });
    recorder.recordStage('global_install', true, 'installed', { code: 0, timed_out: false });
    await recorder.finish({ state: 'succeeded', resultStatus: 'updated' });

    const arbitrary = await runSksUpdateRollback({
      version: '6.1.0', currentVersion: '6.3.0', npmBin: null, env, projectRoot: root
    });
    assert.equal(arbitrary.ok, false);
    assert.equal(arbitrary.update, null);
    assert.equal(arbitrary.error, 'rollback_target_not_previous_version');

    const wrongCurrent = await runSksUpdateRollback({
      version: '6.2.0', currentVersion: '6.4.0', npmBin: null, env, projectRoot: root
    });
    assert.equal(wrongCurrent.ok, false);
    assert.equal(wrongCurrent.error, 'rollback_receipt_not_current_install');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rollback authorization is bound to the registry recorded by the confirmed install', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-rollback-registry-'));
  const env: NodeJS.ProcessEnv = { HOME: root, SKS_GLOBAL_ROOT: path.join(root, '.sneakoscope-global') };
  const registry = 'https://registry.example.test/custom/';
  try {
    const recorder = await UpdateOperationRecorder.create({
      env,
      kind: 'update',
      fromVersion: '6.2.0',
      targetVersion: '6.3.0',
      projectRoot: root,
      registry
    });
    recorder.recordStage('global_install', true, 'installed', { code: 0, timed_out: false });
    await recorder.finish({ state: 'succeeded', resultStatus: 'updated' });
    const authorization = await authorizeUpdateRollback({
      targetVersion: '6.2.0',
      currentVersion: '6.3.0',
      projectRoot: root,
      registry: 'https://registry.npmjs.org/',
      env
    });
    assert.equal(authorization.ok, false);
    if (!authorization.ok) assert.equal(authorization.blocker, 'rollback_receipt_registry_mismatch');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rollback revalidates authorization against the currently observed install before mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-rollback-revalidate-'));
  const projectRoot = path.join(root, 'project');
  const npmBin = path.join(root, 'npm-fixture.mjs');
  const installMarker = path.join(root, 'install-invoked.txt');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    PATH: '/usr/bin:/bin',
    SKS_GLOBAL_ROOT: path.join(root, '.sneakoscope-global'),
    SKS_MUTATION_LEDGER_ROOT: projectRoot,
    SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: '6.4.0',
    SKS_UPDATE_SKIP_TEMP_INSTALL_SMOKE: '1',
    SKS_UPDATE_SKIP_SKS_MENUBAR: '1',
    SKS_UPDATE_QUIET: '1',
    SKS_TEST_DOCTOR_OK: '1'
  };
  try {
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(npmBin, [
      `#!${process.execPath}`,
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'list' && args[1] === '-g') { console.log(JSON.stringify({ dependencies: { sneakoscope: { version: '6.4.0' } } })); process.exit(0); }",
      `if (args[0] === 'root') { console.log(${JSON.stringify(path.join(root, 'node_modules'))}); process.exit(0); }`,
      `if (args[0] === 'install') { fs.writeFileSync(${JSON.stringify(installMarker)}, 'invoked'); process.exit(0); }`,
      "process.exit(2);"
    ].join('\n'));
    await fs.chmod(npmBin, 0o755);
    const recorder = await UpdateOperationRecorder.create({
      env,
      kind: 'update',
      fromVersion: '6.2.0',
      targetVersion: '6.3.0',
      projectRoot
    });
    recorder.recordStage('global_install', true, 'installed', { code: 0, timed_out: false });
    await recorder.finish({ state: 'succeeded', resultStatus: 'updated' });

    const result = await runSksUpdateRollback({
      version: '6.2.0',
      currentVersion: '6.3.0',
      npmBin,
      projectRoot,
      env,
      json: true
    });
    assert.equal(result.ok, false);
    assert.equal(result.update?.error, 'rollback_receipt_not_current_install');
    assert.ok(result.update?.stages.some((stage) => stage.id === 'preflight' && stage.status === 'blocked'));
    await assert.rejects(fs.access(installMarker));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an update re-probes the installed version after the lock boundary and blocks a newly stale target', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-lock-reprobe-'));
  const projectRoot = path.join(root, 'project');
  const npmBin = path.join(root, 'npm-fixture.mjs');
  const stateFile = path.join(root, 'installed-version.txt');
  const installMarker = path.join(root, 'install-invoked.txt');
  const statusPath = path.join(root, 'stale-update-status.json');
  let releaseBoundary!: () => void;
  let reportBoundary!: () => void;
  const atBoundary = new Promise<void>((resolve) => { reportBoundary = resolve; });
  const boundaryRelease = new Promise<void>((resolve) => { releaseBoundary = resolve; });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    PATH: '/usr/bin:/bin',
    SKS_GLOBAL_ROOT: path.join(root, '.sneakoscope-global'),
    SKS_MUTATION_LEDGER_ROOT: projectRoot,
    SKS_UPDATE_STATUS_PATH: statusPath,
    SKS_DISABLE_UPDATE_CHECK: '1',
    SKS_INSTALLED_SKS_VERSION: '9.9.9',
    SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: '6.3.0',
    SKS_UPDATE_SKIP_TEMP_INSTALL_SMOKE: '1',
    SKS_UPDATE_SKIP_SKS_MENUBAR: '1',
    SKS_UPDATE_QUIET: '1',
    SKS_TEST_DOCTOR_OK: '1'
  };
  try {
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(stateFile, '6.2.0\n');
    await fs.writeFile(statusPath, JSON.stringify({
      schema: 'sks.update-status.v3',
      generated_at: '2099-01-01T00:00:00.000Z',
      expires_at: '2099-01-01T01:00:00.000Z',
      source: 'cache',
      sks: {
        installed: true,
        current: '6.2.0',
        latest: '6.3.0',
        update_available: true,
        channel: 'stable',
        package_source: 'stale-test-cache'
      },
      codex_cli: {
        installed: false,
        current: null,
        latest: null,
        update_available: false,
        update_method: null
      },
      menubar: {
        installed: false,
        running: false,
        expected_version: '6.2.0',
        installed_version: null,
        signature_ok: null,
        resources_ok: null,
        rebuild_required: true
      },
      update_count: 1,
      warnings: [],
      public_error: null
    }));
    await fs.writeFile(npmBin, [
      `#!${process.execPath}`,
      "import fs from 'node:fs';",
      `const stateFile = ${JSON.stringify(stateFile)};`,
      'const args = process.argv.slice(2);',
      "if (args[0] === 'list' && args[1] === '-g') { console.log(JSON.stringify({ dependencies: { sneakoscope: { version: fs.readFileSync(stateFile, 'utf8').trim() } } })); process.exit(0); }",
      `if (args[0] === 'root') { console.log(${JSON.stringify(path.join(root, 'node_modules'))}); process.exit(0); }`,
      `if (args[0] === 'install') { fs.writeFileSync(${JSON.stringify(installMarker)}, 'invoked'); process.exit(0); }`,
      'process.exit(2);'
    ].join('\n'));
    await fs.chmod(npmBin, 0o755);

    const update = runSksUpdateNow({
      npmBin,
      currentVersion: '6.2.0',
      version: '6.3.0',
      projectRoot,
      env,
      json: true,
      beforeOperationLock: async () => {
        reportBoundary();
        await boundaryRelease;
      }
    });
    await atBoundary;
    await fs.writeFile(stateFile, '6.4.0\n');
    releaseBoundary();
    const result = await update;

    assert.equal(result.ok, false);
    assert.equal(result.from, '6.4.0');
    assert.equal(result.error, 'downgrade_requires_authorized_rollback');
    assert.ok(result.stages.some((stage) =>
      stage.id === 'preflight'
      && stage.status === 'blocked'
      && stage.detail?.current_version === '6.4.0'
    ));
    await assert.rejects(fs.access(installMarker));
  } finally {
    releaseBoundary?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an update fails closed when the lock-bound installed-version probe has no npm-global or PATH evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-lock-probe-failure-'));
  const projectRoot = path.join(root, 'project');
  const npmBin = path.join(root, 'npm-fixture.mjs');
  const installMarker = path.join(root, 'install-invoked.txt');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    PATH: '/usr/bin:/bin',
    SKS_GLOBAL_ROOT: path.join(root, '.sneakoscope-global'),
    SKS_MUTATION_LEDGER_ROOT: projectRoot,
    SKS_UPDATE_STATUS_PATH: path.join(root, 'update-status.json'),
    SKS_DISABLE_UPDATE_CHECK: '1',
    SKS_INSTALLED_SKS_VERSION: '6.2.0',
    SKS_UPDATE_QUIET: '1'
  };
  try {
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(npmBin, [
      `#!${process.execPath}`,
      "import fs from 'node:fs';",
      'const args = process.argv.slice(2);',
      "if (args[0] === 'list' && args[1] === '-g') { console.error('not installed'); process.exit(1); }",
      `if (args[0] === 'root') { console.log(${JSON.stringify(path.join(root, 'node_modules'))}); process.exit(0); }`,
      `if (args[0] === 'install') { fs.writeFileSync(${JSON.stringify(installMarker)}, 'invoked'); process.exit(0); }`,
      'process.exit(2);'
    ].join('\n'));
    await fs.chmod(npmBin, 0o755);

    const result = await runSksUpdateNow({
      npmBin,
      currentVersion: '6.2.0',
      version: '6.3.0',
      projectRoot,
      env,
      json: true
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'locked_installed_version_probe_failed');
    assert.equal(result.operation_receipt_path, null);
    assert.ok(result.stages.some((stage) =>
      stage.id === 'preflight'
      && stage.status === 'blocked'
      && stage.detail?.reason === 'locked_installed_version_probe_failed'
    ));
    await assert.rejects(fs.access(installMarker));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an update fails closed when npm-global and PATH report different installed versions', async () => {
  const fixture = await updateFailureFixture('success');
  try {
    const result = await runSksUpdateNow({
      ...fixture.options,
      lockedInstalledVersionProbe: async () => ({
        ok: true,
        version: '6.2.0',
        source: 'npm-global',
        npm_global_version: '6.2.0',
        path_version: '6.1.9',
        path_binary: '/fixture/bin/sks',
        errors: []
      })
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'locked_installed_version_probe_failed');
    assert.equal(result.operation_receipt_path, null);
    const preflight = result.stages.find((stage) => stage.id === 'preflight');
    assert.ok(
      Array.isArray(preflight?.detail?.errors)
      && preflight.detail.errors.some((error) => String(error).startsWith('locked_installed_version_authorities_disagree:'))
    );
  } finally {
    await fixture.cleanup();
  }
});

test('the global update lock is released when a late temporary-smoke setup throws', async () => {
  const fixture = await updateFailureFixture('success');
  const previousTmpDir = process.env.TMPDIR;
  const invalidTmpDir = path.join(fixture.root, 'tmp-is-a-file');
  try {
    await fs.writeFile(invalidTmpDir, 'not a directory\n');
    process.env.TMPDIR = invalidTmpDir;
    const env = { ...fixture.options.env };
    delete env.SKS_UPDATE_SKIP_TEMP_INSTALL_SMOKE;

    await assert.rejects(
      runSksUpdateNow({ ...fixture.options, env }),
      (error: any) => error?.code === 'ENOTDIR'
    );

    const recovered = await acquireUpdateOperationLock(env);
    assert.equal(recovered.ok, true);
    if (recovered.ok) await recovered.release();
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
    await fixture.cleanup();
  }
});

test('rollback is bound to the canonical project root and rejects legacy unbound receipts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-rollback-project-root-'));
  const projectRoot = path.join(root, 'project-a');
  const otherProjectRoot = path.join(root, 'project-b');
  const env: NodeJS.ProcessEnv = { HOME: root, SKS_GLOBAL_ROOT: path.join(root, '.sneakoscope-global') };
  try {
    await Promise.all([
      fs.mkdir(projectRoot, { recursive: true }),
      fs.mkdir(otherProjectRoot, { recursive: true })
    ]);
    const recorder = await UpdateOperationRecorder.create({
      env,
      kind: 'update',
      fromVersion: '6.2.0',
      targetVersion: '6.3.0',
      projectRoot
    });
    recorder.recordStage('global_install', true, 'installed', { code: 0, timed_out: false });
    const receipt = await recorder.finish({ state: 'succeeded', resultStatus: 'updated' });

    const mismatch = await authorizeUpdateRollback({
      targetVersion: '6.2.0',
      currentVersion: '6.3.0',
      projectRoot: otherProjectRoot,
      env
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.blocker, 'rollback_receipt_required');

    const legacy = JSON.parse(await fs.readFile(receipt.receipt_path, 'utf8'));
    delete legacy.project_root;
    await fs.writeFile(receipt.receipt_path, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
    await fs.writeFile(updateOperationLastInstallPath(receipt.project_root, env), `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
    const unbound = await authorizeUpdateRollback({
      targetVersion: '6.2.0',
      currentVersion: '6.3.0',
      projectRoot,
      env
    });
    assert.equal(unbound.ok, false);
    if (!unbound.ok) assert.equal(unbound.blocker, 'rollback_receipt_project_unbound');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rollback rejects stale receipts before invoking npm', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-rollback-stale-'));
  const env: NodeJS.ProcessEnv = { HOME: root, SKS_GLOBAL_ROOT: path.join(root, '.sneakoscope-global') };
  try {
    const recorder = await UpdateOperationRecorder.create({
      env, kind: 'update', fromVersion: '6.2.0', targetVersion: '6.3.0', projectRoot: root
    });
    recorder.recordStage('global_install', true, 'installed', { code: 0, timed_out: false });
    const receipt = await recorder.finish({ state: 'succeeded', resultStatus: 'updated' });
    const stale = { ...receipt, updated_at: '2025-01-01T00:00:00.000Z' };
    await fs.writeFile(receipt.receipt_path, `${JSON.stringify(stale, null, 2)}\n`, { mode: 0o600 });
    await fs.writeFile(updateOperationLastInstallPath(receipt.project_root, env), `${JSON.stringify(stale, null, 2)}\n`, { mode: 0o600 });

    const result = await runSksUpdateRollback({
      version: '6.2.0', currentVersion: '6.3.0', npmBin: null, env, projectRoot: root
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
      env, kind: 'update', fromVersion: '6.2.0', targetVersion: '6.3.0', projectRoot: root
    });
    recorder.recordStage('global_install', true, 'installed', { code: 0, timed_out: false });
    const receipt = await recorder.finish({ state: 'succeeded', resultStatus: 'updated' });
    const tampered = JSON.parse(await fs.readFile(receipt.receipt_path, 'utf8'));
    tampered.stages = [{ id: 'global_install', ok: true, status: 'installed', detail: { code: 0, timed_out: false } }];
    await fs.writeFile(receipt.receipt_path, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });

    const authorization = await authorizeUpdateRollback({
      targetVersion: '6.2.0', currentVersion: '6.3.0', projectRoot: root, env
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
      targetVersion: '6.2.0', currentVersion: '6.3.0', projectRoot: fixture.options.projectRoot, env: fixture.options.env
    });
    assert.equal(authorization.ok, false);
    if (!authorization.ok) assert.equal(authorization.blocker, 'rollback_receipt_required');
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
        env, kind: 'update', fromVersion: '6.2.0', targetVersion: '6.3.0', projectRoot: root
      });
      recorder.recordStage('global_install', row.stageOk, row.stageStatus, row.detail);
      if (row.receiptState === 'running') await recorder.flush();
      else await recorder.finish({ state: row.receiptState, resultStatus: row.receiptState });

      const authorization = await authorizeUpdateRollback({
        targetVersion: '6.2.0', currentVersion: '6.3.0', projectRoot: root, env
      });
      assert.equal(authorization.ok, false, `${row.name} install must not authorize rollback`);
      if (!authorization.ok) assert.equal(authorization.blocker, 'rollback_receipt_required');
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
    const canonicalProjectRoot = await fs.realpath(fixture.options.projectRoot);
    assert.equal(result.new_version_doctor?.cwd, canonicalProjectRoot);
    assert.ok(result.new_version_doctor?.args.includes(path.join(
      canonicalProjectRoot,
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
      projectRoot: fixture.options.projectRoot,
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
      "const recorder = await UpdateOperationRecorder.create({ env: process.env, kind: 'update', fromVersion: '6.2.0', targetVersion: '6.3.0', projectRoot: process.cwd() });",
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
    assert.equal(
      receipt.rollback_command,
      buildUpdateRollbackCommand('6.2.0', await fs.realpath(root), 'https://registry.npmjs.org/')
    );
    assert.ok(receipt.stages.some((stage: any) => stage.id === 'global_install' && stage.status === 'started'));
    assert.deepEqual(latest, receipt);
    const authorization = await authorizeUpdateRollback({
      targetVersion: '6.2.0', currentVersion: '6.3.0', projectRoot: root, env: { HOME: root, SKS_GLOBAL_ROOT: globalRoot }
    });
    assert.equal(authorization.ok, false);
    if (!authorization.ok) assert.equal(authorization.blocker, 'rollback_receipt_required');
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
    "if (args[0] === 'list' && args[1] === '-g') { console.log(JSON.stringify({ dependencies: { sneakoscope: { version: process.env.SKS_FAKE_CURRENT_VERSION || '6.2.0' } } })); process.exit(0); }",
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

async function createFlatDirectories(root: string, count: number): Promise<void> {
  const batchSize = 128;
  for (let start = 0; start < count; start += batchSize) {
    await Promise.all(Array.from(
      { length: Math.min(batchSize, count - start) },
      (_, offset) => fs.mkdir(path.join(root, `workspace-${String(start + offset).padStart(5, '0')}`))
    ));
  }
}


async function currentUpdateOptions(fixture: Awaited<ReturnType<typeof updateFailureFixture>>): Promise<SksUpdateNowOptions & { env: NodeJS.ProcessEnv }> {
  const packageRoot = path.join(fixture.root, 'node_modules', 'sneakoscope');
  const entrypoint = path.join(packageRoot, 'dist', 'bin', 'sks.js');
  await fs.mkdir(path.dirname(entrypoint), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'sneakoscope', version: PACKAGE_VERSION, bin: { sks: 'dist/bin/sks.js' } }));
  await fs.writeFile(entrypoint, `#!${process.execPath}\nconsole.log(${JSON.stringify(PACKAGE_VERSION)});\n`, { mode: 0o755 });
  await fs.symlink(entrypoint, path.join(fixture.root, 'sks'));
  return {
    ...fixture.options,
    version: null,
    env: {
      ...fixture.options.env,
      HOME: process.env.HOME,
      PATH: `${fixture.root}${path.delimiter}/usr/bin:/bin`,
      SKS_FAKE_CURRENT_VERSION: PACKAGE_VERSION,
      SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: PACKAGE_VERSION,
      SKS_TEST_DOCTOR_EMIT_MIGRATION_RECEIPT: '1'
    }
  };
}
