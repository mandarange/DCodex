import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { desktopBridgeServicePaths } from '../../codex-lb/desktop-service.js';
import {
  desktopBridgeRestage,
  runDesktopBridgeRestageStage,
  type DesktopBridgeRestageOptions
} from '../update-migration-state/desktop-bridge-restage.js';

type BootstrapService = NonNullable<DesktopBridgeRestageOptions['bootstrapService']>;
type LaunchctlRunner = NonNullable<DesktopBridgeRestageOptions['run']>;

const VERSION = '9.9.9-fixture';

interface Harness {
  home: string;
  bootstrapped: string[];
  launchctl: string[][];
  options: DesktopBridgeRestageOptions;
}

async function harness(
  t: test.TestContext,
  setup: { plist?: boolean; settings?: boolean; state?: { pid: number; sks_version?: string } | null; bootstrapRunning?: boolean; bootstrapBlockers?: string[]; kickstartCode?: number }
): Promise<Harness> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-restage-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const paths = desktopBridgeServicePaths(home);
  if (setup.plist !== false) {
    await fsp.mkdir(path.dirname(paths.launch_agent_path), { recursive: true });
    await fsp.writeFile(paths.launch_agent_path, '<plist/>', 'utf8');
  }
  await fsp.mkdir(path.dirname(paths.settings_path), { recursive: true });
  if (setup.settings !== false) await fsp.writeFile(paths.settings_path, '{}', 'utf8');
  if (setup.state) await fsp.writeFile(paths.state_path, JSON.stringify(setup.state), 'utf8');

  const bootstrapped: string[] = [];
  const launchctl: string[][] = [];
  const bootstrapService = (async (options: { home?: string } = {}) => {
    bootstrapped.push(String(options.home));
    return { running: setup.bootstrapRunning !== false, blockers: setup.bootstrapBlockers || [] };
  }) as unknown as BootstrapService;
  const run = (async (file: string, args: readonly string[]) => {
    launchctl.push([file, ...args]);
    return { code: setup.kickstartCode ?? 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false, timedOut: false };
  }) as unknown as LaunchctlRunner;

  return {
    home,
    bootstrapped,
    launchctl,
    options: {
      home,
      platform: 'darwin',
      packageVersion: VERSION,
      uid: 501,
      env: {},
      run,
      bootstrapService,
      // Every pid this suite writes belongs to no process; the cases that need a
      // live one say so explicitly.
      processAlive: () => false
    }
  };
}

/**
 * The operator-visible bug behind 9.2.4. A 9.2.3 bridge could not start at all
 * (launchd passed `--supervised`, the CLI rejected it, the failed install booted
 * the service out), and `sks update` then found no live pid and skipped —
 * replacing the package while leaving the service down. The one command that was
 * supposed to fix it reported success and changed nothing.
 */
test('an update revives a Desktop Bridge that is installed but not running', async (t) => {
  const setup = await harness(t, { state: null });
  const result = await desktopBridgeRestage(setup.options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.actions, [`desktop_bridge_bootstrapped:${VERSION}`]);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(setup.bootstrapped, [setup.home]);
  // Recovery is a bootstrap, never a kickstart: kickstart restarts a loaded
  // service and fails without side effects when nothing is loaded.
  assert.deepEqual(setup.launchctl, []);
});

test('a state file whose pid is gone is treated as a down bridge, not as a live one', async (t) => {
  const setup = await harness(t, { state: { pid: 424242, sks_version: '9.2.3' } });
  const result = await desktopBridgeRestage(setup.options);
  assert.deepEqual(result.actions, [`desktop_bridge_bootstrapped:${VERSION}`]);
  assert.deepEqual(setup.bootstrapped, [setup.home]);
});

/**
 * Bridge readiness is deliberately not a migration-profile gate, so a recovery
 * that cannot converge warns and names the follow-up command instead of voiding
 * an otherwise good update — the same policy the catalog-repair stage follows.
 */
test('a recovery that cannot bring the bridge up warns without failing the update', async (t) => {
  const setup = await harness(t, {
    state: null,
    bootstrapRunning: false,
    bootstrapBlockers: ['desktop_bridge_entry_macos_protected_folder']
  });
  const result = await desktopBridgeRestage(setup.options);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.warnings, [
    'desktop_bridge_restage_bootstrap_incomplete:desktop_bridge_entry_macos_protected_folder',
    'Desktop Bridge is installed but not running: run `sks bridge repair` from your home directory'
  ]);
});

test('a bridge already running the installed version is left alone', async (t) => {
  const setup = await harness(t, { state: { pid: 4242, sks_version: VERSION } });
  const result = await desktopBridgeRestage({ ...setup.options, processAlive: () => true });
  assert.deepEqual(result.actions, ['desktop_bridge_restage_already_current']);
  assert.deepEqual(setup.launchctl, []);
  assert.deepEqual(setup.bootstrapped, []);
});

test('a bridge still serving older code is restarted in place', async (t) => {
  const setup = await harness(t, { state: { pid: 4242, sks_version: '9.2.3' } });
  const result = await desktopBridgeRestage({ ...setup.options, processAlive: () => true });
  assert.deepEqual(result.actions, [`desktop_bridge_restarted:9.2.3:${VERSION}`]);
  assert.deepEqual(setup.launchctl, [['/bin/launchctl', 'kickstart', '-k', 'gui/501/com.sneakoscope.desktop-bridge']]);
  assert.deepEqual(setup.bootstrapped, []);
});

test('no launch agent means there is no managed service to revive', async (t) => {
  const setup = await harness(t, { plist: false, state: null });
  const result = await desktopBridgeRestage(setup.options);
  assert.deepEqual(result.actions, ['desktop_bridge_restage_no_launch_agent']);
  assert.deepEqual(setup.bootstrapped, []);
});

test('a plist without settings is not bootstrapped into a service that would exit', async (t) => {
  const setup = await harness(t, { settings: false, state: null });
  const result = await desktopBridgeRestage(setup.options);
  assert.deepEqual(result.actions, ['desktop_bridge_restage_no_managed_bridge']);
  assert.deepEqual(setup.bootstrapped, []);
});

/**
 * `launchctl` addresses the real `gui/<uid>` domain no matter where HOME points,
 * so the stage entry point — which injects nothing — must refuse to run inside a
 * test runner. This test runs under exactly that condition, so it witnesses the
 * guard rather than simulating it.
 */
test('the stage entry point refuses to touch launchd from inside a test runner', async () => {
  const result = await runDesktopBridgeRestageStage();
  assert.equal(result.ok, true);
  if (process.platform === 'darwin') {
    assert.deepEqual(result.actions, ['desktop_bridge_restage_skipped_under_tests']);
  }
});

test('a harnessed run with only one seam injected still refuses the real launchd', async (t) => {
  const setup = await harness(t, { state: null });
  const { bootstrapService: _unused, ...withoutBootstrap } = setup.options;
  const result = await desktopBridgeRestage({ ...withoutBootstrap, env: { SKS_TEST_ISOLATION: '1' } });
  assert.deepEqual(result.actions, ['desktop_bridge_restage_skipped_under_tests']);
  assert.deepEqual(setup.bootstrapped, []);
  assert.deepEqual(setup.launchctl, []);
});
