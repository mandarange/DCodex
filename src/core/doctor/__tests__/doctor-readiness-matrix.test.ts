import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commandAliasCleanupReport, runDoctorCommandAliasCleanup } from '../command-alias-cleanup.js';
import { buildDoctorReadinessMatrix } from '../doctor-readiness-matrix.js';

test('attempted Center repair failure blocks command readiness without changing core readiness', () => {
  const matrix = buildDoctorReadinessMatrix(readyInput({
    sks_menubar: {
      apply: true,
      ok: false,
      status: 'blocked',
      blockers: ['retired_remote_bridge_bootout_failed']
    }
  }));

  assert.equal(matrix.core_ready, true);
  assert.equal(matrix.center_attempted, true);
  assert.equal(matrix.center_ready, false);
  assert.equal(matrix.ready, false);
  assert.deepEqual(matrix.core_blockers, []);
  assert.deepEqual(matrix.center_blockers, ['retired_remote_bridge_bootout_failed']);
  assert.ok(matrix.blockers.includes('retired_remote_bridge_bootout_failed'));
});

test('unattempted Center failure remains visible without breaking non-fix core readiness', () => {
  const matrix = buildDoctorReadinessMatrix(readyInput({
    sks_menubar: {
      apply: false,
      ok: false,
      status: 'blocked',
      blockers: ['launchd_not_running']
    }
  }));

  assert.equal(matrix.core_ready, true);
  assert.equal(matrix.center_attempted, false);
  assert.equal(matrix.center_ready, false);
  assert.equal(matrix.ready, true);
  assert.deepEqual(matrix.blockers, []);
  assert.deepEqual(matrix.center_blockers, ['launchd_not_running']);
});

test('failed Center postcheck blocks attempted repair even after installer success', () => {
  const matrix = buildDoctorReadinessMatrix(readyInput({
    sks_menubar: { apply: true, ok: true, status: 'installed', blockers: [] },
    doctor_fix_transaction: {
      phases: [{
        id: 'sks_menubar',
        ok: false,
        required_for_ready: false,
        blockers: ['action_target_version_mismatch'],
        warnings: []
      }]
    }
  }));

  assert.equal(matrix.core_ready, true);
  assert.equal(matrix.center_ready, false);
  assert.equal(matrix.ready, false);
  assert.deepEqual(matrix.center_blockers, ['action_target_version_mismatch']);
});

test('migration-required legacy global hook cleanup blockers fail readiness', () => {
  const blocker = 'global_hooks_json_invalid:Unexpected token';
  const matrix = buildDoctorReadinessMatrix(readyInput({
    require_legacy_global_hook_cleanup: true,
    doctor_native_capability: {
      ok: false,
      core_blockers: [],
      optional_warnings: [],
      product_design: {
        ok: false,
        blockers: ['product_design_not_ready']
      },
      legacy_global_hooks: {
        ok: false,
        blockers: [blocker],
        warnings: []
      }
    }
  }));

  const phase = matrix.repair_readiness.phases.find((entry: any) => entry.id === 'legacy_global_hook_cleanup');
  assert.equal(phase?.required_for_core_ready, true);
  assert.equal(matrix.core_ready, false);
  assert.equal(matrix.ready, false);
  assert.deepEqual(matrix.blockers, [`legacy_global_hooks:${blocker}`]);
});

test('ordinary Doctor keeps legacy global hook cleanup blockers optional', () => {
  const blocker = 'project_sks_hooks_missing_no_safe_global_cleanup';
  const matrix = buildDoctorReadinessMatrix(readyInput({
    require_legacy_global_hook_cleanup: false,
    doctor_native_capability: {
      ok: true,
      core_blockers: [],
      optional_warnings: [`legacy_global_hooks:${blocker}`],
      legacy_global_hooks: {
        ok: false,
        blockers: [blocker],
        warnings: []
      }
    }
  }));

  const phase = matrix.repair_readiness.phases.find((entry: any) => entry.id === 'legacy_global_hook_cleanup');
  assert.equal(phase?.required_for_core_ready, false);
  assert.equal(matrix.core_ready, true);
  assert.equal(matrix.ready, true);
  assert.ok(matrix.warnings.includes(`optional:legacy_global_hooks:${blocker}`));
});

test('managed Desktop Bridge fails readiness when its active route is blocked', () => {
  const matrix = buildDoctorReadinessMatrix(readyInput({
    desktop_bridge_status: {
      management: { managed: true },
      service: { running: true },
      readiness: { ready: false, blockers: ['codex_lb_auth_rejected'] }
    }
  }));

  assert.equal(matrix.core_ready, false);
  assert.equal(matrix.ready, false);
  assert.ok(matrix.blockers.includes('codex_lb_auth_rejected'));
});

test('guidance scan truncation reaches matrix warnings without blocking readiness', () => {
  const warning = {
    code: 'guidance_scan_truncated',
    cutoff_path: '/fixture/project/workspace-04096',
    cutoff_reason: 'directory_limit',
    visited_directory_count: 4_096,
    exceeded_directory_count: 7,
    directory_limit: 4_096,
    depth_limit: 12
  } as const;
  const commandAliases = commandAliasCleanupReport(
    { root: '/fixture/project', fix: false },
    undefined,
    undefined,
    {
      schema: 'sks.current-project-guidance.v1',
      ok: true,
      fix: false,
      detected_count: 0,
      reconciled_count: 0,
      remaining_count: 0,
      preserved_user_file_count: 0,
      error_count: 0,
      warnings: [warning]
    }
  );
  const encoded = `guidance_scan_truncated:${warning.cutoff_path}:${warning.exceeded_directory_count}`;

  assert.deepEqual(commandAliases.cleanup.project_guidance.warnings, [warning]);
  assert.deepEqual(commandAliases.warnings, [encoded]);
  const matrix = buildDoctorReadinessMatrix(readyInput({ command_aliases: commandAliases }));
  const phase = matrix.repair_readiness.phases.find((entry: any) => entry.id === 'command_alias_cleanup');
  assert.equal(matrix.core_ready, true);
  assert.equal(matrix.ready, true);
  assert.deepEqual(matrix.blockers, []);
  assert.ok(matrix.warnings.includes(encoded));
  assert.ok(phase?.warnings.includes(encoded));
});

test('required legacy-generation convergence failure blocks Doctor readiness', () => {
  const matrix = buildDoctorReadinessMatrix(readyInput({
    require_legacy_generation_convergence: true,
    skills: {
      global: { ok: true },
      project: { ok: true },
      convergence: {
        ok: false,
        blockers: [],
        warnings: [],
        retired_agent_roles: { ok: true },
        managed_configs: { ok: true },
        retired_runtime_scopes: [{ ok: false }]
      }
    }
  }));

  assert.equal(matrix.core_ready, false);
  assert.equal(matrix.ready, false);
  assert.ok(matrix.blockers.includes('legacy_generation_convergence_failed'));
  assert.ok(matrix.blockers.includes('retired_runtime_scope_reconcile_failed'));
});

test('required legacy-generation convergence cannot pass with a missing central report', () => {
  const matrix = buildDoctorReadinessMatrix(readyInput({
    require_legacy_generation_convergence: true,
    skills: {
      global: { ok: true },
      project: { ok: true }
    }
  }));

  assert.equal(matrix.ready, false);
  assert.ok(matrix.blockers.includes('legacy_generation_convergence_missing'));
});

test('command-alias cleanup reuses and propagates a failed central convergence report', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-convergence-'));
  const home = path.join(root, 'home');
  const globalRuntimeRoot = path.join(root, 'global');
  await fsp.mkdir(home, { recursive: true });
  try {
    const convergence = {
      schema: 'sks.legacy-generation-convergence.v1',
      ok: false,
      fix: true,
      root,
      home,
      global_runtime_root: globalRuntimeRoot,
      global_skills: {
        schema: 'sks.skill-reconcile.v1',
        ok: true,
        scope: 'global',
        target_dir: path.join(home, '.agents', 'skills'),
        fix: true,
        installed: [],
        updated: [],
        removed: [],
        preserved_forge: [],
        preserved_user: [],
        quarantined_user_collisions: [],
        warnings: [],
        core_skill_integrity: { ok: true, installed_count: 0, restored_count: 0 }
      },
      project_skills: [],
      retired_agent_roles: { ok: true },
      retired_runtime_scopes: [{
        schema: 'sks.retired-managed-residue.v1',
        ok: false,
        fix: true,
        detected_managed_artifact_count: 0,
        removed_managed_artifact_count: 0,
        rewritten_state_file_count: 0,
        agent_bridge_manifest: 'absent',
        preserved_user_file_count: 0,
        remaining_managed_artifact_count: 1,
        error_count: 1
      }],
      managed_configs: { ok: true },
      blockers: [],
      warnings: []
    } as any;
    const report = await runDoctorCommandAliasCleanup({
      root,
      home,
      globalRuntimeRoot,
      fix: true,
      managedGenerationConvergence: convergence
    });

    assert.equal(report.ok, false);
    assert.equal(report.cleanup.managed_runtime.ok, false);
    assert.equal(report.cleanup.managed_generation_convergence?.ok, false);
    assert.equal(report.cleanup.managed_generation_convergence?.failed_retired_runtime_scope_count, 1);
    assert.ok(report.blockers.includes('legacy_generation_convergence_failed'));
    assert.ok(report.blockers.includes('retired_managed_runtime_cleanup_failed:1'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

function readyInput(overrides: Record<string, unknown>) {
  return {
    codex: { bin: '/fixture/codex', available: true },
    codex_config: {
      ok: true,
      blockers: [],
      checks: [
        { name: 'node_process_read', ok: true },
        { name: 'spawned_child_read', ok: true }
      ]
    },
    agent_role_config: { ok: true },
    ...overrides
  };
}
