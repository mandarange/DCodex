import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { COMMANDS } from '../../dist/cli/command-registry.js';
import { COMMAND_MANIFEST_BY_NAME } from '../../dist/cli/command-manifest-lite.js';
import { ensureCurrentMigrationBeforeCommand } from '../../dist/core/update/update-migration-state.js';
import {
  deferCommandAliasCleanupToMigrationReceipt,
  doctorArgWarnings,
  doctorMenuBarInstallPolicy,
  doctorProfileFromArgs
} from '../../dist/commands/doctor.js';

test('doctor remains executable when migration gate would otherwise block normal commands', async () => {
  assert.equal(COMMANDS.doctor.skipMigrationGate, true);
  const result = await ensureCurrentMigrationBeforeCommand({
    command: 'doctor',
    args: ['--fix', '--yes'],
    cwd: process.cwd(),
    env: { ...process.env, SKS_REQUIRE_UPDATE_MIGRATION_RECEIPT: '1' }
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'skipped');
  assert.equal(result.failed_stage_id, null);
});

test('bootstrap bypasses migration gating in both command manifests so it can create fresh project state', async () => {
  assert.equal(COMMANDS.bootstrap.skipMigrationGate, true);
  assert.equal(COMMAND_MANIFEST_BY_NAME.bootstrap.skipMigrationGate, true);
  const result = await ensureCurrentMigrationBeforeCommand({
    command: 'bootstrap',
    args: ['--json'],
    cwd: process.cwd(),
    env: { ...process.env, SKS_REQUIRE_UPDATE_MIGRATION_RECEIPT: '1' }
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'skipped');
});

test('hooks diagnostics and repair remain available when migration state is stale', async () => {
  assert.equal(COMMANDS.hooks.skipMigrationGate, true);
  assert.equal(COMMAND_MANIFEST_BY_NAME.hooks.skipMigrationGate, true);
  const result = await ensureCurrentMigrationBeforeCommand({
    command: 'hooks',
    args: ['replay', 'fixture.json', '--json'],
    cwd: process.cwd(),
    env: { ...process.env, SKS_REQUIRE_UPDATE_MIGRATION_RECEIPT: '1' }
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'skipped');
});

test('mcp config remains available when migration state is stale', async () => {
  assert.equal(COMMANDS.mcp.skipMigrationGate, true);
  assert.equal(COMMAND_MANIFEST_BY_NAME.mcp.skipMigrationGate, true);
  const result = await ensureCurrentMigrationBeforeCommand({
    command: 'mcp',
    args: ['config', 'list', '--scope', 'global'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      SKS_REQUIRE_UPDATE_MIGRATION_RECEIPT: '1',
      SKS_UPDATE_MIGRATION_GATE_DISABLED: '0'
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'skipped');
  assert.ok(result.warnings.some((warning) => warning === 'skip_migration_gate_command:mcp'));
});

test('doctor consumes migration gate machine flags and validates profile values', () => {
  assert.equal(doctorProfileFromArgs(['--profile', 'migration'], true), 'migration');
  assert.deepEqual(doctorArgWarnings(['--fix', '--yes', '--machine-only', '--report-file', 'out.json', '--profile', 'migration']), []);
  assert.ok(doctorArgWarnings(['--profile', 'bogus']).some((warning) => warning.startsWith('unknown_profile:bogus')));
  assert.ok(doctorArgWarnings(['--not-a-real-flag']).includes('unknown_flag:--not-a-real-flag'));
});

test('migration Doctor never applies or launches the Menu Bar before the update parent reaches its final stage', () => {
  assert.deepEqual(
    doctorMenuBarInstallPolicy(['--fix', '--profile', 'migration'], true, {}),
    { profile: 'migration', phase_enabled: false, apply: false, launch: false }
  );
  assert.deepEqual(
    doctorMenuBarInstallPolicy(['--fix', '--profile', 'fix'], true, {}),
    { profile: 'fix', phase_enabled: true, apply: true, launch: true }
  );
  assert.equal(
    doctorMenuBarInstallPolicy(
      ['--fix', '--profile', 'fix'],
      true,
      { SKS_UPDATE_DEFER_MENUBAR_RESTART: '1' }
    ).launch,
    false
  );
});

test('migration Doctor defers pre-migration public-surface findings to the receipt owner without claiming a repair', () => {
  const result = deferCommandAliasCleanupToMigrationReceipt({
    schema: 'sks.command-alias-cleanup.v1',
    ok: false,
    status: 'blocked',
    fix: false,
    actions: [{ action: 'current_public_surface_reconciliation_required', ok: false }],
    blockers: ['skill_legacy_surface_remaining:5']
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'deferred_to_project_migration_receipt');
  assert.equal(result.repair_owner, 'project_migration_receipt');
  assert.equal(result.fix, false);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.pre_migration_blockers, ['skill_legacy_surface_remaining:5']);
  assert.deepEqual(result.warnings, ['pre_migration_public_surface_findings_deferred:1']);
});

test('doctor --fix reports a real migration receipt result instead of hard-coded current state', () => {
  const source = fs.readFileSync('dist/commands/doctor.js', 'utf8');
  assert.doesNotMatch(source, /manual_update_commands_only/);
  assert.doesNotMatch(source, /migration_current:\s*true/);
  assert.match(source, /writeProjectUpdateMigrationReceipt/);
  assert.match(source, /inspectCommandAliasCleanup\(doctorFix\s*&&\s*!migrationReceiptOwnsReconcile\)/);
  assert.match(source, /deferCommandAliasCleanupToMigrationReceipt\(commandAliasCleanup\)/);
  assert.match(source, /commandAliasCleanup\s*=\s*await inspectCommandAliasCleanup\(false\)/);
  assert.match(source, /doctor_fix_wrote_current_project_migration_receipt/);
  assert.match(source, /doctor_fix_migration_receipt_failed/);
  assert.ok(
    source.indexOf('commandAliasCleanup = await inspectCommandAliasCleanup(false)') <
      source.indexOf('const receipt = await writeProjectUpdateMigrationReceipt(receiptInput)'),
    'the final public-surface postcheck must run before the migration receipt is published'
  );
});

test('non-SKS repositories skip project migration for the official DFix lifecycle', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-dfix-non-project-gate-'));
  const previousGlobalRoot = process.env.SKS_GLOBAL_ROOT;
  try {
    process.env.SKS_GLOBAL_ROOT = path.join(root, 'global');
    await fsp.mkdir(path.join(root, '.git'), { recursive: true });
    await fsp.mkdir(path.join(root, '.codex'), { recursive: true });
    await fsp.writeFile(path.join(root, '.codex', 'config.toml'), 'user_config = true\n');
    await fsp.mkdir(path.join(root, '.sneakoscope', 'update'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sneakoscope', 'update', 'migration-receipt.json'), '{"status":"blocked"}\n');

    const result = await ensureCurrentMigrationBeforeCommand({
      command: 'dfix',
      args: ['diagnose', 'test task'],
      cwd: root,
      env: {
        ...process.env,
        SKS_UPDATE_MIGRATION_GATE_DISABLED: '0',
        SKS_REQUIRE_UPDATE_MIGRATION_RECEIPT: '1',
        SKS_TEST_DOCTOR_FAIL: '1'
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'skipped');
    assert.equal(result.doctor, null);
    assert.equal(result.receipt, null);
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.warnings, ['non_sks_workspace_migration_gate_skipped']);
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'update', 'doctor-migration.json')));
  } finally {
    restoreEnv('SKS_GLOBAL_ROOT', previousGlobalRoot);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Naruto migration gate continues when doctor only preserved a user-owned project config', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-user-config-gate-'));
  const previous = {
    home: process.env.HOME,
    codexHome: process.env.CODEX_HOME,
    globalRoot: process.env.SKS_GLOBAL_ROOT
  };
  try {
    process.env.HOME = path.join(root, 'home');
    process.env.CODEX_HOME = path.join(root, 'home', '.codex');
    process.env.SKS_GLOBAL_ROOT = path.join(root, 'global');
    await fsp.mkdir(process.env.HOME, { recursive: true });
    await fsp.mkdir(path.join(root, '.sneakoscope'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sneakoscope', 'manifest.json'), '{}\n');

    const result = await ensureCurrentMigrationBeforeCommand({
      command: 'naruto',
      args: ['run', 'test task'],
      cwd: root,
      env: {
        ...process.env,
        SKS_UPDATE_MIGRATION_GATE_DISABLED: '0',
        SKS_REQUIRE_UPDATE_MIGRATION_RECEIPT: '1',
        SKS_TEST_DOCTOR_USER_CONFIG_PRESERVED: '1',
        SKS_UPDATE_RETENTION_CLEANUP: '0'
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'repaired');
    assert.equal(result.failed_stage_id, null);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.doctor?.ok, false);
    assert.equal(result.receipt?.status, 'current');
    assert.equal(result.receipt?.source, 'doctor-migration');
    assert.deepEqual(result.receipt?.required_blockers, []);
    assert.ok(result.warnings.includes('migration_doctor_preserved_user_owned_project_config'));
    assert.ok(result.warnings.includes('migration_optional_blocker:user_owned_file_without_sks_marker'));
    const receiptFiles = await fsp.readdir(path.join(root, '.sneakoscope', 'update'));
    assert.deepEqual(
      receiptFiles.filter((name) => name.startsWith('migration-receipt.json.')),
      [],
      'the first-command gate must consume the Doctor-owned receipt without rotating a second receipt'
    );
  } finally {
    restoreEnv('HOME', previous.home);
    restoreEnv('CODEX_HOME', previous.codexHome);
    restoreEnv('SKS_GLOBAL_ROOT', previous.globalRoot);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
