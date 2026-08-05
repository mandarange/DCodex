import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_LB_DESKTOP_BRIDGE_MARKER,
  CODEX_LB_MODEL_CATALOG_MARKER,
  CODEX_LB_OAUTH_SELECTION_MARKER,
  CODEX_LB_PROVIDER_SELECTION_MARKER,
  DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
  DESKTOP_BRIDGE_MANAGED_MARKER,
  DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER,
  releaseSksManagedThirdPartySelection,
  removeDesktopBridgeOrphanManagedMarkers,
  removeCodexLbManagedDesktopConfig,
  upsertDesktopBridgeManagedConfig,
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
const COMBINED_CATALOG = '/Users/op/.codex/sks/sks-bridge-catalog.json';

const OPENROUTER_SELECTED = [
  'model_provider = "openrouter"',
  'model_catalog_json = "/Users/op/.codex/sks-openrouter-catalog.json"',
  '',
  '[model_providers.openrouter]',
  'name = "openrouter"',
  'base_url = "https://openrouter.example/api/v1"',
  'wire_api = "responses"',
  'requires_openai_auth = false',
  ''
].join('\n');

test('8.1.3 managed writer emits one exact bridge binding and is byte-idempotent', () => {
  const source = [
    '# sks-codex-lb-managed-provider-selection',
    'model_provider = "codex-lb"',
    '# sks-codex-lb-managed-openai-base-url',
    `openai_base_url = "${REMOTE}"`,
    CODEX_LB_MODEL_CATALOG_MARKER,
    'model_catalog_json = "/Users/op/.codex/sks-codex-lb-tool-catalog.json"',
    'service_tier = "fast"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${REMOTE}"`,
    'env_key = "CODEX_LB_API_KEY"',
    '',
    '[model_providers.openrouter]',
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    ''
  ].join('\n');
  const result = upsertDesktopBridgeManagedConfig(source, {
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: COMBINED_CATALOG
  });

  assert.match(result, new RegExp(`${DESKTOP_BRIDGE_MANAGED_MARKER}\\nmodel_provider = "openai"`));
  assert.match(result, new RegExp(`${DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER}\\nopenai_base_url = "${BRIDGE}"`));
  assert.match(result, new RegExp(`${DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER}\\nmodel_catalog_json = "${COMBINED_CATALOG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.doesNotMatch(result, /^model_provider\s*=\s*"(?:codex-lb|openrouter|sks-router)"$/m);
  assert.doesNotMatch(result, /# sks-managed-provider-mode:/);
  assert.match(result, /\[model_providers\.codex-lb\]/);
  assert.match(result, /\[model_providers\.openrouter\]/);
  assert.match(result, /^service_tier\s*=\s*"fast"$/m);
  assert.equal(upsertDesktopBridgeManagedConfig(result, {
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: COMBINED_CATALOG
  }), result);
});

test('8.1.3 managed writer fails closed without changing user-owned bindings', () => {
  for (const source of [
    'model_provider = "my-proxy"\n',
    'openai_base_url = "https://user-proxy.example/v1"\n',
    'model_catalog_json = "/Users/op/private-catalog.json"\n',
    'model_provider = "openrouter"\n'
  ]) {
    assert.throws(
      () => upsertDesktopBridgeManagedConfig(source, {
        bridgeBaseUrl: BRIDGE,
        combinedCatalogPath: COMBINED_CATALOG
      }),
      /legacy_user_owned_config_conflict/
    );
  }
  assert.throws(
    () => upsertDesktopBridgeManagedConfig('', {
      bridgeBaseUrl: 'https://remote.example/backend-api/codex',
      combinedCatalogPath: COMBINED_CATALOG
    }),
    /desktop_bridge_loopback_base_url_required/
  );
  assert.throws(
    () => upsertDesktopBridgeManagedConfig([
      'model_catalog_json = "/Users/op/.codex/sks-openrouter-catalog.json"',
      '',
      '[model_providers.openrouter]',
      'base_url = "https://openrouter.ai/api/v1"',
      ''
    ].join('\n'), {
      bridgeBaseUrl: BRIDGE,
      combinedCatalogPath: COMBINED_CATALOG
    }),
    /legacy_user_owned_config_conflict:model_catalog_json/
  );
});

test('8.1.3 orphan cleanup removes comments only when their managed value is absent', () => {
  const source = [
    DESKTOP_BRIDGE_MANAGED_MARKER,
    DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
    `openai_base_url = "${BRIDGE}"`,
    DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER,
    'service_tier = "fast"',
    ''
  ].join('\n');
  const cleanup = removeDesktopBridgeOrphanManagedMarkers(source);
  assert.equal(cleanup.changed, true);
  assert.deepEqual(cleanup.orphan_markers, [
    DESKTOP_BRIDGE_MANAGED_MARKER,
    DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER
  ]);
  assert.doesNotMatch(cleanup.text, new RegExp(`^${DESKTOP_BRIDGE_MANAGED_MARKER}$`, 'm'));
  assert.match(cleanup.text, new RegExp(DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER));
  assert.match(cleanup.text, /^service_tier = "fast"$/m);
});

test('explicit provider switches reclaim an SKS-authored OpenRouter selection', () => {
  // Use Codex LB takes over: openrouter selection + catalog released, its
  // provider table (credentials) preserved for a later switch back.
  const cli = upsertCodexLbCliProviderConfig(OPENROUTER_SELECTED, {
    remoteBaseUrl: REMOTE,
    selectGlobally: true
  });
  assert.match(cli, new RegExp(`${CODEX_LB_PROVIDER_SELECTION_MARKER}\\nmodel_provider = "codex-lb"`));
  assert.doesNotMatch(cli, /model_provider = "openrouter"/);
  assert.doesNotMatch(cli, /^model_catalog_json\s*=/m);
  assert.match(cli, /\[model_providers\.openrouter\]/);

  // Credential-only writes never move the selection.
  const unselected = upsertCodexLbCliProviderConfig(OPENROUTER_SELECTED, { remoteBaseUrl: REMOTE });
  assert.match(unselected, /model_provider = "openrouter"/);

  // Desktop Bridge takeover works from the same state.
  const bridge = upsertCodexLbNativeDesktopConfig(OPENROUTER_SELECTED, {
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE
  });
  assert.match(bridge, /model_provider = "openai"/);
  assert.doesNotMatch(bridge, /model_provider = "openrouter"/);

  // The release helper itself: no SKS provider table means user-owned — untouched.
  const handWritten = 'model_provider = "openrouter"\n';
  assert.equal(releaseSksManagedThirdPartySelection(handWritten), handWritten);

  // A genuinely user-owned custom provider still fails closed.
  assert.throws(
    () => upsertCodexLbCliProviderConfig('model_provider = "my-proxy"\n', {
      remoteBaseUrl: REMOTE,
      selectGlobally: true
    }),
    /codex_lb_user_owned_model_provider_conflict/
  );
});

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

test('CLI ON atomically selects the provider and OFF restores built-in OAuth selection', () => {
  const enabled = upsertCodexLbCliProviderConfig(
    'model_provider = "openai"\nservice_tier = "fast"\n',
    { remoteBaseUrl: REMOTE, selectGlobally: true }
  );
  assert.match(enabled, new RegExp(`${CODEX_LB_PROVIDER_SELECTION_MARKER}\\nmodel_provider = "codex-lb"`));
  assert.match(enabled, /\[model_providers\.codex-lb\]/);
  assert.match(enabled, new RegExp(`base_url = "${REMOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));

  const repaired = upsertCodexLbCliProviderConfig(enabled, {
    remoteBaseUrl: 'https://new.example.test/backend-api/codex',
    selectGlobally: true
  });
  assert.match(repaired, /^model_provider\s*=\s*"codex-lb"$/m);
  assert.match(repaired, /base_url = "https:\/\/new\.example\.test\/backend-api\/codex"/);

  const disabled = removeCodexLbManagedDesktopConfig(repaired);
  assert.match(disabled, new RegExp(`${CODEX_LB_OAUTH_SELECTION_MARKER}\\nmodel_provider = "openai"`));
  assert.doesNotMatch(disabled, /^model_provider\s*=\s*"codex-lb"$/m);
  assert.match(disabled, /^service_tier\s*=\s*"fast"$/m);
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
