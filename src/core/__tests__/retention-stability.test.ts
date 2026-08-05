import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { applyRetentionPlan, enforceRetention, pruneWikiArtifacts, refreshMissionIndex, sweepSksTempDirs } from '../retention.js';
import { managedSksTmpRoot, readJson, sha256, SKS_TEMP_LEASE_FILE } from '../fsx.js';
import { FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT } from '../routes/constants.js';
import { backdate, makeRoot, quietPolicy, writeJson } from './retention-test-helpers.js';

test('readJson transparently hydrates and verifies legacy retention gzip archives', async () => {
  const root = await makeRoot('sks-retention-legacy-archive-');
  try {
    const mission = path.join(root, '.sneakoscope', 'missions', 'M-legacy-archive');
    const file = path.join(mission, 'agents', 'agent-proof-evidence.json');
    const original = Buffer.from(`${JSON.stringify({ schema: 'fixture.proof.v1', ok: true, rows: [{ id: 'proof' }] })}\n`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.gz`, gzipSync(original));
    await writeJson(file, {
      schema: 'fixture.proof.v1',
      retention_archived: true,
      retention_archive: {
        schema: 'sks.retention-archived-json.v1',
        source_path: 'agents/agent-proof-evidence.json',
        gzip_path: 'agents/agent-proof-evidence.json.gz',
        original_sha256: sha256(original)
      }
    });

    const hydrated = await readJson<any>(file);
    assert.equal(hydrated.schema, 'fixture.proof.v1');
    assert.equal(hydrated.ok, true);
    assert.deepEqual(hydrated.rows, [{ id: 'proof' }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('mission index omits route modes and honors migration-owned exclusions', async () => {
  const root = await makeRoot('sks-retention-current-index-');
  try {
    const missions = path.join(root, '.sneakoscope', 'missions');
    await writeJson(path.join(missions, 'M-current', 'mission.json'), {
      id: 'M-current',
      mode: 'naruto',
      created_at: '2026-07-17T00:00:00.000Z'
    });
    await writeJson(path.join(missions, 'M-retired', 'mission.json'), {
      id: 'M-retired',
      mode: 'team',
      created_at: '2026-07-16T00:00:00.000Z'
    });

    const index = await refreshMissionIndex(root, { excludeMissionIds: ['M-retired'] });
    assert.deepEqual(index.missions.map((row: any) => row.id), ['M-current']);
    const currentRow = index.missions[0];
    assert.ok(currentRow);
    assert.equal(Object.hasOwn(currentRow, 'mode'), false);
    assert.doesNotMatch(JSON.stringify(index), /\bteam\b/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dry-run plans each project temp path once', async () => {
  const root = await makeRoot('sks-retention-temp-dedupe-');
  try {
    const scratch = path.join(root, '.sneakoscope', 'tmp', 'scratch.txt');
    await fs.mkdir(path.dirname(scratch), { recursive: true });
    await fs.writeFile(scratch, 'temporary\n');
    await backdate(scratch);
    const result = await enforceRetention(root, {
      dryRun: true,
      lightweight: true,
      skipStorageReport: true,
      policy: { ...quietPolicy, max_tmp_age_hours: 0 }
    });
    assert.equal(result.actions.filter((action: any) => path.resolve(action.path || '') === path.resolve(scratch)).length, 1);
    assert.equal(result.cleanup.storage_budget.checked, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('exact-hash GC apply persists a verifiable retained proof', async () => {
  const root = await makeRoot('sks-retention-exact-hash-proof-');
  try {
    const planned = await enforceRetention(root, {
      dryRun: true,
      lightweight: true,
      skipStorageReport: true,
      policy: quietPolicy
    });
    const applied = await applyRetentionPlan(root, {
      planHash: planned.plan.plan_hash,
      lightweight: true,
      skipStorageReport: true,
      policy: quietPolicy
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.plan_hash_verified, true);
    assert.equal(applied.expected_plan_hash, planned.plan.plan_hash);
    assert.equal(applied.actual_plan_hash, planned.plan.plan_hash);
    assert.equal(applied.applied_plan_hash, planned.plan.plan_hash);

    const retained = await readJson<any>(path.join(root, '.sneakoscope', 'reports', 'retention-apply.json'));
    assert.equal(retained.plan_hash_verified, true);
    assert.equal(retained.expected_plan_hash, planned.plan.plan_hash);
    assert.equal(retained.applied_plan_hash, planned.plan.plan_hash);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('project temp cleanup uses the newest descendant mtime instead of a stale parent mtime', async () => {
  const root = await makeRoot('sks-retention-temp-descendant-');
  try {
    const scratch = path.join(root, '.sneakoscope', 'tmp', 'stale-parent');
    const nested = path.join(scratch, 'nested');
    const live = path.join(nested, 'live.txt');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(live, 'recent activity\n');
    await backdate(nested);
    await backdate(scratch);

    const retained = await enforceRetention(root, {
      lightweight: true,
      skipStorageReport: true,
      policy: { ...quietPolicy, max_tmp_age_hours: 1 }
    });
    assert.equal(await fs.access(live).then(() => true, () => false), true);
    assert.equal(retained.actions.some((action: any) => action.action === 'remove_tmp' && action.path === scratch), false);

    await backdate(live);
    const removed = await enforceRetention(root, {
      lightweight: true,
      skipStorageReport: true,
      policy: { ...quietPolicy, max_tmp_age_hours: 1 }
    });
    assert.equal(await fs.access(scratch).then(() => true, () => false), false);
    assert.ok(removed.actions.some((action: any) => action.action === 'remove_tmp' && action.path === scratch));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('managed SKS temp cleanup removes stale arbitrary children but retains active, symlink, and foreign top-level paths', async () => {
  const root = await makeRoot('sks-retention-shared-namespace-');
  const isolatedTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-retention-managed-root-'));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = isolatedTmp;
  const shared = managedSksTmpRoot();
  const suffix = `${process.pid}-${path.basename(root)}`;
  const stale = path.join(shared, `sks-canonical-test-crash-${suffix}`);
  const active = path.join(shared, `active-feature-${suffix}`);
  const foreign = path.join(isolatedTmp, `sks-foreign-${suffix}`);
  const foreignFile = path.join(foreign, 'keep.txt');
  const symlink = path.join(shared, `linked-feature-${suffix}`);
  try {
    const staleFile = path.join(stale, 'stale.txt');
    const live = path.join(active, 'nested', 'live.txt');
    await fs.mkdir(stale, { recursive: true });
    await fs.mkdir(path.dirname(live), { recursive: true });
    await fs.mkdir(path.dirname(foreignFile), { recursive: true });
    await fs.writeFile(staleFile, 'orphaned canonical runner scratch\n');
    await fs.writeFile(live, 'recent SKS activity\n');
    await fs.writeFile(foreignFile, 'foreign project\n');
    await fs.symlink(foreign, symlink);
    await backdate(staleFile);
    await backdate(stale);
    await backdate(path.dirname(live));
    await backdate(active);
    await backdate(foreignFile);
    await backdate(foreign);

    const first = await sweepSksTempDirs(root, { maxAgeHours: 1 });
    assert.equal(await fs.access(stale).then(() => true, () => false), false);
    assert.equal(await fs.access(live).then(() => true, () => false), true);
    assert.equal(await fs.access(foreignFile).then(() => true, () => false), true);
    assert.equal(await fs.lstat(symlink).then((stat) => stat.isSymbolicLink(), () => false), true);
    assert.ok(first.actions.some((action: any) => action.action === 'remove_sks_temp' && action.path === stale));
    assert.equal(first.actions.some((action: any) => action.path === foreign), false);
    assert.equal(first.actions.some((action: any) => action.path === symlink), false);

    await backdate(live);
    const result = await sweepSksTempDirs(root, { maxAgeHours: 1 });
    assert.equal(await fs.access(active).then(() => true, () => false), false);
    assert.equal(await fs.access(foreignFile).then(() => true, () => false), true);
    assert.ok(result.actions.some((action: any) => action.action === 'remove_sks_temp' && action.path === active));
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(isolatedTmp, { recursive: true, force: true });
  }
});

test('managed SKS temp cleanup preserves the active environment and live leased scratch while removing stale siblings', async () => {
  const root = await makeRoot('sks-retention-active-temp-');
  const isolatedTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-retention-active-temp-root-'));
  const previousTmpdir = process.env.TMPDIR;
  const previousSksTmpDir = process.env.SKS_TMP_DIR;
  process.env.TMPDIR = isolatedTmp;
  const shared = managedSksTmpRoot();
  const suffix = `${process.pid}-${path.basename(root)}`;
  const active = path.join(shared, `active-environment-${suffix}`);
  const leased = path.join(shared, `active-lease-${suffix}`);
  const stale = path.join(shared, `stale-sibling-${suffix}`);
  try {
    for (const dir of [active, leased, stale]) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'payload.txt'), `${path.basename(dir)}\n`);
      await backdate(path.join(dir, 'payload.txt'));
      await backdate(dir);
    }
    await writeJson(path.join(leased, SKS_TEMP_LEASE_FILE), {
      schema: 'sks.temp-lease.v1',
      kind: 'fixture-live-owner',
      pid: process.pid,
      created_at: new Date().toISOString()
    });
    process.env.SKS_TMP_DIR = active;

    const retained = await sweepSksTempDirs(root, { maxAgeHours: 0 });
    assert.equal(await fs.access(active).then(() => true, () => false), true);
    assert.equal(await fs.access(leased).then(() => true, () => false), true);
    assert.equal(await fs.access(stale).then(() => true, () => false), false);
    assert.ok(retained.actions.some((action: any) => action.action === 'retain_active_sks_temp'
      && action.path === active
      && action.reason === 'active_temp_environment'
      && action.environment_key === 'SKS_TMP_DIR'));
    assert.ok(retained.actions.some((action: any) => action.action === 'retain_active_sks_temp'
      && action.path === leased
      && action.reason === 'active_temp_lease'
      && action.owner_pid === process.pid));

    await writeJson(path.join(leased, SKS_TEMP_LEASE_FILE), {
      schema: 'sks.temp-lease.v1',
      kind: 'fixture-dead-owner',
      pid: 0,
      created_at: new Date(0).toISOString()
    });
    await backdate(path.join(leased, SKS_TEMP_LEASE_FILE));
    await backdate(leased);
    const removed = await sweepSksTempDirs(root, { maxAgeHours: 0 });
    assert.equal(await fs.access(leased).then(() => true, () => false), false);
    assert.ok(removed.actions.some((action: any) => action.action === 'remove_sks_temp' && action.path === leased));
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    if (previousSksTmpDir === undefined) delete process.env.SKS_TMP_DIR;
    else process.env.SKS_TMP_DIR = previousSksTmpDir;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(isolatedTmp, { recursive: true, force: true });
  }
});

test('managed SKS temp cleanup preserves children beneath an active canonical runner lease', async () => {
  const root = await makeRoot('sks-retention-active-runner-root-');
  const isolatedTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-retention-active-runner-tmp-'));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = isolatedTmp;
  const managed = managedSksTmpRoot();
  const fixture = path.join(managed, `active-runner-child-${process.pid}`);
  try {
    await fs.mkdir(fixture, { recursive: true });
    await fs.writeFile(path.join(fixture, 'payload.txt'), 'owned by the active canonical test runner\n');
    await writeJson(path.join(isolatedTmp, SKS_TEMP_LEASE_FILE), {
      schema: 'sks.temp-lease.v1',
      kind: 'canonical-test-runner',
      pid: process.pid,
      created_at: new Date().toISOString()
    });

    const retained = await sweepSksTempDirs(root, { maxAgeHours: 0 });
    assert.equal(await fs.access(fixture).then(() => true, () => false), true);
    assert.ok(retained.actions.some((action: any) => action.action === 'skip_sks_temp_sweep'
      && action.path === managed
      && action.reason === 'active_parent_temp_lease'
      && action.owner_pid === process.pid));

    await fs.rm(path.join(isolatedTmp, SKS_TEMP_LEASE_FILE), { force: true });
    const removed = await sweepSksTempDirs(root, { maxAgeHours: 0 });
    assert.equal(await fs.access(fixture).then(() => true, () => false), false);
    assert.ok(removed.actions.some((action: any) => action.action === 'remove_sks_temp'
      && action.path === fixture));
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(isolatedTmp, { recursive: true, force: true });
  }
});

test('managed SKS temp cleanup removes a dead canonical-test lease without the bounded recursive scan', async () => {
  const root = await makeRoot('sks-retention-dead-canonical-lease-');
  const isolatedTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-retention-dead-canonical-root-'));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = isolatedTmp;
  const target = path.join(managedSksTmpRoot(), `sks-canonical-test-dead-${process.pid}`);
  try {
    let nested = target;
    for (let depth = 0; depth <= 21; depth += 1) nested = path.join(nested, `depth-${depth}`);
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'payload.txt'), 'would exceed the normal temp scan depth\n');
    await writeJson(path.join(target, SKS_TEMP_LEASE_FILE), {
      schema: 'sks.temp-lease.v1',
      kind: 'canonical-test-runner',
      pid: 2_147_483_647,
      created_at: new Date().toISOString()
    });

    const result = await sweepSksTempDirs(root, { maxAgeHours: 0 });
    assert.equal(await fs.access(target).then(() => true, () => false), false);
    assert.ok(result.actions.some((action: any) => action.action === 'remove_sks_temp'
      && action.path === target
      && action.reason === 'dead_canonical_test_lease'));
    assert.equal(result.actions.some((action: any) => action.path === target
      && String(action.reason).includes('temp_path_max_depth_exceeded')), false);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(isolatedTmp, { recursive: true, force: true });
  }
});

test('managed SKS temp cleanup retains a live canonical-test lease', async () => {
  const root = await makeRoot('sks-retention-live-canonical-lease-');
  const isolatedTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-retention-live-canonical-root-'));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = isolatedTmp;
  const target = path.join(managedSksTmpRoot(), `sks-canonical-test-live-${process.pid}`);
  try {
    await fs.mkdir(target, { recursive: true });
    await writeJson(path.join(target, SKS_TEMP_LEASE_FILE), {
      schema: 'sks.temp-lease.v1',
      kind: 'canonical-test-runner',
      pid: process.pid,
      created_at: new Date().toISOString()
    });

    const result = await sweepSksTempDirs(root, { maxAgeHours: 0 });
    assert.equal(await fs.access(target).then(() => true, () => false), true);
    assert.ok(result.actions.some((action: any) => action.action === 'retain_active_sks_temp'
      && action.path === target
      && action.reason === 'active_temp_lease'));
    assert.equal(result.actions.some((action: any) => action.path === target
      && action.reason === 'dead_canonical_test_lease'), false);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(isolatedTmp, { recursive: true, force: true });
  }
});

test('managed SKS temp cleanup leaves malformed and unknown dead leases on the full inspection path', async () => {
  const root = await makeRoot('sks-retention-unknown-canonical-lease-');
  const isolatedTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-retention-unknown-canonical-root-'));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = isolatedTmp;
  const managed = managedSksTmpRoot();
  const malformed = path.join(managed, `sks-canonical-test-malformed-${process.pid}`);
  const unknown = path.join(managed, `sks-canonical-test-unknown-${process.pid}`);
  try {
    for (const target of [malformed, unknown]) {
      let nested = target;
      for (let depth = 0; depth <= 21; depth += 1) nested = path.join(nested, `depth-${depth}`);
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(path.join(nested, 'payload.txt'), 'requires the normal bounded inspection\n');
    }
    await fs.writeFile(path.join(malformed, SKS_TEMP_LEASE_FILE), '{"schema":"sks.temp-lease.v1"\n');
    await writeJson(path.join(unknown, SKS_TEMP_LEASE_FILE), {
      schema: 'sks.temp-lease.v1',
      kind: 'unknown-runner',
      pid: 2_147_483_647,
      created_at: new Date().toISOString()
    });

    const result = await sweepSksTempDirs(root, { maxAgeHours: 0 });
    for (const target of [malformed, unknown]) {
      assert.equal(await fs.access(target).then(() => true, () => false), true);
      assert.ok(result.actions.some((action: any) => action.action === 'skip_unsafe_temp_entry'
        && action.path === target
        && String(action.reason).includes('temp_path_max_depth_exceeded')));
      assert.equal(result.actions.some((action: any) => action.path === target
        && action.reason === 'dead_canonical_test_lease'), false);
    }
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(isolatedTmp, { recursive: true, force: true });
  }
});

test('from-chat-image temp context is retained for active or resumable missions and pruned only after close', async () => {
  const root = await makeRoot('sks-retention-from-chat-context-');
  try {
    const missions = path.join(root, '.sneakoscope', 'missions');
    const fixtures = [
      ['M-20260704-000000-newest', '2026-07-04T00:00:00.000Z'],
      ['M-20260703-000000-active', '2026-07-03T00:00:00.000Z'],
      ['M-20260702-000000-resumable', '2026-07-02T00:00:00.000Z'],
      ['M-20260701-000000-closed', '2026-07-01T00:00:00.000Z']
    ] as const;
    for (const [id, createdAt] of fixtures) {
      await writeJson(path.join(missions, id, 'mission.json'), { id, created_at: createdAt });
    }
    await writeJson(path.join(root, '.sneakoscope', 'state', 'current.json'), {
      mission_id: 'M-20260703-000000-active',
      route_closed: false,
      updated_at: new Date().toISOString()
    });
    await writeJson(path.join(missions, 'M-20260701-000000-closed', 'completion-proof.json'), {
      status: 'verified',
      blockers: []
    });
    for (const id of ['M-20260703-000000-active', 'M-20260702-000000-resumable', 'M-20260701-000000-closed']) {
      await writeJson(path.join(missions, id, FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT), { expires_after_sessions: 1 });
    }

    const result = await enforceRetention(root, {
      fullMissionSweep: true,
      skipStorageReport: true,
      policy: { ...quietPolicy, max_from_chat_img_temp_sessions: 1 }
    });

    for (const id of ['M-20260703-000000-active', 'M-20260702-000000-resumable']) {
      assert.equal(await fs.access(path.join(missions, id, FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT)).then(() => true, () => false), true);
      assert.ok(result.actions.some((action: any) => action.action === 'retain_from_chat_img_temp_triwiki' && action.mission === id));
    }
    assert.equal(await fs.access(path.join(missions, 'M-20260701-000000-closed', FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT)).then(() => true, () => false), false);
    assert.ok(result.actions.some((action: any) => action.action === 'remove_from_chat_img_temp_triwiki' && action.mission === 'M-20260701-000000-closed'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('session-state cap removes only closed or orphaned sessions, never an open mission', async () => {
  const root = await makeRoot('sks-retention-session-cap-');
  try {
    const missions = path.join(root, '.sneakoscope', 'missions');
    await writeJson(path.join(missions, 'M-open', 'mission.json'), { id: 'M-open', phase: 'RUNNING' });
    for (const id of ['M-closed-1', 'M-closed-2']) {
      await writeJson(path.join(missions, id, 'completion-proof.json'), { status: 'verified', blockers: [] });
    }
    const states = path.join(root, '.sneakoscope', 'state', 'sessions');
    await writeJson(path.join(states, 'open.json'), { mission_id: 'M-open', updated_at: '2020-01-01T00:00:00.000Z' });
    await writeJson(path.join(states, 'closed-1.json'), { mission_id: 'M-closed-1', updated_at: '2021-01-01T00:00:00.000Z' });
    await writeJson(path.join(states, 'closed-2.json'), { mission_id: 'M-closed-2', updated_at: '2022-01-01T00:00:00.000Z' });

    await enforceRetention(root, {
      lightweight: true,
      skipStorageReport: true,
      policy: { ...quietPolicy, max_session_state_files: 1 }
    });
    assert.equal(await fs.access(path.join(states, 'open.json')).then(() => true, () => false), true);
    assert.equal(await fs.access(path.join(states, 'closed-1.json')).then(() => true, () => false), false);
    assert.equal(await fs.access(path.join(states, 'closed-2.json')).then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('release logs referenced by the summary remain intact', async () => {
  const root = await makeRoot('sks-retention-release-log-');
  try {
    const log = path.join(root, '.sneakoscope', 'reports', 'release-parallel-logs', 'build.stdout.log');
    await fs.mkdir(path.dirname(log), { recursive: true });
    await fs.writeFile(log, 'proof output\n');
    await writeJson(path.join(root, '.sneakoscope', 'reports', 'release-parallel-report.json'), {
      results: [{ stdout_log: '.sneakoscope/reports/release-parallel-logs/build.stdout.log' }]
    });
    const result = await enforceRetention(root, {
      lightweight: true,
      skipStorageReport: true,
      pruneReportLogs: true,
      policy: quietPolicy
    });
    assert.equal(await fs.access(log).then(() => true, () => false), true);
    assert.ok(result.actions.some((action: any) => action.action === 'skip_disposable_report_log_dir'));
    assert.ok(!result.actions.some((action: any) => action.path === log && String(action.action).startsWith('remove')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('wiki pruning preserves current SSOT ledgers while removing disposable artifacts', async () => {
  const root = await makeRoot('sks-retention-wiki-');
  try {
    const wiki = path.join(root, '.sneakoscope', 'wiki');
    const durable = [
      'context-pack.json', 'code-pack.json', 'code-pack.prev.json', 'wrongness-ledger.json',
      'wrongness-index.json', 'image-assets.json', 'image-voxel-ledger.json', 'visual-anchors.json'
    ];
    for (const name of [...durable, 'stale-cache.json']) {
      const file = path.join(wiki, name);
      await writeJson(file, { schema: `fixture.${name}` });
      await backdate(file);
    }
    await pruneWikiArtifacts(root, {
      policy: { max_wiki_artifact_age_days: 1, max_wiki_artifacts: 0, max_wiki_prune_files: 100, max_wiki_scan_files: 100, min_wiki_trust_score: 0.3 }
    });
    for (const name of durable) assert.equal(await fs.access(path.join(wiki, name)).then(() => true, () => false), true, name);
    assert.equal(await fs.access(path.join(wiki, 'stale-cache.json')).then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('full GC retains an old mission until its close proof exists', async () => {
  const root = await makeRoot('sks-retention-open-mission-');
  try {
    const mission = path.join(root, '.sneakoscope', 'missions', 'M-open-old');
    await writeJson(path.join(mission, 'mission.json'), { id: 'M-open-old', phase: 'RUNNING' });
    await writeJson(path.join(mission, 'request-intake.json'), { prompt: 'durable request context' });
    await writeJson(path.join(mission, 'agents', 'agent-work-queue.json'), { work_items: [{ id: 'derived-runtime' }] });
    await backdate(mission);
    const result = await enforceRetention(root, {
      skipStorageReport: true,
      fullMissionSweep: true,
      policy: { ...quietPolicy, prune_old_missions: true, max_missions: 0, max_mission_age_days: 0 }
    });
    assert.equal(await fs.access(mission).then(() => true, () => false), true);
    assert.equal(await fs.access(path.join(mission, 'request-intake.json')).then(() => true, () => false), true);
    assert.equal(await fs.access(path.join(mission, 'agents', 'agent-work-queue.json')).then(() => true, () => false), false);
    const archive = JSON.parse(await fs.readFile(path.join(mission, 'retention-archive-manifest.json'), 'utf8'));
    assert.equal(archive.durable_context_preserved, true);
    assert.ok(archive.removed_file_count >= 1);
    assert.ok(result.actions.some((action: any) => action.action === 'retain_mission_open_context' && action.mission === 'M-open-old'));
    assert.ok(result.actions.some((action: any) => action.action === 'compact_inactive_open_mission_context' && action.mission === 'M-open-old'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('full GC preserves derived runtime for an old mission with a live session', async () => {
  const root = await makeRoot('sks-retention-old-live-mission-');
  try {
    const mission = path.join(root, '.sneakoscope', 'missions', 'M-open-live');
    await writeJson(path.join(mission, 'mission.json'), { id: 'M-open-live', phase: 'RUNNING' });
    await writeJson(path.join(root, '.sneakoscope', 'state', 'sessions', 'live.json'), {
      mission_id: 'M-open-live',
      route_closed: false,
      updated_at: new Date().toISOString()
    });
    const queue = path.join(mission, 'agents', 'agent-work-queue.json');
    await writeJson(queue, { work_items: [{ id: 'still-running' }] });
    await backdate(mission);

    const result = await enforceRetention(root, {
      skipStorageReport: true,
      fullMissionSweep: true,
      policy: { ...quietPolicy, prune_old_missions: true, max_missions: 0, max_mission_age_days: 0 }
    });

    assert.equal(await fs.access(queue).then(() => true, () => false), true);
    assert.equal(result.actions.some((action: any) => action.action === 'compact_inactive_open_mission_context'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('full GC preserves blocked mission diagnostics even when inactive-open compaction is enabled', async () => {
  const root = await makeRoot('sks-retention-blocked-diagnostics-');
  try {
    const mission = path.join(root, '.sneakoscope', 'missions', 'M-blocked-diagnostics');
    const diagnostics = path.join(mission, 'agents', 'tmp', 'blocked.md');
    const stderr = path.join(mission, 'scout.stderr.log');
    await writeJson(path.join(mission, 'mission.json'), { id: 'M-blocked-diagnostics', created_at: '2020-01-01T00:00:00.000Z' });
    await writeJson(path.join(mission, 'completion-proof.json'), { status: 'blocked', blockers: ['fixture_blocker'] });
    await fs.mkdir(path.dirname(diagnostics), { recursive: true });
    await fs.writeFile(diagnostics, 'diagnostic context\n');
    await fs.writeFile(stderr, 'diagnostic stderr\n');
    await backdate(mission);

    const result = await enforceRetention(root, {
      fullMissionSweep: true,
      skipStorageReport: true,
      policy: {
        ...quietPolicy,
        prune_old_missions: true,
        max_missions: 0,
        max_mission_age_days: 0,
        compact_inactive_open_mission_workdirs: true
      }
    });

    assert.equal(await fs.readFile(diagnostics, 'utf8'), 'diagnostic context\n');
    assert.equal(await fs.readFile(stderr, 'utf8'), 'diagnostic stderr\n');
    assert.ok(result.actions.some((action: any) => action.action === 'retain_mission_blocked_diagnostics' && action.mission === 'M-blocked-diagnostics'));
    assert.equal(result.actions.some((action: any) => action.action === 'compact_inactive_open_mission_context' && action.mission === 'M-blocked-diagnostics'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('full GC preserves diagnostics for a blocked mission gate without a completion proof', async () => {
  const root = await makeRoot('sks-retention-blocked-gate-diagnostics-');
  try {
    const mission = path.join(root, '.sneakoscope', 'missions', 'M-blocked-gate-diagnostics');
    const diagnostics = path.join(mission, 'agents', 'tmp', 'blocked.md');
    const stderr = path.join(mission, 'worker.stderr.log');
    await writeJson(path.join(mission, 'mission.json'), { id: 'M-blocked-gate-diagnostics', created_at: '2020-01-01T00:00:00.000Z' });
    await writeJson(path.join(mission, 'naruto-gate.json'), { status: 'blocked', passed: false, blockers: ['fixture_gate_blocker'] });
    await fs.mkdir(path.dirname(diagnostics), { recursive: true });
    await fs.writeFile(diagnostics, 'blocked gate diagnostic context\n');
    await fs.writeFile(stderr, 'blocked gate diagnostic stderr\n');
    await backdate(mission);

    const result = await enforceRetention(root, {
      fullMissionSweep: true,
      skipStorageReport: true,
      policy: {
        ...quietPolicy,
        prune_old_missions: true,
        max_missions: 0,
        max_mission_age_days: 0,
        compact_inactive_open_mission_workdirs: true
      }
    });

    assert.equal(await fs.readFile(diagnostics, 'utf8'), 'blocked gate diagnostic context\n');
    assert.equal(await fs.readFile(stderr, 'utf8'), 'blocked gate diagnostic stderr\n');
    assert.ok(result.actions.some((action: any) => action.action === 'retain_mission_blocked_diagnostics' && action.mission === 'M-blocked-gate-diagnostics'));
    assert.equal(result.actions.some((action: any) => action.action === 'compact_inactive_open_mission_context' && action.mission === 'M-blocked-gate-diagnostics'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('old closed mission compaction reports raw log deletion as an explicit cleanup action', async () => {
  const root = await makeRoot('sks-retention-closed-raw-log-');
  try {
    const mission = path.join(root, '.sneakoscope', 'missions', 'M-closed-raw-log');
    const log = path.join(mission, 'scout.stderr.log');
    await writeJson(path.join(mission, 'mission.json'), { id: 'M-closed-raw-log', created_at: '2020-01-01T00:00:00.000Z' });
    await writeJson(path.join(mission, 'completion-proof.json'), { status: 'verified', blockers: [] });
    await fs.writeFile(log, 'disposable raw log\n');
    await backdate(mission);

    const result = await enforceRetention(root, {
      fullMissionSweep: true,
      skipStorageReport: true,
      policy: { ...quietPolicy, prune_old_missions: true, max_missions: 0, max_mission_age_days: 0 }
    });

    assert.equal(await fs.access(log).then(() => true, () => false), false);
    assert.ok(result.actions.some((action: any) => action.action === 'remove_closed_mission_raw_log' && action.path === log));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('mission retention order uses creation chronology instead of archive-modified mtime', async () => {
  const root = await makeRoot('sks-retention-chronology-');
  try {
    const missions = path.join(root, '.sneakoscope', 'missions');
    const recent = path.join(missions, 'M-20260102-000000-recent');
    const oldMission = path.join(missions, 'M-20260101-000000-old');
    await writeJson(path.join(recent, 'mission.json'), { id: path.basename(recent), created_at: '2026-01-02T00:00:00.000Z' });
    await writeJson(path.join(recent, 'agents', 'agent-work-queue.json'), { id: 'recent-runtime' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeJson(path.join(oldMission, 'mission.json'), { id: path.basename(oldMission), created_at: '2026-01-01T00:00:00.000Z' });
    await writeJson(path.join(oldMission, 'agents', 'agent-work-queue.json'), { id: 'old-runtime-with-newer-mtime' });

    await enforceRetention(root, {
      fullMissionSweep: true,
      skipStorageReport: true,
      policy: { ...quietPolicy, prune_old_missions: true, max_missions: 1, max_mission_age_days: 999999 }
    });

    assert.equal(await fs.access(path.join(recent, 'agents', 'agent-work-queue.json')).then(() => true, () => false), true);
    assert.equal(await fs.access(path.join(oldMission, 'agents', 'agent-work-queue.json')).then(() => true, () => false), false);
    assert.equal(await fs.access(path.join(oldMission, 'retention-archive-manifest.json')).then(() => true, () => false), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
