import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planDoctorDirtyRepair, markDoctorPhaseClean } from '../doctor-dirty-planner.js';
import { runDoctorFixTransaction } from '../doctor-transaction.js';
import { buildSksMenuBarDoctorPostcheck } from '../sks-menubar-doctor.js';
import {
  evaluateMenuBarRuntimeReadiness,
  evaluatePersistedMenuBarVersionProbe
} from '../../codex-app/menubar/status.js';
import { cleanupProjectMenuBarDuplicates } from '../../codex-app/menubar/global-install.js';
import { sksMenuBarPaths } from '../../codex-app/menubar/paths.js';
import {
  rebootstrapSksMenuBarLaunchdForDoctorFix,
  sksMenuBarRunningVersionConsoleLines
} from '../../../commands/doctor.js';

test('doctor menubar phase treats undefined ok as failed, even though optional for ready', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-menubar-phase-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const transaction = await runDoctorFixTransaction({
    root,
    reportPath: null,
    phases: [{
      id: 'sks_menubar',
      required_for_ready: false,
      run: async () => ({
        id: 'sks_menubar',
        ok: undefined as unknown as boolean,
        required_for_ready: false,
        warnings: ['synthetic_undefined_ok']
      })
    }]
  });

  const phase = transaction.phases.find((entry) => entry.id === 'sks_menubar');
  assert.equal(phase?.ok, false);
  assert.equal(phase?.required_for_ready, false);
  assert.equal(transaction.ok, true);
});

test('doctor dirty planner marks menubar dirty when runtime probe fails despite clean marker', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-menubar-dirty-'));
  const previousHome = process.env.HOME;
  const previousLaunchctl = process.env.SKS_MENUBAR_LAUNCHCTL;
  process.env.HOME = path.join(root, 'home');
  // Point the runtime probe's launchctl lookup at a non-existent path so it never shells
  // out to the REAL, machine-wide launchd service (a slow, blocking spawnSync call that
  // has nothing to do with this test's isolated root and can race concurrently-running
  // test files that also spawn real subprocesses).
  process.env.SKS_MENUBAR_LAUNCHCTL = path.join(root, 'no-such-launchctl');
  await fs.mkdir(process.env.HOME, { recursive: true });
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousLaunchctl === undefined) delete process.env.SKS_MENUBAR_LAUNCHCTL;
    else process.env.SKS_MENUBAR_LAUNCHCTL = previousLaunchctl;
    await fs.rm(root, { recursive: true, force: true });
  });

  const proofId = markDoctorPhaseClean(root, 'sks_menubar', 'doctor-sks-menubar-clean-fixture', true);
  await fs.mkdir(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
  await fs.writeFile(path.join(root, '.sneakoscope', 'reports', 'doctor-fix-transaction.json'), JSON.stringify({ proof_ids_used: [proofId] }), 'utf8');
  const plan = planDoctorDirtyRepair(root, ['sks_menubar']);
  const phase = plan.phases.find((entry) => entry.id === 'sks_menubar');
  if (process.platform === 'darwin') {
    assert.equal(phase?.status, 'dirty');
    assert.match(phase?.reason || '', /runtime_probe_failed/);
    assert.equal(plan.runtime_probe_failed.some((entry) => entry.startsWith('sks_menubar:')), true);
  } else {
    assert.equal(phase?.status, 'clean');
    assert.deepEqual(plan.runtime_probe_failed, []);
  }
});

test('doctor menubar postcheck does not relabel a version mismatch as a successful smoke failure', () => {
  const postcheck = buildSksMenuBarDoctorPostcheck({
    ok: false,
    blockers: ['action_target_version_mismatch'],
    warnings: [],
    installed_version: '8.0.3',
    running_process: runtimeProcess('8.0.2'),
    menubar_version_probe: versionProbe(false, '8.0.3', '8.0.2'),
    launchd: { error: 'launchctl_print_failed:113:Bad request.', state: null },
    action_target: { smoke_code: 0 }
  });

  assert.equal(postcheck.ok, false);
  assert.deepEqual(postcheck.blockers, ['action_target_version_mismatch']);
  assert.doesNotMatch(postcheck.blockers.join(','), /action_script_smoke_failed/);
});

test('doctor menubar postcheck enriches only canonical runtime blockers', () => {
  const postcheck = buildSksMenuBarDoctorPostcheck({
    ok: false,
    blockers: ['launchd_not_running', 'action_script_smoke_failed'],
    warnings: [],
    installed_version: '8.0.3',
    running_process: runtimeProcess('8.0.2'),
    menubar_version_probe: versionProbe(false, '8.0.3', '8.0.2'),
    launchd: { error: 'launchctl_print_failed:113:Bad request.', state: null },
    action_target: { smoke_code: 127 }
  });

  assert.deepEqual(postcheck.blockers, [
    'launchd_not_running:launchctl_print_failed:113:Bad request.',
    'action_script_smoke_failed:127'
  ]);
  assert.deepEqual(postcheck.warnings, ['menubar_postcheck_failed']);
});

test('doctor menubar postcheck reports the verified running version', () => {
  const postcheck = buildSksMenuBarDoctorPostcheck({
    ok: true,
    blockers: [],
    warnings: [],
    installed_version: '8.0.3',
    running_process: runtimeProcess('8.0.3'),
    menubar_version_probe: versionProbe(true, '8.0.3', '8.0.3'),
    launchd: { error: null, state: 'running' },
    action_target: { smoke_code: 0 }
  });

  assert.equal(postcheck.ok, true);
  assert.equal(postcheck.installed_version, '8.0.3');
  assert.equal(postcheck.running_version, '8.0.3');
  assert.equal(postcheck.running_pid, 42);
  assert.equal(postcheck.menubar_version_probe?.ok, true);
});

test('doctor readiness downgrades only an exact-version verified active process', () => {
  assert.deepEqual(evaluateMenuBarRuntimeReadiness({
    installed: true,
    running: true,
    verifiedProcessMatchesExpectedVersion: true,
    launchd: { checked: true, ok: false }
  }), {
    blocker: null,
    warning: 'launchd_not_running_process_active'
  });
  assert.deepEqual(evaluateMenuBarRuntimeReadiness({
    installed: true,
    running: true,
    verifiedProcessMatchesExpectedVersion: false,
    launchd: { checked: true, ok: false }
  }), {
    blocker: 'launchd_not_running',
    warning: 'launchd_not_running_process_active'
  });
});

test('doctor --fix re-bootstraps a verified warning-only process through injected helpers', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-menubar-rebootstrap-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  t.after(async () => fs.rm(fixture, { recursive: true, force: true }));
  const activeStatus = {
    ok: true,
    blockers: [],
    warnings: ['launchd_not_running_process_active'],
    launchd: { checked: true, ok: false, state: null, pid: null, error: 'launchctl_print_failed:113' },
    running_process: runtimeProcess('8.0.3'),
    menubar_version_probe: versionProbe(true, '8.0.3', '8.0.3')
  };
  const repairedStatus = {
    ...activeStatus,
    warnings: [],
    launchd: { checked: true, ok: true, state: 'running', pid: 42, error: null }
  };
  let restartCalls = 0;
  let inspectCalls = 0;

  const result = await rebootstrapSksMenuBarLaunchdForDoctorFix({
    fix: true,
    root,
    home,
    env: { HOME: home },
    status: activeStatus
  }, {
    restartLaunchAgentImpl: (async (
      paths: ReturnType<typeof sksMenuBarPaths>,
      env: NodeJS.ProcessEnv
    ) => {
      restartCalls += 1;
      assert.equal(paths.home, home);
      assert.equal(paths.root, root);
      assert.equal(env.HOME, home);
      return { ok: true, error: null } as any;
    }) as any,
    inspectSksMenuBarStatusImpl: (async (options: {
      home?: string;
      root?: string;
      env?: NodeJS.ProcessEnv;
    }) => {
      inspectCalls += 1;
      assert.equal(options.home, home);
      assert.equal(options.root, root);
      assert.equal(options.env?.HOME, home);
      return repairedStatus as any;
    }) as any
  });

  assert.equal(result.attempted, true);
  assert.equal(result.ok, true);
  assert.equal(result.status.launchd.ok, true);
  assert.equal(restartCalls, 1);
  assert.equal(inspectCalls, 1);
});

test('doctor --fix does not re-bootstrap an unverified active process', async () => {
  let restartCalls = 0;
  const result = await rebootstrapSksMenuBarLaunchdForDoctorFix({
    fix: true,
    root: '/tmp/project',
    home: '/tmp/home',
    env: { HOME: '/tmp/home' },
    status: {
      ok: false,
      blockers: ['launchd_not_running'],
      warnings: ['launchd_not_running_process_active'],
      launchd: { checked: true, ok: false },
      running_process: runtimeProcess('8.0.2'),
      menubar_version_probe: versionProbe(false, '8.0.3', '8.0.2')
    }
  }, {
    restartLaunchAgentImpl: (async () => {
      restartCalls += 1;
      return { ok: true } as any;
    }) as any
  });

  assert.equal(result.attempted, false);
  assert.equal(restartCalls, 0);
});

test('doctor human output identifies the running process and version mismatch', () => {
  const lines = sksMenuBarRunningVersionConsoleLines({
    installed_version: '8.0.3',
    running_process: runtimeProcess('8.0.2'),
    menubar_version_probe: versionProbe(false, '8.0.3', '8.0.2')
  });

  assert.deepEqual(lines, [
    '  RUNNING: version 8.0.2 (PID 42)',
    '  expected: version 8.0.3',
    '  installed: version 8.0.3'
  ]);
  assert.deepEqual(sksMenuBarRunningVersionConsoleLines({
    installed_version: '8.0.3',
    running_process: runtimeProcess('8.0.3'),
    menubar_version_probe: versionProbe(true, '8.0.3', '8.0.3')
  }), ['  RUNNING: version 8.0.3 (PID 42)']);
});

test('persisted menu bar probe rejects a stale running version and accepts the repaired version', () => {
  const stale = evaluatePersistedMenuBarVersionProbe({
    probe: versionProbe(false, '8.0.3', '8.0.2'),
    expectedVersion: '8.0.3',
    runningProcess: runtimeProcess('8.0.2'),
    persistedPath: '/tmp/menubar-version-probe.json'
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'menubar_running_version_mismatch');

  const repaired = evaluatePersistedMenuBarVersionProbe({
    probe: versionProbe(true, '8.0.3', '8.0.3'),
    expectedVersion: '8.0.3',
    runningProcess: runtimeProcess('8.0.3'),
    persistedPath: '/tmp/menubar-version-probe.json'
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.running_version, '8.0.3');
});

test('project duplicate cleanup removes only a verified legacy install and writes a canonical receipt', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-duplicate-cleanup-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const paths = sksMenuBarPaths(home, root);
  const duplicate = path.join(root, '.sneakoscope', 'sks-menubar');
  const duplicateExecutable = path.join(duplicate, 'SKSMenuBar.app', 'Contents', 'MacOS', 'SKSMenuBar');
  const canonicalSentinel = path.join(paths.install_dir, 'canonical-sentinel');
  t.after(async () => fs.rm(fixture, { recursive: true, force: true }));

  await fs.mkdir(path.dirname(duplicateExecutable), { recursive: true });
  await fs.mkdir(paths.install_dir, { recursive: true });
  await fs.writeFile(duplicateExecutable, 'verified duplicate fixture');
  await fs.writeFile(path.join(duplicate, 'build-stamp.json'), JSON.stringify({
    schema: 'sks.sks-menubar-build-stamp.v2',
    codesign_identifier: 'com.sneakoscope.sks-menubar'
  }));
  await fs.writeFile(canonicalSentinel, 'keep');

  const cleanup = await cleanupProjectMenuBarDuplicates({ paths, root });
  assert.equal(cleanup.ok, true, JSON.stringify(cleanup));
  assert.deepEqual(cleanup.removed, [duplicate]);
  assert.ok(cleanup.receipt_path);
  await fs.access(cleanup.receipt_path!);
  await fs.access(canonicalSentinel);
  await assert.rejects(fs.access(duplicate));
});

function runtimeProcess(version: string) {
  return {
    checked: true,
    ok: true,
    pid: 42,
    package_version: version,
    build_version: version,
    executable_path: '/tmp/SKSMenuBar',
    started_at: '2026-08-01T00:00:00.000Z',
    source: 'runtime-state' as const,
    error: null
  };
}

function versionProbe(ok: boolean, expected: string, running: string) {
  return {
    schema: 'sks.menubar-version-probe.v1' as const,
    checked: true,
    ok,
    expected_version: expected,
    running_version: running,
    pid: 42,
    generated_at: '2026-08-01T00:00:00.000Z',
    persisted_path: '/tmp/menubar-version-probe.json',
    error: ok ? null : 'menubar_running_version_mismatch'
  };
}
