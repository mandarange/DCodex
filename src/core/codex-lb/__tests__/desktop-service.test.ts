import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_LB_DESKTOP_BRIDGE_SETTINGS_SCHEMA,
  defaultDesktopBridgeServiceSettings,
  desktopBridgeServicePaths,
  desktopBridgeServiceStatus,
  readDesktopBridgeServiceSettings,
  resolveDesktopBridgeActivationSettings,
  writeDesktopBridgeServiceSettings
} from '../desktop-service.js';
import { renderDesktopBridgeLaunchdPlist } from '../desktop-bridge/launchd.js';

async function fixture(t: test.TestContext) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-desktop-service-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return { home, paths: desktopBridgeServicePaths(home) };
}

test('first activation selects a random available high port and persists only nonsecret settings', async (t) => {
  const setup = await fixture(t);
  let selections = 0;
  const settings = await resolveDesktopBridgeActivationSettings({
    home: setup.home,
    selectAvailablePort: async (host) => {
      selections += 1;
      assert.equal(host, '127.0.0.1');
      return 54_321;
    }
  });

  assert.equal(settings.listen_port, 54_321);
  assert.equal(settings.route_policy.default_provider_id, null);
  assert.equal(settings.provider_registry.providers['codex-lb'].enabled, false);
  assert.equal(selections, 1);
  await writeDesktopBridgeServiceSettings(setup.paths.settings_path, settings);
  const raw = await fsp.readFile(setup.paths.settings_path, 'utf8');
  const stat = await fsp.stat(setup.paths.settings_path);
  assert.equal(stat.mode & 0o077, 0);
  assert.doesNotMatch(raw, /"(?:api_key|secret|authorization|cookie|access_token|refresh_token)"\s*:|Bearer\s+[A-Za-z0-9._~-]{8,}/i);

  const reused = await resolveDesktopBridgeActivationSettings({
    home: setup.home,
    selectAvailablePort: async () => {
      throw new Error('persisted port must be reused');
    }
  });
  assert.equal(reused.listen_port, 54_321);
  assert.deepEqual(await readDesktopBridgeServiceSettings(setup.paths.settings_path), settings);
});

test('launchd plist rejects secret-bearing arguments and contains no secret environment', () => {
  const plist = renderDesktopBridgeLaunchdPlist({
    executablePath: '/usr/local/bin/sks',
    arguments: ['bridge', 'serve', '--settings', '/tmp/settings.json'],
    stdoutPath: '/tmp/bridge.out.log',
    stderrPath: '/tmp/bridge.err.log'
  });
  assert.match(plist, /com\.sneakoscope\.codex-lb-desktop-bridge/);
  assert.doesNotMatch(plist, /EnvironmentVariables|CODEX_LB_API_KEY|X-Codex-LB-API-Key/);
  assert.throws(
    () => renderDesktopBridgeLaunchdPlist({
      executablePath: '/usr/local/bin/sks',
      arguments: ['bridge', 'serve', '--api-key=secret'],
      stdoutPath: '/tmp/bridge.out.log',
      stderrPath: '/tmp/bridge.err.log'
    }),
    /bridge_launchd_secret_argument_forbidden/
  );
});

test('desktop bridge service is explicitly unsupported away from macOS', async (t) => {
  const setup = await fixture(t);
  await writeDesktopBridgeServiceSettings(
    setup.paths.settings_path,
    defaultDesktopBridgeServiceSettings({ listen_port: 54_321 })
  );
  const status = await desktopBridgeServiceStatus({
    home: setup.home,
    platform: 'linux'
  });
  assert.equal(status.ok, false);
  assert.equal(status.supported, false);
  assert.equal(status.status, 'unsupported');
  assert.deepEqual(status.blockers, ['desktop_bridge_service_requires_macos']);
});
