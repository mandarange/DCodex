import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run as doctorRun } from '../doctor.js';
import { doctorGlobalOnlySelection } from '../doctor-profile.js';

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

test('doctor --fix run from the home directory takes the global-only path with run-from-project guidance', async () => {
  const home = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-from-home-')));
  // The residue that used to turn the whole home directory into a "project".
  await fsp.mkdir(path.join(home, '.sneakoscope'), { recursive: true });
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  const previousError = console.error;
  try {
    process.chdir(home);
    process.env.HOME = home;
    process.exitCode = undefined;
    console.log = () => undefined;
    console.error = () => undefined;
    const result: any = await doctorRun('doctor', ['--fix', '--machine-only'], {
      home,
      reconcileSkillsImpl: async () => ({ schema: 'sks.skill-reconcile.v1', scope: 'global', core_skill_integrity: { ok: true } }),
      runDoctorCommandAliasCleanupImpl: async () => ({ ok: true, blockers: [] }),
      ensureGlobalCodexFastModeDuringInstallImpl: async () => ({ status: 'current', ok: true }),
      installSksMenuBarImpl: async () => ({ schema: 'sks.codex-app-sks-menubar.v1', ok: true, status: 'installed_launch_skipped', blockers: [], warnings: [] }),
      desktopBridgeStatusImpl: async () => unmanagedDesktopBridgeStatus()
    });
    assert.equal(result.global_only, true, 'doctor --fix from home must take the global-only path, never project repair against the home folder');
    assert.equal(result.project_root_alias_detected, true);
    assert.equal(result.skills.project.skipped, true);
    assert.equal(result.skills.project.reason, 'global_only_doctor');
    assert.ok(
      result.next_actions.some((action: string) => action.includes('cd <your-project> && sks doctor --fix')),
      `next_actions must tell the user to run from their project, got ${JSON.stringify(result.next_actions)}`
    );
    assert.equal(result.ok, true, JSON.stringify(result.blockers));
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    process.exitCode = previousExitCode;
    console.log = previousLog;
    console.error = previousError;
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('doctorGlobalOnlySelection routes exactly the fix runs whose root is the home directory', () => {
  const home = '/Users/example';
  assert.deepEqual(
    doctorGlobalOnlySelection({ args: ['--fix'], doctorFix: true, root: home, home }),
    { global_only: true, reason: 'home_is_root' }
  );
  assert.deepEqual(
    doctorGlobalOnlySelection({ args: ['--fix'], doctorFix: true, root: '/Users/example/devs/app', home }),
    { global_only: false, reason: null },
    'a real project root under home must keep full project repair'
  );
  assert.deepEqual(
    doctorGlobalOnlySelection({ args: ['--fix', '--global-only'], doctorFix: true, root: '/Users/example/devs/app', home }),
    { global_only: true, reason: 'explicit_flag' }
  );
  assert.deepEqual(
    doctorGlobalOnlySelection({ args: [], doctorFix: false, root: home, home }),
    { global_only: false, reason: null },
    'a read-only doctor run never reroutes into global fix'
  );
});
