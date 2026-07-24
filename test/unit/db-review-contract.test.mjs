import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DB_MANUAL_FORWARD_MARKER,
  DB_MANUAL_MIGRATION_ARTIFACT,
  DB_MANUAL_MIGRATION_HEADER,
  DB_MANUAL_ROLLBACK_MARKER,
  scanDbAccessCandidates,
  validateDbReview,
  validateMadSksSqlPlaneCompletion,
  validateManualMigrationArtifact
} from '../../dist/core/db-review.js';
import { checkDbOperation } from '../../dist/core/db-safety.js';
import { prepareRoute } from '../../dist/core/pipeline-internals/runtime-core.js';
import { evaluateStop, projectGateStatus } from '../../dist/core/pipeline-internals/runtime-gates.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixtureRoot(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `sks-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function missionDir(root, missionId) {
  return path.join(root, '.sneakoscope', 'missions', missionId);
}

function manualMigrationSql({
  forward = 'CREATE TABLE audit_events (id bigint PRIMARY KEY);',
  rollback = 'DROP TABLE audit_events;'
} = {}) {
  return [
    DB_MANUAL_MIGRATION_HEADER,
    DB_MANUAL_FORWARD_MARKER,
    forward,
    DB_MANUAL_ROLLBACK_MARKER,
    '/*',
    rollback,
    '*/',
    ''
  ].join('\n');
}

function manualMigrationReview(content, overrides = {}) {
  return {
    path: DB_MANUAL_MIGRATION_ARTIFACT,
    sha256: `sha256:${sha256(content)}`,
    manual_apply_required: true,
    rollback_inactive_by_default: true,
    forward_validation: true,
    rollback_validation: true,
    transaction_strategy: {
      reviewed: true,
      strategy: 'single_transaction',
      summary: 'The forward DDL can run in one transaction.'
    },
    migration_order_and_prerequisites: {
      reviewed: true,
      summary: 'No prerequisite schema objects are required.'
    },
    lock_and_rollout_review: {
      reviewed: true,
      summary: 'New-table creation has a bounded catalog lock.'
    },
    rls_and_grants_review: {
      reviewed: true,
      summary: 'No grants or RLS policy changes are included.'
    },
    ...overrides
  };
}

async function writeManualMigration(root, missionId, content) {
  const dir = missionDir(root, missionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, DB_MANUAL_MIGRATION_ARTIFACT), content);
  return dir;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('manual migration accepts active CREATE TABLE forward SQL and an inactive matching DROP TABLE rollback', async (t) => {
  const root = await fixtureRoot(t, 'db-manual-valid');
  const missionId = 'M-db-manual-valid';
  const content = manualMigrationSql();
  await writeManualMigration(root, missionId, content);

  const result = await validateManualMigrationArtifact(root, missionId, manualMigrationReview(content));

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.forward_classification.level, 'write');
  assert.ok(result.forward_classification.reasons.includes('schema_change'));
  assert.equal(result.rollback_classification.level, 'destructive');
  assert.ok(result.rollback_classification.reasons.includes('drop_table'));
});

test('manual migration rejects an active rollback section', async (t) => {
  const root = await fixtureRoot(t, 'db-manual-active-rollback');
  const missionId = 'M-db-manual-active-rollback';
  const content = [
    DB_MANUAL_MIGRATION_HEADER,
    DB_MANUAL_FORWARD_MARKER,
    'CREATE TABLE audit_events (id bigint PRIMARY KEY);',
    DB_MANUAL_ROLLBACK_MARKER,
    'DROP TABLE audit_events;',
    ''
  ].join('\n');
  await writeManualMigration(root, missionId, content);

  const result = await validateManualMigrationArtifact(root, missionId, manualMigrationReview(content));

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('rollback_sql_inactive_block'));
});

test('manual migration rejects a digest mismatch', async (t) => {
  const root = await fixtureRoot(t, 'db-manual-digest');
  const missionId = 'M-db-manual-digest';
  const content = manualMigrationSql();
  await writeManualMigration(root, missionId, content);

  const result = await validateManualMigrationArtifact(root, missionId, manualMigrationReview(content, {
    sha256: `sha256:${'0'.repeat(64)}`
  }));

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('sha256'));
});

test('manual migration rejects path escape, SQL symlinks, and multiple SQL artifacts', async (t) => {
  await t.test('path escape', async (subtest) => {
    const root = await fixtureRoot(subtest, 'db-manual-path');
    const missionId = 'M-db-manual-path';
    const content = manualMigrationSql();
    await fs.mkdir(missionDir(root, missionId), { recursive: true });

    const result = await validateManualMigrationArtifact(root, missionId, manualMigrationReview(content, {
      path: '../manual-migration.sql'
    }));

    assert.equal(result.ok, false);
    assert.deepEqual(result.blockers, ['path']);
  });

  await t.test('SQL symlink', async (subtest) => {
    const root = await fixtureRoot(subtest, 'db-manual-symlink');
    const missionId = 'M-db-manual-symlink';
    const content = manualMigrationSql();
    const dir = missionDir(root, missionId);
    const outside = path.join(root, 'outside.sql');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(outside, content);
    await fs.symlink(outside, path.join(dir, DB_MANUAL_MIGRATION_ARTIFACT));

    const result = await validateManualMigrationArtifact(root, missionId, manualMigrationReview(content));

    assert.equal(result.ok, false);
    assert.ok(result.blockers.includes('file_missing_or_symlink'));
  });

  await t.test('multiple SQL artifacts', async (subtest) => {
    const root = await fixtureRoot(subtest, 'db-manual-multiple');
    const missionId = 'M-db-manual-multiple';
    const content = manualMigrationSql();
    const dir = await writeManualMigration(root, missionId, content);
    await fs.mkdir(path.join(dir, 'nested'), { recursive: true });
    await fs.writeFile(path.join(dir, 'nested', 'extra.sql'), 'SELECT 1;\n');

    const result = await validateManualMigrationArtifact(root, missionId, manualMigrationReview(content));

    assert.equal(result.ok, false);
    assert.ok(result.blockers.includes('exactly_one_sql_file'));
  });
});

test('manual migration rejects placeholders and embedded connection secrets', async (t) => {
  for (const [name, forward] of [
    ['placeholder', 'CREATE TABLE audit_events (id bigint /* TODO */ PRIMARY KEY);'],
    ['secret', 'CREATE TABLE audit_events (id bigint /* postgresql://user:password@example.test/db */ PRIMARY KEY);']
  ]) {
    await t.test(name, async (subtest) => {
      const root = await fixtureRoot(subtest, `db-manual-${name}`);
      const missionId = `M-db-manual-${name}`;
      const content = manualMigrationSql({ forward });
      await writeManualMigration(root, missionId, content);

      const result = await validateManualMigrationArtifact(root, missionId, manualMigrationReview(content));

      assert.equal(result.ok, false);
      assert.ok(result.blockers.includes('placeholder_secret_or_connection_string'));
    });
  }
});

test('manual migration rejects catastrophic forward SQL', async (t) => {
  const root = await fixtureRoot(t, 'db-manual-catastrophic');
  const missionId = 'M-db-manual-catastrophic';
  const content = manualMigrationSql({
    forward: 'DROP TABLE existing_accounts;',
    rollback: 'CREATE TABLE existing_accounts (id bigint PRIMARY KEY);'
  });
  await writeManualMigration(root, missionId, content);

  const result = await validateManualMigrationArtifact(root, missionId, manualMigrationReview(content));

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('forward_catastrophic:drop_table'));
});

test('a bare passed DB review is rejected by both the contract validator and runtime gate', async (t) => {
  const root = await fixtureRoot(t, 'db-review-bare');
  const missionId = 'M-db-review-bare';
  const dir = missionDir(root, missionId);
  await writeJson(path.join(dir, 'db-review.json'), { passed: true });

  const direct = await validateDbReview(root, missionId, { passed: true });
  assert.equal(direct.ok, false);
  assert.ok(direct.blockers.includes('schema'));
  assert.ok(direct.blockers.includes('migration_mode'));

  const status = await projectGateStatus(root, {
    mission_id: missionId,
    mode: 'DB',
    stop_gate: 'db-review.json'
  });
  const gate = status.gates.find((candidate) => candidate.id === 'db-review.json');
  assert.equal(gate?.ok, false);
  assert.ok(gate?.missing.includes('db-review.json:schema'));
});

test('ordinary mad_sks_active state cannot authorize a write without a bound capability v2', async (t) => {
  const root = await fixtureRoot(t, 'db-mad-sks-unbound');
  const missionId = 'M-db-mad-sks-unbound';
  await fs.mkdir(missionDir(root, missionId), { recursive: true });

  const decision = await checkDbOperation(root, {
    mission_id: missionId,
    mode: 'MADSKS',
    mad_sks_active: true
  }, {
    tool_name: 'supabase.execute_sql',
    tool_call_id: 'unbound-write',
    sql: 'INSERT INTO audit_log (id) VALUES (1);'
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.action, 'block');
  assert.ok(decision.reasons.includes('mad_sks_sql_plane_capability_v2_required'));
});

test('DB candidate scanning ignores transaction-only helpers without a real DB entry point or query call', async (t) => {
  const root = await fixtureRoot(t, 'db-transaction-only');
  await fs.mkdir(path.join(root, 'src', 'sql-plane'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'sql-plane', 'transaction-helper.ts'), [
    'export async function runInTransaction(work) {',
    '  return work();',
    '}',
    ''
  ].join('\n'));

  const scan = await scanDbAccessCandidates(root);

  assert.equal(scan.candidate_count, 0);
  assert.deepEqual(scan.candidates, []);
});

test('$DB combined with explicit $MAD-SKS routes directly to a bound capability-v2 SQL-plane', async (t) => {
  const root = await fixtureRoot(t, 'db-mad-sks-route');
  const previousProjectRef = process.env.SKS_MAD_SKS_SQL_PLANE_PROJECT_REF;
  process.env.SKS_MAD_SKS_SQL_PLANE_PROJECT_REF = 'db-mad-sks-route';
  t.after(() => {
    if (previousProjectRef === undefined) delete process.env.SKS_MAD_SKS_SQL_PLANE_PROJECT_REF;
    else process.env.SKS_MAD_SKS_SQL_PLANE_PROJECT_REF = previousProjectRef;
  });

  const prepared = await prepareRoute(root, '$DB apply this migration $MAD-SKS', {}, {
    sessionKey: 'db-mad-sks-route'
  });
  const missionId = String(prepared?.mission_id || '');
  const dir = missionDir(root, missionId);
  const capability = JSON.parse(await fs.readFile(path.join(dir, 'mad-sks', 'sql-plane', 'capability.json'), 'utf8'));
  const gate = JSON.parse(await fs.readFile(path.join(dir, 'mad-sks-gate.json'), 'utf8'));

  assert.equal(prepared?.route?.id, 'MadSKS');
  assert.equal(capability.schema, 'sks.mad-sks-sql-plane-capability.v2');
  assert.equal(capability.mission_id, missionId);
  assert.equal(gate.sql_plane.requested, true);
  assert.equal(gate.control_plane_denied, true);
  assert.match(String(prepared?.additionalContext || ''), /execute the requested SQL immediately through the bound MCP SQL-plane/i);
  await assert.rejects(fs.access(path.join(dir, DB_MANUAL_MIGRATION_ARTIFACT)));
});

test('newer Context7 evidence resolves a stale compliance-loop hard blocker', async (t) => {
  const root = await fixtureRoot(t, 'context7-recovery');
  const missionId = 'M-context7-recovery';
  const dir = missionDir(root, missionId);
  await writeJson(path.join(dir, 'hard-blocker.json'), {
    schema: 'sks.hard-blocker.v1',
    passed: false,
    status: 'hard_blocked',
    created_at: '2026-07-24T00:00:00.000Z',
    reason: 'compliance_loop_guard_tripped',
    gate: 'context7-evidence',
    evidence: ['context7 evidence was missing']
  });
  await writeJson(path.join(dir, 'compliance-loop-guard.json'), {
    schema_version: 1,
    updated_at: '2026-07-24T00:00:00.000Z',
    mission_id: missionId,
    gate: 'context7-evidence',
    tripped: true
  });
  await fs.writeFile(path.join(dir, 'context7-evidence.jsonl'), [
    JSON.stringify({ stage: 'resolve-library-id' }),
    JSON.stringify({ stage: 'get-library-docs' }),
    ''
  ].join('\n'));

  const decision = await evaluateStop(root, {
    mission_id: missionId,
    route: 'SKS',
    route_command: '$SKS',
    mode: 'SKS',
    stop_gate: 'none',
    context7_required: true,
    reflection_required: false,
    proof_required: false
  }, { message: 'done' });

  assert.equal(decision, null);
  await assert.rejects(fs.access(path.join(dir, 'hard-blocker.json')));
  await assert.rejects(fs.access(path.join(dir, 'compliance-loop-guard.json')));
  const resolved = JSON.parse(await fs.readFile(path.join(dir, 'hard-blocker.resolved.json'), 'utf8'));
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.recovery_artifact, 'context7-evidence.jsonl');
});

test('MAD-SKS completion rejects independent read-back and capability binding mismatches', async (t) => {
  const root = await fixtureRoot(t, 'db-mad-sks-completion');
  const missionId = 'M-db-mad-sks-completion';
  const cycleId = 'cycle-1';
  const dir = path.join(missionDir(root, missionId), 'mad-sks', 'sql-plane');
  const runtimeDir = path.join(dir, 'runtime');
  const declared = {
    capability_schema: 'sks.mad-sks-sql-plane-capability.v2',
    result_file: 'mad-sks/sql-plane/result.json',
    cycle_id: cycleId,
    read_back_passed: true,
    capability_closed: true,
    read_only_restored: true
  };
  const resultArtifact = {
    schema: 'sks.mad-sks-sql-plane-cycle-result.v1',
    mission_id: missionId,
    cycle_id: cycleId,
    ok: true,
    execution: { ok: true },
    read_back: { ok: true },
    capability_closed: true,
    read_only_restoration: { ok: true }
  };
  const capabilityArtifact = {
    schema: 'sks.mad-sks-sql-plane-capability.v2',
    mission_id: missionId,
    cycle_id: cycleId,
    status: 'closed',
    closed_at: '2026-07-24T00:00:00.000Z',
    transport: { profile_sha256: 'profile-sha256' }
  };
  await writeJson(path.join(dir, 'result.json'), resultArtifact);
  await writeJson(path.join(dir, 'capability.json'), capabilityArtifact);
  await writeJson(path.join(dir, 'capability.closed.json'), {
    schema: 'sks.mad-sks-sql-plane-capability.v2',
    mission_id: missionId,
    cycle_id: cycleId
  });
  await writeJson(path.join(runtimeDir, 'runtime-profile-manifest.json'), {
    schema: 'sks.mad-sks-sql-plane-runtime-profile.v1',
    mission_id: missionId,
    cycle_id: cycleId,
    profile_sha256: 'profile-sha256'
  });
  await writeJson(path.join(runtimeDir, 'read-only-restoration.json'), {
    schema: 'sks.mad-sks-sql-plane-read-only-restoration.v1',
    ok: true,
    runtime_profile_exists: false
  });

  const valid = await validateMadSksSqlPlaneCompletion(root, missionId, declared);
  assert.equal(valid.ok, true);

  await writeJson(path.join(dir, 'result.json'), {
    ...resultArtifact,
    read_back: { ok: false }
  });
  const readBackMismatch = await validateMadSksSqlPlaneCompletion(root, missionId, declared);
  assert.equal(readBackMismatch.ok, false);
  assert.ok(readBackMismatch.blockers.includes('independent_read_back'));

  await writeJson(path.join(dir, 'result.json'), resultArtifact);
  await writeJson(path.join(dir, 'capability.json'), {
    ...capabilityArtifact,
    cycle_id: 'different-cycle'
  });
  const capabilityMismatch = await validateMadSksSqlPlaneCompletion(root, missionId, declared);
  assert.equal(capabilityMismatch.ok, false);
  assert.ok(capabilityMismatch.blockers.includes('capability_artifact_closed_binding'));
});
