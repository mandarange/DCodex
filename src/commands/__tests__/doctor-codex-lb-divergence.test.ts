import '../../core/__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectDoctorCodexLbDivergence } from '../doctor.js';

const CANONICAL_KEY = 'sk-clb-canonical-doctor-fixture';

function loaded() {
  return {
    configured: true,
    secret_api_key: CANONICAL_KEY,
    base_url: 'https://lb.example.test/backend-api/codex'
  } as any;
}

function launch(ok: boolean, blockers: string[] = []) {
  return {
    schema: 'sks.codex-lb-desktop-center-credential-inspection.v1',
    ok,
    status: ok ? 'launchd_selection_state_matched' : 'launchd_selection_state_mismatch',
    mode: 'cli-provider',
    expected_api_key_sha256: null,
    launch_api_key_sha256: null,
    launch_api_key_present: !ok,
    blockers,
    operator_actions: []
  } as any;
}

test('Doctor emits exact defined/unselected and stale ambient diagnostics without key material', async () => {
  let launchMode = '';
  const result = await inspectDoctorCodexLbDivergence({
    home: '/fixture/home',
    processEnv: { HOME: '/fixture/home', CODEX_LB_API_KEY: 'stale-shell-key' },
    providerStatus: {
      provider_configured: true,
      selected: false,
      desktop_mode: 'disabled',
      config_path: '/fixture/home/.codex/config.toml',
      env_path: '/fixture/home/.codex/sks-codex-lb.env'
    }
  }, {
    readTextImpl: async () => '[model_providers.codex-lb]\nenv_key = "CODEX_LB_API_KEY"\n',
    loadEnvImpl: async () => loaded(),
    inspectLaunchImpl: async (options: any) => {
      launchMode = options.mode;
      return launch(true);
    }
  });

  assert.deepEqual(result.warnings, [
    'codex_lb_defined_but_not_selected',
    'codex_lb_stale_ambient_key'
  ]);
  assert.ok(!result.blockers.includes('codex_lb_stale_ambient_key'));
  assert.equal(launchMode, 'disabled');
  assert.ok(result.operator_actions.some((entry: string) => entry.includes('unset CODEX_LB_API_KEY')));
  assert.equal(result.ambient_key.sha256, createHash('sha256').update('stale-shell-key').digest('hex'));
  assert.ok(!JSON.stringify(result).includes('stale-shell-key'));
  assert.ok(!JSON.stringify(result).includes(CANONICAL_KEY));
});

test('Doctor --fix receipts orphan cleanup and reconciles launchd through injected fakes', async () => {
  const marker = '# sks-codex-lb-managed-provider-selection';
  let launchMatched = false;
  let written = '';
  const result = await inspectDoctorCodexLbDivergence({
    home: '/fixture/home',
    processEnv: { HOME: '/fixture/home' },
    fix: true,
    providerStatus: {
      provider_configured: true,
      selected: true,
      desktop_mode: 'cli-provider',
      config_path: '/fixture/home/.codex/config.toml',
      env_path: '/fixture/home/.codex/sks-codex-lb.env'
    }
  }, {
    readTextImpl: async () => `${marker}\n[model_providers.codex-lb]\nenv_key = "CODEX_LB_API_KEY"\n`,
    writeConfigImpl: async (_path: string, _before: string, next: string) => {
      written = next;
      return { ok: true, changed: true, backup_path: '/fixture/backup' };
    },
    loadEnvImpl: async () => loaded(),
    inspectLaunchImpl: async () => launch(launchMatched, launchMatched ? [] : ['codex_lb_launchd_key_mismatch']),
    syncLaunchImpl: async () => {
      launchMatched = true;
      return { ok: true, status: 'cli_provider_launch_credentials_set' };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.orphan_markers, [marker]);
  assert.equal(result.orphan_marker_repair.attempted, true);
  assert.equal(result.orphan_marker_repair.changed, true);
  assert.ok(result.orphan_marker_repair.receipt.backup_path);
  assert.doesNotMatch(written, /managed-provider-selection/);
  assert.equal(result.launchd.before.ok, false);
  assert.equal(result.launchd.after.ok, true);
});

test('Doctor treats bridge mode as active without a defined-not-selected warning', async () => {
  let launchMode = '';
  const result = await inspectDoctorCodexLbDivergence({
    home: '/fixture/home',
    processEnv: { HOME: '/fixture/home' },
    providerStatus: {
      provider_configured: true,
      selected: false,
      desktop_mode: 'desktop-native-bridge',
      config_path: '/fixture/home/.codex/config.toml',
      env_path: '/fixture/home/.codex/sks-codex-lb.env'
    }
  }, {
    readTextImpl: async () => '[model_providers.codex-lb]\nenv_key = "CODEX_LB_API_KEY"\n',
    loadEnvImpl: async () => loaded(),
    inspectLaunchImpl: async (options: any) => {
      launchMode = options.mode;
      return launch(true);
    }
  });

  assert.ok(!result.warnings.includes('codex_lb_defined_but_not_selected'));
  assert.equal(launchMode, 'desktop-native-bridge');
});
