import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeDoctorGlobalOnlyFix } from '../doctor.js';
import { PACKAGE_VERSION } from '../../core/version.js';
import {
  isUpdateMigrationReceiptCurrent,
  projectUpdateMigrationReceiptPath
} from '../../core/update/update-migration-state.js';

function bridgeStatus(input: { ready?: boolean; blockers?: string[]; recovery?: string[] } = {}) {
  const ready = input.ready ?? true;
  return {
    schema: 'sks.desktop-bridge-status.v3',
    checked_at: new Date().toISOString(),
    management: { managed: true },
    providers: {
      'codex-lb': {
        provider_id: 'codex-lb',
        enabled: true,
        credential: { state: 'ready', source: 'provider-store', blockers: [], warnings: [] },
        endpoint: { configured: true, origin_redacted: 'https://gateway.example', auth_transport: 'authorization-bearer' }
      },
      openrouter: {
        provider_id: 'openrouter',
        enabled: false,
        credential: { state: 'absent', source: null, blockers: [], warnings: [] },
        endpoint: { configured: false, origin_redacted: null, auth_transport: null }
      }
    },
    readiness: {
      ready,
      state: ready ? 'ready' : 'blocked',
      blockers: ready ? [] : (input.blockers || ['codex_lb_catalog_stale']),
      warnings: []
    },
    recovery_actions: ready ? [] : (input.recovery || ['retry_catalog_sync'])
  };
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    reconcileSkillsImpl: async () => ({ schema: 'sks.skill-reconcile.v1', scope: 'global', core_skill_integrity: { ok: true } }),
    runDoctorCommandAliasCleanupImpl: async () => ({ ok: true, blockers: [] }),
    ensureGlobalCodexFastModeDuringInstallImpl: async () => ({ status: 'current', ok: true }),
    installSksMenuBarImpl: async () => ({ schema: 'sks.codex-app-sks-menubar.v1', ok: true, status: 'installed_launch_skipped', blockers: [], warnings: [] }),
    ...overrides
  };
}

// Field defect (9.0.2 -> 9.0.5): `cd ~ && sks doctor --fix` printed
// "blocker: codex_lb_catalog_stale — retry_catalog_sync" on every run because
// the global-only route only READ the bridge status and never ran the repair
// that clears it. The repair must run, and the reported status must be the
// post-repair snapshot.
test('global-only fix runs the bridge repair before reading the reported status', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-global-fix-bridge-repair-'));
  const calls: string[] = [];
  try {
    const result: any = await executeDoctorGlobalOnlyFix(['--fix', '--global-only', '--json'], home, {
      ...baseDeps(),
      home,
      desktopBridgeRepairImpl: async (input: any) => {
        calls.push('repair');
        assert.equal(input.fix, true);
        return {
          id: 'desktop_bridge_catalog_repair',
          ok: true,
          repaired: true,
          required_for_ready: false,
          manual_required: false,
          warnings: ['catalog_sync_attempt_1:still_stale:codex_lb_catalog_stale'],
          blockers: [],
          rollback_evidence: 'combined_catalog_previous_generation_preserved'
        };
      },
      // The status impl models the world AFTER a successful repair: the stale
      // blocker is gone. Reading it before the repair (the 9.0.2 regression)
      // would have returned the stale snapshot instead.
      desktopBridgeStatusImpl: async () => {
        calls.push('status');
        return bridgeStatus({ ready: true });
      }
    });

    assert.deepEqual(calls, ['repair', 'status'], 'repair must run exactly once, before the one reported status read');
    assert.equal(result.ok, true, JSON.stringify(result.blockers));
    assert.equal(result.desktop_bridge_repair.repaired, true);
    assert.equal(result.desktop_bridge.ok, true);
    assert.deepEqual(result.blockers, []);
    assert.ok(
      !result.blockers.includes('codex_lb_catalog_stale'),
      'a successful repair must clear the catalog blocker from the report'
    );
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('a failed bridge repair keeps the blocker and its remedy', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-global-fix-bridge-repair-fail-'));
  try {
    const result: any = await executeDoctorGlobalOnlyFix(['--fix', '--global-only', '--json'], home, {
      ...baseDeps(),
      home,
      desktopBridgeRepairImpl: async () => ({
        id: 'desktop_bridge_catalog_repair',
        ok: false,
        repaired: false,
        required_for_ready: false,
        manual_required: false,
        warnings: [],
        blockers: ['desktop_bridge_catalog_still_stale_after_repair', 'catalog_sync_attempt_1:failed'],
        rollback_evidence: 'combined_catalog_previous_generation_preserved'
      }),
      desktopBridgeStatusImpl: async () => bridgeStatus({ ready: false, blockers: ['codex_lb_catalog_stale'], recovery: ['retry_catalog_sync'] })
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.ok(result.blockers.includes('codex_lb_catalog_stale'), JSON.stringify(result.blockers));
    assert.ok(result.blockers.includes('desktop_bridge_catalog_still_stale_after_repair'), JSON.stringify(result.blockers));
    assert.ok(result.next_actions.includes('retry_catalog_sync'), JSON.stringify(result.next_actions));
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

// `sks update` from a non-project directory (home) runs its new-version doctor
// as `doctor --fix --profile migration` there, which 9.0.2 routes to the
// global-only fix. The update's `project_receipt` stage verifies the migration
// receipt that doctor writes — so the global-only migration run must write a
// home-rooted receipt the update can accept, with the migration stages
// (including the desktop-bridge rows) recorded in it.
test('global-only migration doctor writes a home-scoped receipt the update flow accepts', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-global-migration-receipt-'));
  const home = await fsp.realpath(fixture);
  const previousHome = process.env.HOME;
  const previousGlobalRoot = process.env.SKS_GLOBAL_ROOT;
  let menuCalls = 0;
  try {
    // The receipt's migration stages resolve HOME/globalSksRoot from the
    // process environment; scope every write into the fixture explicitly.
    process.env.HOME = home;
    process.env.SKS_GLOBAL_ROOT = path.join(home, '.sneakoscope-global');
    const result: any = await executeDoctorGlobalOnlyFix(
      ['--fix', '--yes', '--profile', 'migration', '--machine-only'],
      home,
      {
        ...baseDeps({
          installSksMenuBarImpl: async () => {
            menuCalls += 1;
            return { schema: 'sks.codex-app-sks-menubar.v1', ok: true, status: 'installed_launch_skipped', blockers: [], warnings: [] };
          }
        }),
        home,
        desktopBridgeRepairImpl: async () => ({
          id: 'desktop_bridge_catalog_repair',
          ok: true,
          repaired: false,
          required_for_ready: false,
          manual_required: false,
          warnings: [],
          blockers: [],
          rollback_evidence: 'combined_catalog_previous_generation_preserved'
        }),
        desktopBridgeStatusImpl: async () => bridgeStatus({ ready: true })
      }
    );

    assert.equal(result.ok, true, JSON.stringify(result.blockers));
    assert.equal(result.doctor_profile, 'migration');
    assert.equal(menuCalls, 0, 'the migration profile must not install the Menu Bar; the update owns those stages');
    assert.ok(!result.project_phases_skipped.includes('project_migration_receipt'), JSON.stringify(result.project_phases_skipped));

    const receipt = JSON.parse(await fsp.readFile(projectUpdateMigrationReceiptPath(home), 'utf8'));
    assert.equal(receipt.status, 'current');
    assert.equal(receipt.source, 'doctor-migration');
    assert.equal(receipt.sks_version, PACKAGE_VERSION);
    assert.equal(path.resolve(receipt.root), home);
    assert.equal(isUpdateMigrationReceiptCurrent(receipt), true, JSON.stringify(receipt.blockers));
    const stageIds = (receipt.migration_stages || []).map((stage: any) => stage.id);
    assert.ok(stageIds.includes('desktop-bridge-restage'), stageIds.join(','));
    assert.ok(stageIds.includes('desktop-bridge-catalog-repair'), stageIds.join(','));
    assert.ok(stageIds.includes('skills-reconcile'), stageIds.join(','));
    assert.ok(stageIds.includes('hook-trust-refresh'), stageIds.join(','));
    assert.equal(result.migration_receipt.status, 'current');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousGlobalRoot === undefined) delete process.env.SKS_GLOBAL_ROOT;
    else process.env.SKS_GLOBAL_ROOT = previousGlobalRoot;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

// The migration profile never gates on live bridge readiness (the same
// judgment `doctorProfileRequiresDesktopBridgeReadiness` encodes for the
// project path): a stale catalog the repair could not clear demotes to a
// warning plus a NAMED follow-up, so the first update after a bridge outage
// can still write a current receipt instead of failing forever.
test('migration profile demotes bridge blockers to warnings with a named follow-up', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-global-migration-bridge-demote-'));
  const currentReceipt = () => ({
    schema: 'sks.project-migration-receipt.v2',
    status: 'current',
    sks_version: PACKAGE_VERSION,
    root: home,
    source: 'doctor-migration',
    generated_at: new Date().toISOString(),
    installation_epoch_sha256: 'fixture-epoch-sha256',
    migration_stages: [],
    required_blockers: [],
    optional_warnings: [],
    blockers: [],
    warnings: []
  });
  try {
    const result: any = await executeDoctorGlobalOnlyFix(
      ['--fix', '--yes', '--profile', 'migration', '--machine-only'],
      home,
      {
        ...baseDeps(),
        home,
        writeProjectUpdateMigrationReceiptImpl: async (input: any) => {
          assert.deepEqual(input.blockers, [], 'bridge findings must never enter the migration receipt blockers');
          return currentReceipt();
        },
        desktopBridgeRepairImpl: async () => ({
          id: 'desktop_bridge_catalog_repair',
          ok: false,
          repaired: false,
          required_for_ready: false,
          manual_required: false,
          warnings: [],
          blockers: ['desktop_bridge_catalog_still_stale_after_repair'],
          rollback_evidence: 'combined_catalog_previous_generation_preserved'
        }),
        desktopBridgeStatusImpl: async () => bridgeStatus({ ready: false, blockers: ['codex_lb_catalog_stale'], recovery: ['retry_catalog_sync'] })
      }
    );

    assert.equal(result.ok, true, JSON.stringify(result.blockers));
    assert.deepEqual(result.blockers, []);
    assert.ok(result.warnings.includes('migration_optional_blocker:codex_lb_catalog_stale'), JSON.stringify(result.warnings));
    assert.ok(result.warnings.includes('migration_optional_blocker:desktop_bridge_catalog_still_stale_after_repair'), JSON.stringify(result.warnings));
    assert.ok(
      result.next_actions.includes('Desktop Bridge still reports blockers: run `sks doctor --fix` to repair the bridge catalog.'),
      JSON.stringify(result.next_actions)
    );
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
