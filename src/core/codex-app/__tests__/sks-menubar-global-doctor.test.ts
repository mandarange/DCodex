import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeDoctorGlobalOnlyFix, run as doctorRun } from '../../../commands/doctor.js';
import {
  cleanupProjectMenuBarDuplicates,
  inspectProjectMenuBarCanonicalState,
  verifiedProjectMenuBarDuplicateExecutablePaths
} from '../menubar/global-install.js';
import { sksMenuBarPaths } from '../menubar/paths.js';

function unmanagedDesktopBridgeStatus() {
  const provider = (providerId: string) => ({
    provider_id: providerId,
    enabled: false,
    credential: { state: 'absent', source: null, blockers: [], warnings: [] },
    endpoint: { configured: false, origin_redacted: null, auth_transport: null }
  });
  return {
    schema: 'sks.desktop-bridge-status.v3',
    checked_at: new Date().toISOString(),
    management: { managed: false },
    providers: { 'codex-lb': provider('codex-lb'), openrouter: provider('openrouter') },
    readiness: { ready: false, state: 'unmanaged', blockers: [], warnings: [] },
    recovery_actions: []
  };
}

test('menu global-only doctor preserves global skills and never runs project reconciliation', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-global-doctor-'));
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-global-doctor-project-'));
  const userSkill = path.join(home, '.agents', 'skills', 'user-owned-skill', 'SKILL.md');
  let menuRoot: string | null = null;
  try {
    await fsp.mkdir(path.dirname(userSkill), { recursive: true });
    await fsp.writeFile(userSkill, '---\nname: user-owned-skill\n---\n\nKeep me.\n');
    const result: any = await executeDoctorGlobalOnlyFix(
      ['--fix', '--global-only', '--json'],
      root,
      {
        home,
        ensureGlobalCodexFastModeDuringInstallImpl: async () => ({ status: 'current', ok: true }),
        installSksMenuBarImpl: async (opts: any) => {
          menuRoot = opts.root;
          return { schema: 'sks.codex-app-sks-menubar.v1', ok: true, status: 'installed_launch_skipped', blockers: [], warnings: [] };
        },
        desktopBridgeStatusImpl: async () => unmanagedDesktopBridgeStatus()
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.global_only, true);
    assert.equal(result.no_project_writes_performed, true);
    assert.equal(result.root, root);
    assert.equal(menuRoot, home);
    assert.equal(result.skills.global.scope, 'global');
    assert.equal(result.skills.project.skipped, true);
    assert.ok(result.project_phases_skipped.includes('project_skills_reconcile'));
    assert.equal(await fsp.readFile(userSkill, 'utf8').then((text) => /Keep me\./.test(text)), true);
    const installed = await fsp.readdir(path.join(home, '.agents', 'skills'));
    assert.ok(installed.length > 1, 'official global skills should remain installed after the menu doctor flow');
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('global-only doctor reports OpenRouter Desktop Bridge status without migrating credentials', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-global-doctor-openrouter-'));
  let migrationCalls = 0;
  try {
    const result: any = await executeDoctorGlobalOnlyFix(['--fix', '--global-only', '--json'], home, {
      home,
      reconcileSkillsImpl: async () => ({ schema: 'sks.skill-reconcile.v1', scope: 'global', core_skill_integrity: { ok: true } }),
      ensureGlobalCodexFastModeDuringInstallImpl: async () => ({ status: 'current', ok: true }),
      ensureStoredOpenRouterProviderDuringInstallImpl: async () => {
        migrationCalls += 1;
        throw new Error('credential migration must not run');
      },
      installSksMenuBarImpl: async () => ({ schema: 'sks.codex-app-sks-menubar.v1', ok: true, status: 'installed_launch_skipped', blockers: [], warnings: [] }),
      desktopBridgeStatusImpl: async () => ({
        ...unmanagedDesktopBridgeStatus(),
        providers: {
          ...unmanagedDesktopBridgeStatus().providers,
          openrouter: {
            provider_id: 'openrouter',
            enabled: true,
            credential: { state: 'ready', source: 'provider-store', blockers: [], warnings: [] },
            endpoint: { configured: true, origin_redacted: 'https://openrouter.ai', auth_transport: 'openrouter-bearer' }
          }
        },
        readiness: { ready: true, state: 'ready', blockers: [], warnings: [] }
      })
    });
    assert.equal(result.ok, true, JSON.stringify(result.blockers));
    assert.equal(migrationCalls, 0);
    assert.equal(result.openrouter_provider.credential.state, 'ready');
    assert.equal(result.openrouter_provider.credential.source, 'provider-store');
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('global-only Doctor Fix does not restart the Menu Bar while an update parent owns completion', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-global-doctor-deferred-menubar-'));
  let menuOptions: any = null;
  const env = {
    ...process.env,
    HOME: home,
    SKS_UPDATE_DEFER_MENUBAR_RESTART: '1'
  };
  try {
    const result: any = await executeDoctorGlobalOnlyFix(['--fix', '--global-only', '--json'], home, {
      home,
      env,
      reconcileSkillsImpl: async () => ({ schema: 'sks.skill-reconcile.v1', scope: 'global', core_skill_integrity: { ok: true } }),
      ensureGlobalCodexFastModeDuringInstallImpl: async () => ({ status: 'current', ok: true }),
      ensureStoredOpenRouterProviderDuringInstallImpl: async () => ({ schema: 'sks.openrouter-provider-upgrade-repair.v1', ok: true, status: 'skipped', blockers: [], warnings: [] }),
      installSksMenuBarImpl: async (options: any) => {
        menuOptions = options;
        return { schema: 'sks.codex-app-sks-menubar.v1', ok: true, status: 'installed_launch_skipped', blockers: [], warnings: [] };
      },
      desktopBridgeStatusImpl: async () => unmanagedDesktopBridgeStatus()
    });

    assert.equal(result.ok, true, JSON.stringify(result.blockers));
    assert.equal(menuOptions?.launch, false);
    assert.equal(menuOptions?.env?.SKS_UPDATE_DEFER_MENUBAR_RESTART, '1');
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('global-only doctor removes managed global legacy guidance without touching the project', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-global-doctor-legacy-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  const sentinel = path.join(root, 'sentinel.txt');
  try {
    await fsp.mkdir(path.join(home, '.codex'), { recursive: true });
    await fsp.mkdir(path.join(globalRuntimeRoot, '.agents', 'skills', 'Team'), { recursive: true });
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(sentinel, 'keep project bytes\n');
    await fsp.writeFile(path.join(home, 'AGENTS.md'), '<!-- BEGIN Sneakoscope Codex GX MANAGED BLOCK -->\nUse `$Team` and `sks db`.\n<!-- END Sneakoscope Codex GX MANAGED BLOCK -->\n');
    await fsp.writeFile(path.join(home, '.codex', 'SNEAKOSCOPE.md'), '# ㅅㅋㅅ\nInstall scope: `global`\nCommand: `sks <command>`\nFiles: AGENTS.md, .codex/hooks.json, .codex/config.toml, .codex/SNEAKOSCOPE.md\nUse `sks mad-db`.\n');
    await fsp.writeFile(path.join(globalRuntimeRoot, '.agents', 'skills', 'Team', 'SKILL.md'), '---\nname: Team\ndescription: Sneakoscope generated legacy skill\n---\n\n<!-- BEGIN SKS MANAGED SKILL -->\n');

    const result: any = await executeDoctorGlobalOnlyFix(['--fix', '--global-only', '--json'], root, {
      home,
      globalRuntimeRoot,
      reconcileSkillsImpl: async () => ({ schema: 'sks.skill-reconcile.v1', scope: 'global', core_skill_integrity: { ok: true } }),
      ensureGlobalCodexFastModeDuringInstallImpl: async () => ({ status: 'current', ok: true }),
      installSksMenuBarImpl: async () => ({ schema: 'sks.codex-app-sks-menubar.v1', ok: true, status: 'installed_launch_skipped', blockers: [], warnings: [] }),
      desktopBridgeStatusImpl: async () => unmanagedDesktopBridgeStatus()
    });

    assert.equal(result.ok, true, JSON.stringify(result.blockers));
    assert.equal(result.current_public_surface.ok, true);
    assert.doesNotMatch(`${await fsp.readFile(path.join(home, 'AGENTS.md'), 'utf8')}\n${await fsp.readFile(path.join(home, '.codex', 'SNEAKOSCOPE.md'), 'utf8')}`, /\$Team|sks team|sks mad-db|sks db/i);
    await assert.rejects(fsp.access(path.join(globalRuntimeRoot, '.agents', 'skills', 'Team')));
    assert.equal(await fsp.readFile(sentinel, 'utf8'), 'keep project bytes\n');
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope')));
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('menu global-only doctor fails closed when Desktop Bridge status cannot be inspected', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-global-doctor-probe-failure-'));
  try {
    const result: any = await executeDoctorGlobalOnlyFix(
      ['--fix', '--global-only', '--json'],
      home,
      {
        home,
        reconcileSkillsImpl: async () => ({
          schema: 'sks.skill-reconcile.v1',
          scope: 'global',
          core_skill_integrity: { ok: true }
        }),
        ensureGlobalCodexFastModeDuringInstallImpl: async () => ({ status: 'current', ok: true }),
        installSksMenuBarImpl: async () => ({ schema: 'sks.codex-app-sks-menubar.v1', ok: true, status: 'installed_launch_skipped', blockers: [], warnings: [] }),
        desktopBridgeStatusImpl: async () => { throw new Error('fixture bridge status unavailable'); }
      }
    );

    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.equal(result.desktop_bridge.ok, false);
    assert.equal(result.desktop_bridge.read_only, true);
    assert.ok(result.blockers.includes('desktop_bridge_status_unavailable:fixture bridge status unavailable'));
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('menu global-only doctor fails closed when Desktop Bridge returns no status', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-global-doctor-null-probe-'));
  try {
    const result: any = await executeDoctorGlobalOnlyFix(
      ['--fix', '--global-only', '--json'],
      home,
      {
        home,
        reconcileSkillsImpl: async () => ({ schema: 'sks.skill-reconcile.v1', scope: 'global', core_skill_integrity: { ok: true } }),
        ensureGlobalCodexFastModeDuringInstallImpl: async () => ({ status: 'current', ok: true }),
        installSksMenuBarImpl: async () => ({ schema: 'sks.codex-app-sks-menubar.v1', ok: true, status: 'installed_launch_skipped', blockers: [], warnings: [] }),
        desktopBridgeStatusImpl: async () => undefined
      }
    );
    assert.equal(result.ok, false);
    assert.equal(result.desktop_bridge.ok, false);
    assert.ok(result.blockers.includes('desktop_bridge_status_unavailable:invalid Desktop Bridge status response'));
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('global-only doctor wrapper writes guard evidence under HOME and not the project', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-global-doctor-wrapper-root-'));
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-global-doctor-wrapper-home-'));
  const oldCwd = process.cwd();
  const oldHome = process.env.HOME;
  const oldExitCode = process.exitCode;
  const oldLog = console.log;
  const oldError = console.error;
  try {
    process.chdir(root);
    process.env.HOME = home;
    process.exitCode = undefined;
    console.log = () => undefined;
    console.error = () => undefined;
    const result: any = await doctorRun('doctor', ['--fix', '--global-only', '--machine-only'], {
      home,
      reconcileSkillsImpl: async () => ({ schema: 'sks.skill-reconcile.v1', scope: 'global', core_skill_integrity: { ok: true } }),
      ensureGlobalCodexFastModeDuringInstallImpl: async () => ({ status: 'current', ok: true }),
      installSksMenuBarImpl: async () => ({ schema: 'sks.codex-app-sks-menubar.v1', ok: true, status: 'installed_launch_skipped', blockers: [], warnings: [] }),
      desktopBridgeStatusImpl: async () => unmanagedDesktopBridgeStatus()
    });
    assert.equal(result.ok, true);
    assert.equal(result.no_project_writes_performed, true);
    await fsp.access(path.join(home, '.sneakoscope', 'reports', 'secret-preservation-guard.json'));
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'reports', 'secret-preservation-guard.json')));
  } finally {
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    process.exitCode = oldExitCode;
    console.log = oldLog;
    console.error = oldError;
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('menubar duplicate discovery reports and safely removes verified running and launchd candidates outside fixed roots', async (t) => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-global-discovery-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const paths = sksMenuBarPaths(home, root);
  const runningDuplicate = path.join(home, 'Archived Menu Bars', 'running-copy');
  const launchdDuplicate = path.join(root, 'legacy-launch', 'launchd-copy');
  const runningExecutable = await writeVerifiedMenuBarDuplicate(runningDuplicate);
  const launchdExecutable = await writeVerifiedMenuBarDuplicate(launchdDuplicate);
  const pgrep = path.join(fixture, 'fake-pgrep');
  const ps = path.join(fixture, 'fake-ps');
  t.after(() => fsp.rm(fixture, { recursive: true, force: true }));

  await fsp.mkdir(paths.install_dir, { recursive: true });
  await fsp.mkdir(path.dirname(paths.launch_agent_path), { recursive: true });
  await fsp.writeFile(paths.launch_agent_path, `<?xml version="1.0"?>
<plist><dict><key>ProgramArguments</key><array><string>${launchdExecutable}</string></array></dict></plist>\n`);
  await fsp.writeFile(pgrep, `#!${process.execPath}
process.stdout.write('701\\n702\\n');
`, { mode: 0o755 });
  await fsp.writeFile(ps, `#!${process.execPath}
process.stdout.write(${JSON.stringify(`701 ${paths.executable_path}\n702 ${runningExecutable}\n`)});
`, { mode: 0o755 });
  const env = {
    ...process.env,
    SKS_MENUBAR_TEST_PROCESS_TOOLS: '1',
    SKS_MENUBAR_PGREP: pgrep,
    SKS_MENUBAR_PS: ps
  };

  const state = await inspectProjectMenuBarCanonicalState({ paths, root, env });
  assert.deepEqual(state.candidate_paths, [runningDuplicate, launchdDuplicate].sort());
  assert.deepEqual(state.verified_duplicates, [runningDuplicate, launchdDuplicate].sort());
  assert.deepEqual(state.warnings, state.candidate_paths.map((candidate) => `menubar_duplicate_candidate_detected:${candidate}`));
  await fsp.access(runningExecutable);
  await fsp.access(launchdExecutable);

  const executablePaths = await verifiedProjectMenuBarDuplicateExecutablePaths({ paths, root, env });
  assert.deepEqual(executablePaths.sort(), [runningExecutable, launchdExecutable].sort());

  await fsp.writeFile(pgrep, `#!${process.execPath}
process.exit(1);
`, { mode: 0o755 });
  const cleanup = await cleanupProjectMenuBarDuplicates({
    paths,
    root,
    env,
    candidateExecutablePaths: executablePaths
  });
  assert.equal(cleanup.ok, true, JSON.stringify(cleanup));
  assert.deepEqual(cleanup.removed.sort(), [runningDuplicate, launchdDuplicate].sort());
  assert.ok(cleanup.receipt_path);
  await fsp.access(cleanup.receipt_path!);
  await assert.rejects(fsp.access(runningDuplicate));
  await assert.rejects(fsp.access(launchdDuplicate));
});

async function writeVerifiedMenuBarDuplicate(installDir: string): Promise<string> {
  const executable = path.join(installDir, 'SKSMenuBar.app', 'Contents', 'MacOS', 'SKSMenuBar');
  await fsp.mkdir(path.dirname(executable), { recursive: true });
  await fsp.writeFile(executable, 'verified duplicate fixture\n', { mode: 0o755 });
  await fsp.writeFile(path.join(installDir, 'build-stamp.json'), `${JSON.stringify({
    schema: 'sks.sks-menubar-build-stamp.v2',
    codesign_identifier: 'com.sneakoscope.sks-menubar'
  })}\n`);
  return executable;
}
