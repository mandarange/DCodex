import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  acquireUpdateOperationLock,
  authorizeUpdateRollback,
  buildUpdateRollbackCommand,
  UpdateOperationRecorder,
  updateOperationLastInstallPath,
  updateOperationLatestPath,
  type UpdateOperationReceipt
} from '../update/update-operation.js';

test('Center operation IDs are exact and credential-bearing registries are rejected before receipt creation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-operation-id-'));
  const operationId = '7baaa090-c453-43ac-af05-3b7637382310';
  const projectRoot = path.join(root, 'project');
  try {
    await fs.mkdir(projectRoot, { recursive: true });
    const env = {
      ...process.env,
      HOME: root,
      SKS_GLOBAL_ROOT: path.join(root, 'global'),
      SKS_UPDATE_OPERATION_ID: operationId
    };
    const recorder = await UpdateOperationRecorder.create({
      env,
      fromVersion: '8.0.1',
      targetVersion: '8.0.2',
      projectRoot
    });
    assert.equal((await readReceipt(recorder.receiptPath)).id, operationId);
    assert.equal(path.basename(recorder.receiptPath), `${operationId}.json`);

    for (const registry of [
      'https://user:password@registry.example.test/',
      'https://registry.example.test/?token=secret-value'
    ]) {
      await assert.rejects(
        UpdateOperationRecorder.create({
          env: { ...env, SKS_UPDATE_OPERATION_ID: '' },
          fromVersion: '8.0.1',
          targetVersion: '8.0.2',
          projectRoot,
          registry
        }),
        /update_registry_credentials_forbidden/
      );
    }
    await assert.rejects(
      UpdateOperationRecorder.create({
        env: { ...env, SKS_UPDATE_OPERATION_ID: '' },
        fromVersion: '8.0.1',
        targetVersion: '8.0.2',
        projectRoot,
        registry: 'http://registry.example.test/'
      }),
      /update_registry_https_required/
    );
    await assert.rejects(
      UpdateOperationRecorder.create({
        env: { ...env, SKS_UPDATE_OPERATION_ID: '../escape' },
        fromVersion: '8.0.1',
        targetVersion: '8.0.2',
        projectRoot
      }),
      /update_operation_id_invalid/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('operation receipt atomically tracks latest stage with 0600 permissions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-operation-'));
  const env = { ...process.env, HOME: root, SKS_GLOBAL_ROOT: path.join(root, 'global') };
  const projectRoot = path.join(root, 'project with spaces');
  try {
    await fs.mkdir(projectRoot, { recursive: true });
    const canonicalProjectRoot = await fs.realpath(projectRoot);
    const recorder = await UpdateOperationRecorder.create({
      env,
      fromVersion: '6.2.0',
      targetVersion: '6.3.0',
      projectRoot,
      now: new Date('2026-07-14T05:00:00.000Z')
    });
    assert.equal((await fs.stat(recorder.receiptPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(updateOperationLatestPath(env))).mode & 0o777, 0o600);

    recorder.recordStage('preflight', true, 'ok', { home_path: `${root}/project` });
    recorder.recordStage('preflight', true, 'verified', { token: 'supersecret123456789' });
    recorder.recordStage('global_install', true, 'installed', {
      authorization: 'Bearer hidden-value',
      code: 0,
      timed_out: false
    });
    await recorder.flush();

    const receipt = await readReceipt(recorder.receiptPath);
    assert.equal(receipt.state, 'running');
    assert.equal(receipt.current_stage, 'global_install');
    assert.equal(receipt.side_effects_started, true);
    assert.equal(receipt.stages.filter((stage) => stage.id === 'preflight').length, 1);
    assert.equal(receipt.stages.find((stage) => stage.id === 'preflight')?.status, 'verified');
    assert.equal(receipt.stages.find((stage) => stage.id === 'preflight')?.detail.token, '[redacted]');
    assert.equal(receipt.stages.find((stage) => stage.id === 'global_install')?.detail.authorization, '[redacted]');
    assert.deepEqual(await readReceipt(updateOperationLatestPath(env)), receipt);

    const finished = await recorder.finish({
      state: 'terminal_uncertain',
      resultStatus: 'terminal_uncertain',
      error: new Error('update wrapper failed', {
        cause: new Error(`${root}/npm token=supersecret123456789 timed out`)
      })
    });
    assert.equal(finished.state, 'terminal_uncertain');
    assert.equal(finished.previous_version, '6.2.0');
    assert.equal(finished.project_root, canonicalProjectRoot);
    assert.equal(finished.registry, 'https://registry.npmjs.org/');
    assert.equal(
      finished.rollback_command,
      buildUpdateRollbackCommand('6.2.0', canonicalProjectRoot, 'https://registry.npmjs.org/')
    );
    assert.match(finished.public_error || '', /^~\/npm/);
    assert.doesNotMatch(finished.public_error || '', /update wrapper failed/);
    assert.doesNotMatch(finished.public_error || '', /supersecret/);
    const finalizedBytes = await fs.readFile(recorder.receiptPath, 'utf8');
    assert.throws(
      () => recorder.recordStage('post_finalize_mutation', true, 'unexpected'),
      /update_operation_receipt_finalized/
    );
    await assert.rejects(
      recorder.finish({ state: 'failed', resultStatus: 'mutated_after_finish' }),
      /update_operation_receipt_finalized/
    );
    assert.equal(await fs.readFile(recorder.receiptPath, 'utf8'), finalizedBytes);
    const lastInstallPath = updateOperationLastInstallPath(canonicalProjectRoot, env);
    assert.equal((await fs.stat(lastInstallPath)).mode & 0o777, 0o600);
    assert.equal((await readReceipt(lastInstallPath)).id, finished.id);

    const names = await fs.readdir(path.dirname(recorder.receiptPath));
    assert.ok(names.every((name) => name.endsWith('.json')));
    for (const name of names) await readReceipt(path.join(path.dirname(recorder.receiptPath), name));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('planning and failed attempts cannot shadow the project-bound confirmed install receipt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-last-install-'));
  const env = { ...process.env, HOME: root, SKS_GLOBAL_ROOT: path.join(root, 'global') };
  const projectRoot = path.join(root, 'project');
  try {
    await fs.mkdir(projectRoot, { recursive: true });
    const installed = await UpdateOperationRecorder.create({
      env,
      kind: 'update',
      fromVersion: '6.2.0',
      targetVersion: '6.3.0',
      projectRoot
    });
    installed.recordStage('global_install', true, 'installed', { code: 0, timed_out: false });
    const installedReceipt = await installed.finish({ state: 'succeeded', resultStatus: 'updated' });

    const dryRun = await UpdateOperationRecorder.create({
      env,
      kind: 'update_dry_run',
      fromVersion: '6.3.0',
      targetVersion: '6.4.0',
      projectRoot,
      publishLatest: false
    });
    dryRun.recordStage('global_install', true, 'dry_run');
    await dryRun.finish({ state: 'succeeded', resultStatus: 'dry_run' });

    const failed = await UpdateOperationRecorder.create({
      env,
      kind: 'update',
      fromVersion: '6.3.0',
      targetVersion: '6.4.0',
      projectRoot
    });
    failed.recordStage('global_install', false, 'failed', { code: 7, timed_out: false });
    await failed.finish({ state: 'failed', resultStatus: 'failed' });

    const canonicalProjectRoot = await fs.realpath(projectRoot);
    const preserved = await readReceipt(updateOperationLastInstallPath(canonicalProjectRoot, env));
    assert.equal(preserved.id, installedReceipt.id);
    assert.equal(preserved.target_version, '6.3.0');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('global update lock rejects live overlap and recovers a dead owner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-lock-'));
  const env = { ...process.env, HOME: root, SKS_GLOBAL_ROOT: path.join(root, 'global') };
  try {
    const first = await acquireUpdateOperationLock(env);
    assert.equal(first.ok, true);
    const overlap = await acquireUpdateOperationLock(env);
    assert.deepEqual(overlap, { ok: false, blocker: 'update_operation_lock_held' });
    if (first.ok) await first.release();

    const operations = path.join(env.SKS_GLOBAL_ROOT, 'operations');
    await fs.writeFile(path.join(operations, 'update.lock'), `${JSON.stringify({
      schema: 'sks.update-operation-lock.v1',
      id: 'dead-owner-fixture',
      pid: 2_147_483_647,
      created_at: '2026-07-01T00:00:00.000Z'
    })}\n`, { mode: 0o600 });
    const recovered = await acquireUpdateOperationLock(env);
    assert.equal(recovered.ok, true);
    if (recovered.ok) await recovered.release();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('global update lock gives malformed files a grace period and recovers them atomically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-lock-malformed-'));
  const env = { ...process.env, HOME: root, SKS_GLOBAL_ROOT: path.join(root, 'global') };
  const operations = path.join(env.SKS_GLOBAL_ROOT, 'operations');
  const lockPath = path.join(operations, 'update.lock');
  try {
    await fs.mkdir(operations, { recursive: true });
    await fs.writeFile(lockPath, '', { mode: 0o600 });
    const fresh = await acquireUpdateOperationLock(env);
    assert.deepEqual(fresh, { ok: false, blocker: 'update_operation_lock_held' });

    const stale = new Date(Date.now() - 31_000);
    await fs.utimes(lockPath, stale, stale);
    const recovered = await acquireUpdateOperationLock(env);
    assert.equal(recovered.ok, true);
    if (recovered.ok) await recovered.release();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rollback authorization repairs a missing project pointer from a bounded immutable receipt scan', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-pointer-recovery-'));
  const env = { ...process.env, HOME: root, SKS_GLOBAL_ROOT: path.join(root, 'global') };
  const projectRoot = path.join(root, 'project');
  try {
    await fs.mkdir(projectRoot, { recursive: true });
    const recorder = await UpdateOperationRecorder.create({
      env,
      kind: 'update',
      fromVersion: '8.0.1',
      targetVersion: '8.0.2',
      projectRoot
    });
    recorder.recordStage('global_install', true, 'installed', { code: 0, timed_out: false });
    const receipt = await recorder.finish({ state: 'succeeded', resultStatus: 'updated' });
    const pointer = updateOperationLastInstallPath(receipt.project_root, env);
    await fs.rm(pointer);

    const authorization = await authorizeUpdateRollback({
      targetVersion: '8.0.1',
      currentVersion: '8.0.2',
      projectRoot,
      env,
      repairMissingPointer: true
    });
    assert.equal(authorization.ok, true, authorization.ok ? '' : authorization.blocker);
    assert.equal((await readReceipt(pointer)).id, receipt.id);
    assert.equal((await fs.stat(pointer)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rollback fallback rejects relative project roots and receipts without confirmed side effects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-pointer-strict-recovery-'));
  const env = { ...process.env, HOME: root, SKS_GLOBAL_ROOT: path.join(root, 'global') };
  const cases = [
    {
      name: 'relative-project-root',
      mutate: (receipt: UpdateOperationReceipt) => ({ ...receipt, project_root: '.' })
    },
    {
      name: 'side-effects-not-started',
      mutate: (receipt: UpdateOperationReceipt) => ({ ...receipt, side_effects_started: false })
    }
  ];
  try {
    for (const fixture of cases) {
      const projectRoot = path.join(root, fixture.name);
      await fs.mkdir(projectRoot, { recursive: true });
      const recorder = await UpdateOperationRecorder.create({
        env,
        kind: 'update',
        fromVersion: '8.0.1',
        targetVersion: '8.0.2',
        projectRoot
      });
      recorder.recordStage('global_install', true, 'installed', { code: 0, timed_out: false });
      const receipt = await recorder.finish({ state: 'succeeded', resultStatus: 'updated' });
      const pointer = updateOperationLastInstallPath(receipt.project_root, env);
      await fs.rm(pointer);
      await fs.writeFile(
        receipt.receipt_path,
        `${JSON.stringify(fixture.mutate(receipt), null, 2)}\n`,
        { mode: 0o600 }
      );

      const authorization = await authorizeUpdateRollback({
        targetVersion: '8.0.1',
        currentVersion: '8.0.2',
        projectRoot,
        env,
        repairMissingPointer: true
      });
      assert.equal(authorization.ok, false, fixture.name);
      if (!authorization.ok) assert.equal(authorization.blocker, 'rollback_receipt_required');
      await assert.rejects(fs.stat(pointer));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rollback authorization replaces an older valid pointer with the exact newer immutable receipt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-stale-pointer-recovery-'));
  const env = { ...process.env, HOME: root, SKS_GLOBAL_ROOT: path.join(root, 'global') };
  const projectRoot = path.join(root, 'project');
  try {
    await fs.mkdir(projectRoot, { recursive: true });
    const first = await UpdateOperationRecorder.create({
      env,
      kind: 'update',
      fromVersion: '1.0.0',
      targetVersion: '2.0.0',
      projectRoot
    });
    first.recordStage('global_install', true, 'installed', { code: 0, timed_out: false });
    const firstReceipt = await first.finish({ state: 'succeeded', resultStatus: 'updated' });

    const secondId = '00000000-0000-4000-8000-000000000001';
    const second = await UpdateOperationRecorder.create({
      env: { ...env, SKS_UPDATE_OPERATION_ID: secondId },
      kind: 'update',
      fromVersion: '2.0.0',
      targetVersion: '3.0.0',
      projectRoot
    });
    second.recordStage('global_install', true, 'installed', { code: 0, timed_out: false });
    const secondReceipt = await second.finish({ state: 'succeeded', resultStatus: 'updated' });
    const pointer = updateOperationLastInstallPath(secondReceipt.project_root, env);
    await fs.writeFile(pointer, `${JSON.stringify(firstReceipt, null, 2)}\n`, { mode: 0o600 });

    const operationsDir = path.dirname(pointer);
    const oldDate = new Date('2000-01-01T00:00:00.000Z');
    await Promise.all(Array.from({ length: 300 }, async (_, index) => {
      const suffix = index.toString(16).padStart(12, '0');
      const file = path.join(operationsDir, `ffffffff-ffff-4fff-8fff-${suffix}.json`);
      await fs.writeFile(file, '{}\n', { mode: 0o600 });
      await fs.utimes(file, oldDate, oldDate);
    }));

    const authorization = await authorizeUpdateRollback({
      targetVersion: '2.0.0',
      currentVersion: '3.0.0',
      projectRoot,
      env,
      repairMissingPointer: true
    });
    assert.equal(authorization.ok, true, authorization.ok ? '' : authorization.blocker);
    if (authorization.ok) assert.equal(authorization.receipt.id, secondId);
    assert.equal((await readReceipt(pointer)).id, secondId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rollback operations retain owner-visible previous-version metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-rollback-operation-'));
  const env = { ...process.env, HOME: root, SKS_GLOBAL_ROOT: path.join(root, 'global') };
  const projectRoot = path.join(root, 'project');
  try {
    await fs.mkdir(projectRoot, { recursive: true });
    const canonicalProjectRoot = await fs.realpath(projectRoot);
    const recorder = await UpdateOperationRecorder.create({
      env,
      kind: 'rollback',
      fromVersion: '6.3.0',
      targetVersion: '6.2.0',
      projectRoot
    });
    recorder.recordStage('global_install', true, 'installed_previous');
    const receipt = await recorder.finish({ state: 'rolled_back', resultStatus: 'updated' });
    assert.equal(receipt.kind, 'rollback');
    assert.equal(receipt.state, 'rolled_back');
    assert.equal(receipt.previous_version, '6.3.0');
    assert.equal(receipt.target_version, '6.2.0');
    assert.equal(
      receipt.rollback_command,
      buildUpdateRollbackCommand('6.3.0', canonicalProjectRoot, 'https://registry.npmjs.org/')
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function readReceipt(file: string): Promise<UpdateOperationReceipt> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as UpdateOperationReceipt;
}
