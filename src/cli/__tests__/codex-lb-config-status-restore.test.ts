import '../../core/__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  capturePostinstallCodexLbConfigSnapshot,
  codexLbStatus,
  formatCodexLbStatusText,
  restorePostinstallCodexLbConfigSnapshot
} from '../install-helpers.js';
import {
  CODEX_LB_DESKTOP_BRIDGE_MARKER,
  CODEX_LB_DESKTOP_COMPAT_MARKER,
  CODEX_LB_MODEL_CATALOG_MARKER,
  CODEX_LB_OAUTH_SELECTION_MARKER,
  CODEX_LB_PROVIDER_SELECTION_MARKER,
  LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER,
  removeCodexLbManagedDesktopConfig,
  removeCodexLbOrphanManagedMarkers,
  removeCodexLbSharedOpenAiRouting,
  upsertCodexLbCliProviderConfig,
  upsertCodexLbNativeDesktopConfig
} from '../install-helpers-codex-lb-config.js';

const REMOTE = 'https://lb.example.test/backend-api/codex';
const BRIDGE = 'http://127.0.0.1:47821/backend-api/codex';
const API_KEY = 'sk-clb-test-value-not-real';

const SELECTED_CONFIG = [
  CODEX_LB_PROVIDER_SELECTION_MARKER,
  'model_provider = "codex-lb"',
  '',
  '[model_providers.codex-lb]',
  'name = "codex-lb"',
  `base_url = "${REMOTE}"`,
  'wire_api = "responses"',
  'env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }',
  'supports_websockets = true',
  'requires_openai_auth = false',
  ''
].join('\n');

async function fixture(t: test.TestContext) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-config-status-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const envPath = path.join(codexHome, 'sks-codex-lb.env');
  const authPath = path.join(codexHome, 'auth.json');
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.writeFile(envPath, `export CODEX_LB_BASE_URL='${REMOTE}'\nexport CODEX_LB_API_KEY='${API_KEY}'\n`, { mode: 0o600 });
  await fsp.writeFile(authPath, `${JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'test-oauth' } })}\n`, { mode: 0o600 });
  return { home, configPath, envPath, authPath };
}

function statusOptions(home: string) {
  return {
    home,
    processEnv: {},
    securityBin: '/usr/bin/false',
    launchctlBin: '/usr/bin/false',
    syncLaunchEnv: false
  };
}

test('CLI ON returns one atomic definition plus selection config', (t) => {
  const enabled = upsertCodexLbCliProviderConfig('', {
    remoteBaseUrl: REMOTE,
    selectGlobally: true
  });
  assert.equal(enabled, SELECTED_CONFIG);
  t.diagnostic(`atomic CLI ON config:\n${enabled}`);
});

test('OFF restores the built-in OpenAI selection while retaining the provider definition', () => {
  const disabled = removeCodexLbManagedDesktopConfig(SELECTED_CONFIG);
  assert.match(disabled, new RegExp(`${CODEX_LB_OAUTH_SELECTION_MARKER}\\nmodel_provider = "openai"`));
  assert.match(disabled, /\[model_providers\.codex-lb\]/);
  assert.doesNotMatch(disabled, new RegExp(CODEX_LB_PROVIDER_SELECTION_MARKER));
});

test('marker-only residue is detected and removed without exposing config content', () => {
  const markerOnly = [
    CODEX_LB_DESKTOP_BRIDGE_MARKER,
    CODEX_LB_DESKTOP_COMPAT_MARKER,
    CODEX_LB_MODEL_CATALOG_MARKER,
    CODEX_LB_PROVIDER_SELECTION_MARKER,
    CODEX_LB_OAUTH_SELECTION_MARKER,
    LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER,
    'service_tier = "fast"',
    ''
  ].join('\n');
  const cleanup = removeCodexLbOrphanManagedMarkers(markerOnly);
  assert.equal(cleanup.schema, 'sks.codex-lb-orphan-managed-marker-cleanup.v1');
  assert.equal(cleanup.changed, true);
  assert.deepEqual(cleanup.orphan_markers, [
    CODEX_LB_DESKTOP_BRIDGE_MARKER,
    LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER,
    CODEX_LB_DESKTOP_COMPAT_MARKER,
    CODEX_LB_MODEL_CATALOG_MARKER,
    CODEX_LB_PROVIDER_SELECTION_MARKER,
    CODEX_LB_OAUTH_SELECTION_MARKER
  ]);
  assert.equal(cleanup.text, 'service_tier = "fast"\n');

  const legacyRemoval = removeCodexLbSharedOpenAiRouting(
    `${LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER}\nservice_tier = "fast"\n`,
    REMOTE
  );
  assert.equal(legacyRemoval.changed, true);
  assert.doesNotMatch(legacyRemoval.text, /sks-codex-lb-managed-openai-base-url/);
});

test('use-cli and use-desktop-full auto-migrate an orphan legacy marker but reject legacy routing content', () => {
  const orphan = `${LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER}\nservice_tier = "fast"\n`;
  const cli = upsertCodexLbCliProviderConfig(orphan, { remoteBaseUrl: REMOTE, selectGlobally: true });
  assert.doesNotMatch(cli, /sks-codex-lb-managed-openai-base-url/);
  assert.match(cli, new RegExp(`${CODEX_LB_PROVIDER_SELECTION_MARKER}\\nmodel_provider = "codex-lb"`));

  const desktop = upsertCodexLbNativeDesktopConfig(orphan, {
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE
  });
  assert.doesNotMatch(desktop, /sks-codex-lb-managed-openai-base-url/);
  assert.match(desktop, new RegExp(`${CODEX_LB_DESKTOP_BRIDGE_MARKER}\\nopenai_base_url = "${BRIDGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));

  const ambiguous = `${LEGACY_CODEX_LB_OPENAI_ROUTING_MARKER}\nopenai_base_url = "${REMOTE}"\n`;
  assert.throws(
    () => upsertCodexLbCliProviderConfig(ambiguous, { remoteBaseUrl: REMOTE, selectGlobally: true }),
    /codex_lb_legacy_desktop_config_requires_migration/
  );
  assert.throws(
    () => upsertCodexLbNativeDesktopConfig(ambiguous, { bridgeBaseUrl: BRIDGE, remoteBaseUrl: REMOTE }),
    /codex_lb_legacy_desktop_config_requires_migration/
  );
});

test('status warns when the provider is defined but no CLI or Desktop route is selected', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(setup.configPath, SELECTED_CONFIG.replace(
    `${CODEX_LB_PROVIDER_SELECTION_MARKER}\nmodel_provider = "codex-lb"\n\n`,
    ''
  ));
  const status = await codexLbStatus(statusOptions(setup.home));
  assert.equal(status.ok, true);
  assert.ok(status.warnings.includes('codex_lb_defined_but_not_selected'));
  assert.deepEqual(status.blockers, []);
  assert.match(status.activation_guidance.join('\n'), /sks codex-lb use-cli/);
  assert.match(status.activation_guidance.join('\n'), /sks codex-lb use-desktop-full/);
  assert.match(formatCodexLbStatusText(status, { home: setup.home }), /Warning \[codex_lb_defined_but_not_selected\]/);
});

test('defined-not-selected warning is suppressed while managed Desktop bridge mode is active', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(setup.configPath, upsertCodexLbNativeDesktopConfig('', {
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE
  }));
  const status = await codexLbStatus(statusOptions(setup.home));
  assert.equal(status.desktop_mode, 'desktop-native-bridge');
  assert.ok(!status.warnings.includes('codex_lb_defined_but_not_selected'));
});

test('postinstall restores selected and unselected CLI snapshots without changing OAuth', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(setup.configPath, SELECTED_CONFIG);
  const selectedSnapshot = await capturePostinstallCodexLbConfigSnapshot(setup.home);
  await fsp.writeFile(setup.configPath, 'service_tier = "fast"\n');
  const selectedRestore = await restorePostinstallCodexLbConfigSnapshot(selectedSnapshot);
  assert.equal(selectedRestore.status, 'restored');
  assert.match(await fsp.readFile(setup.configPath, 'utf8'), new RegExp(`${CODEX_LB_PROVIDER_SELECTION_MARKER}\\nmodel_provider = "codex-lb"`));

  await fsp.writeFile(setup.configPath, upsertCodexLbCliProviderConfig('', {
    remoteBaseUrl: REMOTE,
    selectGlobally: false
  }));
  const unselectedSnapshot = await capturePostinstallCodexLbConfigSnapshot(setup.home);
  await fsp.writeFile(setup.configPath, 'service_tier = "fast"\n');
  const unselectedRestore = await restorePostinstallCodexLbConfigSnapshot(unselectedSnapshot);
  assert.equal(unselectedRestore.status, 'restored');
  assert.doesNotMatch(await fsp.readFile(setup.configPath, 'utf8'), /^model_provider\s*=\s*"codex-lb"/m);
  assert.equal(JSON.parse(await fsp.readFile(setup.authPath, 'utf8')).auth_mode, 'chatgpt');
});

test('missing-key status guidance names the env file, setup command, and environment alternative', () => {
  const text = formatCodexLbStatusText({
    ok: false,
    selected: false,
    provider_configured: true,
    provider_contract_ok: true,
    env_key_configured: false,
    warnings: [],
    activation_guidance: []
  });
  assert.match(text, /~\/\.codex\/sks-codex-lb\.env/);
  assert.match(text, /sks codex-lb setup --host <domain> --api-key-stdin/);
  assert.match(text, /CODEX_LB_API_KEY in the environment/);
});
