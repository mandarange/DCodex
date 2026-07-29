import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_LB_DESKTOP_BRIDGE_MARKER,
  CODEX_LB_MODEL_CATALOG_MARKER,
  removeCodexLbManagedDesktopConfig,
  upsertCodexLbCliProviderConfig,
  upsertCodexLbCompatDesktopConfig,
  upsertCodexLbNativeDesktopConfig
} from '../../../cli/install-helpers-codex-lb-config.js';
import {
  DEFAULT_CODEX_LB_DESKTOP_MODE,
  modeMayMutateSharedAuth,
  modeRequiresChatGptOAuth,
  parseCodexLbDesktopMode,
  parseCodexLbGatewayAuthTransport
} from '../desktop-mode.js';

const REMOTE = 'https://lb.example.test/backend-api/codex';
const BRIDGE = 'http://127.0.0.1:47821/backend-api/codex';

test('desktop mode SSOT keeps every ordinary mode away from shared auth mutation', () => {
  assert.equal(DEFAULT_CODEX_LB_DESKTOP_MODE, 'desktop-native-bridge');
  assert.equal(parseCodexLbDesktopMode('desktop-dual-auth-compat'), 'desktop-dual-auth-compat');
  assert.equal(parseCodexLbGatewayAuthTransport('authorization-bearer-compat'), 'authorization-bearer-compat');
  assert.equal(modeRequiresChatGptOAuth('desktop-native-bridge'), true);
  assert.equal(modeRequiresChatGptOAuth('desktop-dual-auth-compat'), true);
  for (const mode of ['desktop-native-bridge', 'desktop-dual-auth-compat', 'cli-provider', 'disabled'] as const) {
    assert.equal(modeMayMutateSharedAuth(mode), false);
  }
  assert.throws(() => parseCodexLbDesktopMode('oauth-replacement'), /unsupported_codex_lb_desktop_mode/);
});

test('native Desktop mode retains built-in OpenAI and removes only SKS-owned legacy pins', () => {
  const legacy = [
    '# sks-codex-lb-managed-desktop-compat',
    'model_provider = "codex-lb"',
    CODEX_LB_DESKTOP_BRIDGE_MARKER,
    `openai_base_url = "${REMOTE}"`,
    CODEX_LB_MODEL_CATALOG_MARKER,
    'model_catalog_json = "/tmp/sks-catalog.json"',
    'service_tier = "fast"',
    '',
    '[model_providers.codex-lb]',
    'name = "OpenAI"',
    `base_url = "${REMOTE}"`,
    'requires_openai_auth = true',
    ''
  ].join('\n');
  const result = upsertCodexLbNativeDesktopConfig(legacy, {
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE
  });

  assert.doesNotMatch(result, /^model_provider\s*=\s*"codex-lb"/m);
  assert.match(result, new RegExp(`${CODEX_LB_DESKTOP_BRIDGE_MARKER}\\nopenai_base_url = "${BRIDGE}"`));
  assert.doesNotMatch(result, /^model_catalog_json\s*=/m);
  assert.match(result, /^service_tier\s*=\s*"fast"$/m);
  assert.match(result, /^name\s*=\s*"codex-lb"$/m);
  assert.match(result, /^env_key\s*=\s*"CODEX_LB_API_KEY"$/m);
  assert.match(result, /^requires_openai_auth\s*=\s*false$/m);
});

test('native Desktop mode fails closed on user-owned catalog, routing, and provider conflicts', () => {
  const userCatalog = 'model_catalog_json = "/Users/example/private-catalog.json"\n';
  assert.throws(
    () => upsertCodexLbNativeDesktopConfig(userCatalog, {
      bridgeBaseUrl: BRIDGE,
      remoteBaseUrl: REMOTE
    }),
    /codex_lb_user_owned_model_catalog_json_conflict/
  );

  assert.throws(
    () => upsertCodexLbNativeDesktopConfig(
      'openai_base_url = "https://user-proxy.example.test/v1"\n',
      { bridgeBaseUrl: BRIDGE, remoteBaseUrl: REMOTE }
    ),
    /codex_lb_user_owned_openai_base_url_conflict/
  );
  assert.throws(
    () => upsertCodexLbNativeDesktopConfig(
      'model_provider = "openrouter"\n',
      { bridgeBaseUrl: BRIDGE, remoteBaseUrl: REMOTE }
    ),
    /codex_lb_user_owned_model_provider_conflict/
  );
  assert.throws(
    () => upsertCodexLbNativeDesktopConfig(
      [
        'model_provider = "codex-lb"',
        '# sks-codex-lb-managed-openai-base-url',
        `openai_base_url = "${REMOTE}"`,
        ''
      ].join('\n'),
      { bridgeBaseUrl: BRIDGE, remoteBaseUrl: REMOTE }
    ),
    /codex_lb_legacy_desktop_config_requires_migration/
  );
});

test('compat mode uses exact OpenAI identity and a separate gateway header', () => {
  const result = upsertCodexLbCompatDesktopConfig('', { remoteBaseUrl: REMOTE });
  assert.match(result, /^model_provider\s*=\s*"codex-lb"$/m);
  assert.match(result, /^name\s*=\s*"OpenAI"$/m);
  assert.doesNotMatch(result, /^env_key\s*=/m);
  assert.match(result, /X-Codex-LB-API-Key/);
  assert.match(result, /^requires_openai_auth\s*=\s*true$/m);

  const disabled = removeCodexLbManagedDesktopConfig(result);
  assert.doesNotMatch(disabled, /^model_provider\s*=\s*"codex-lb"$/m);
  assert.match(disabled, /\[model_providers\.codex-lb\]/);
});

test('routing and gateway-auth modes preserve native Codex feature configuration', () => {
  const nativeFeatureConfig = [
    'model = "gpt-5.6-sol"',
    'service_tier = "fast"',
    '',
    '[features]',
    'fast_mode = false',
    'image_generation = true',
    'computer_use = true',
    'web_search = true',
    'apps = true',
    'multi_agent_v2 = true',
    ''
  ].join('\n');
  const variants = [
    upsertCodexLbNativeDesktopConfig(nativeFeatureConfig, {
      bridgeBaseUrl: BRIDGE,
      remoteBaseUrl: REMOTE
    }),
    upsertCodexLbCompatDesktopConfig(nativeFeatureConfig, {
      remoteBaseUrl: REMOTE
    }),
    upsertCodexLbCliProviderConfig(nativeFeatureConfig, {
      remoteBaseUrl: REMOTE,
      selectGlobally: false
    }),
    removeCodexLbManagedDesktopConfig(
      upsertCodexLbCompatDesktopConfig(nativeFeatureConfig, {
        remoteBaseUrl: REMOTE
      })
    )
  ];

  for (const result of variants) {
    assert.match(result, /^model\s*=\s*"gpt-5\.6-sol"$/m);
    assert.match(result, /^service_tier\s*=\s*"fast"$/m);
    for (const line of [
      'fast_mode = false',
      'image_generation = true',
      'computer_use = true',
      'web_search = true',
      'apps = true',
      'multi_agent_v2 = true'
    ]) {
      assert.match(result, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    }
  }
});
