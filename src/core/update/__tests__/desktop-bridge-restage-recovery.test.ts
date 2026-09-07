import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  desktopBridgeServicePaths,
  type DesktopBridgeServiceStatus
} from '../../codex-lb/desktop-service.js';
import type { DesktopBridgeCommandResult } from '../../codex-lb/bridge-contracts.js';
import {
  desktopBridgeRestage,
  runDesktopBridgeRestageStage,
  type DesktopBridgeRestageOptions
} from '../update-migration-state/desktop-bridge-restage.js';

const VERSION = '9.9.9-fixture';

function serviceState(
  version: string | null,
  overrides: Partial<DesktopBridgeServiceStatus> = {}
): DesktopBridgeServiceStatus {
  return {
    ok: version === VERSION,
    running: version !== null,
    loaded: version !== null,
    state: version === null ? null : { pid: 4242, sks_version: version },
    blockers: version && version !== VERSION ? ['desktop_bridge_runtime_version_stale'] : [],
    ...overrides
  } as DesktopBridgeServiceStatus;
}

async function harness(
  t: test.TestContext,
  setup: {
    plist?: boolean;
    settings?: boolean;
    before?: DesktopBridgeServiceStatus;
    after?: DesktopBridgeServiceStatus;
    repairBlockers?: string[];
    repairThrows?: boolean;
  } = {}
) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-restage-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const paths = desktopBridgeServicePaths(home);
  if (setup.plist !== false) {
    await fsp.mkdir(path.dirname(paths.launch_agent_path), { recursive: true });
    await fsp.writeFile(paths.launch_agent_path, '<plist/>', 'utf8');
  }
  await fsp.mkdir(path.dirname(paths.settings_path), { recursive: true });
  if (setup.settings !== false) await fsp.writeFile(paths.settings_path, '{}', 'utf8');

  let current = setup.before || serviceState(null);
  const requests: unknown[] = [];
  const inspections: unknown[] = [];
  const options: DesktopBridgeRestageOptions = {
    home,
    platform: 'darwin',
    packageVersion: VERSION,
    env: { HOME: home, SKS_TEST_ISOLATION: '1' },
    serviceStatus: async (input) => {
      inspections.push(input);
      return current;
    },
    executeCommand: async (request, input) => {
      requests.push({ request, options: input });
      if (setup.repairThrows) throw new Error('repair_fixture_failed');
      current = setup.after || serviceState(VERSION);
      const blockers = setup.repairBlockers || [];
      return {
        schema: 'sks.desktop-bridge-command-result.v1',
        ok: blockers.length === 0,
        execution: { ok: blockers.length === 0, blockers }
      } as DesktopBridgeCommandResult;
    }
  };
  return { home, options, requests, inspections };
}

test('an update repairs a managed bridge that is installed but down', async (t) => {
  const setup = await harness(t);
  const result = await desktopBridgeRestage(setup.options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.actions, [`desktop_bridge_bootstrapped:${VERSION}`]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(setup.requests, [{
    request: { operation: 'repair' },
    options: { home: setup.home, env: setup.options.env, platform: 'darwin' }
  }]);
  assert.equal(setup.inspections.length, 2, 'service is inspected again after repair');
});

test('old serving code uses the shared restaging repair and a repeat update is a no-op', async (t) => {
  const setup = await harness(t, { before: serviceState('9.2.3') });
  const result = await desktopBridgeRestage(setup.options);
  assert.deepEqual(result.actions, [`desktop_bridge_restarted:9.2.3:${VERSION}`]);
  assert.deepEqual(result.warnings, []);
  const repeated = await desktopBridgeRestage(setup.options);
  assert.deepEqual(repeated.actions, ['desktop_bridge_restage_already_current']);
  assert.equal(setup.requests.length, 1);
});

test('a current-version bridge with stale configuration is repaired', async (t) => {
  const setup = await harness(t, {
    before: serviceState(VERSION, {
      ok: false,
      running: false,
      status: 'configuration_mismatch',
      blockers: ['bridge_config_generation_mismatch']
    })
  });
  const result = await desktopBridgeRestage(setup.options);
  assert.equal(setup.requests.length, 1);
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.warnings, []);
});

test('a bridge already running the installed version and configuration is left alone', async (t) => {
  const setup = await harness(t, { before: serviceState(VERSION) });
  const result = await desktopBridgeRestage(setup.options);
  assert.deepEqual(result.actions, ['desktop_bridge_restage_already_current']);
  assert.equal(setup.requests.length, 0);
});

test('repair acknowledgment cannot claim success while the old runtime is still serving', async (t) => {
  const setup = await harness(t, { before: serviceState('9.2.3'), after: serviceState('9.2.3') });
  const result = await desktopBridgeRestage(setup.options);
  assert.equal(result.ok, true, 'bridge readiness stays optional for package migration');
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.blockers, []);
  assert.ok(result.warnings.includes(
    `desktop_bridge_restage_incomplete:desktop_bridge_runtime_version_unverified:9.2.3:${VERSION}`
  ));
  assert.match(result.warnings.at(-1) || '', /sks bridge repair/);
});

test('a failed shared repair is reported without failing package migration', async (t) => {
  const setup = await harness(t, {
    after: serviceState(null, { blockers: ['desktop_bridge_entry_macos_protected_folder'] }),
    repairBlockers: ['desktop_bridge_entry_macos_protected_folder']
  });
  const result = await desktopBridgeRestage(setup.options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.warnings.filter((warning) =>
    warning === 'desktop_bridge_restage_incomplete:desktop_bridge_entry_macos_protected_folder').length, 1);
  assert.match(result.warnings.at(-1) || '', /sks bridge repair/);
});

test('a thrown repair still produces a recovery warning and post-repair inspection', async (t) => {
  const setup = await harness(t, { repairThrows: true });
  const result = await desktopBridgeRestage(setup.options);
  assert.deepEqual(result.actions, []);
  assert.ok(result.warnings.includes('desktop_bridge_restage_incomplete:desktop_bridge_repair_failed'));
  assert.equal(setup.inspections.length, 2);
});

test('no launch agent means there is no installed service to restage', async (t) => {
  const setup = await harness(t, { plist: false });
  const result = await desktopBridgeRestage(setup.options);
  assert.deepEqual(result.actions, ['desktop_bridge_restage_no_launch_agent']);
  assert.equal(setup.requests.length, 0);
  assert.equal(setup.inspections.length, 0);
});

test('a plist without managed settings does not authorize bridge configuration', async (t) => {
  const setup = await harness(t, { settings: false });
  const result = await desktopBridgeRestage(setup.options);
  assert.deepEqual(result.actions, ['desktop_bridge_restage_no_managed_bridge']);
  assert.equal(setup.requests.length, 0);
});

test('the stage entry point refuses the real launchd inside a test runner', async () => {
  const result = await runDesktopBridgeRestageStage();
  assert.equal(result.ok, true);
  assert.deepEqual(result.actions, [process.platform === 'darwin'
    ? 'desktop_bridge_restage_skipped_under_tests'
    : 'desktop_bridge_restage_not_macos']);
});

test('a harness with only one service seam injected cannot reach real launchd', async (t) => {
  const setup = await harness(t);
  const { executeCommand: _unused, ...withoutRepair } = setup.options;
  const result = await desktopBridgeRestage(withoutRepair);
  assert.deepEqual(result.actions, ['desktop_bridge_restage_skipped_under_tests']);
  assert.equal(setup.requests.length, 0);
  assert.equal(setup.inspections.length, 0);
});
