import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
  MULTI_PROVIDER_ROUTER_ID,
  multiProviderRouterStatus,
  normalizeMultiProviderRouterBaseUrl,
  testMultiProviderRouter,
  useMultiProviderRouter
} from '../multi-provider-router.js';
import { validateCodexConfigRoundTrip } from '../../codex/codex-config-toml.js';
import {
  catalogModel,
  configuredRouterToml,
  escapeRegExp,
  makeMultiProviderRouterHarness,
  routerModelsFetch,
  skippedRouterRestart
} from './multi-provider-router-fixtures.js';

test('multi-provider router accepts loopback /v1 endpoints and rejects remote endpoints', () => {
  assert.deepEqual(normalizeMultiProviderRouterBaseUrl('http://localhost:10100'), {
    ok: true,
    value: 'http://localhost:10100/v1',
    blocker: null
  });
  assert.deepEqual(normalizeMultiProviderRouterBaseUrl('https://127.0.0.1:10100/v1/'), {
    ok: true,
    value: 'https://127.0.0.1:10100/v1',
    blocker: null
  });
  assert.deepEqual(normalizeMultiProviderRouterBaseUrl('http://[::1]:10100/v1/'), {
    ok: true,
    value: 'http://[::1]:10100/v1',
    blocker: null
  });
  assert.deepEqual(normalizeMultiProviderRouterBaseUrl(MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL), {
    ok: true,
    value: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    blocker: null
  });
  assert.deepEqual(normalizeMultiProviderRouterBaseUrl('https://router.example.com/v1'), {
    ok: false,
    value: null,
    blocker: 'multi_provider_router_requires_loopback'
  });
  assert.equal(
    normalizeMultiProviderRouterBaseUrl('http://localhost.example.com:10100/v1').blocker,
    'multi_provider_router_requires_loopback'
  );
  assert.equal(
    normalizeMultiProviderRouterBaseUrl('http://user:secret@127.0.0.1:10100/v1').blocker,
    'multi_provider_router_base_url_contains_credentials_or_query'
  );
  assert.equal(
    normalizeMultiProviderRouterBaseUrl('http://127.0.0.1:10100/v1?token=secret').blocker,
    'multi_provider_router_base_url_contains_credentials_or_query'
  );
  assert.equal(
    normalizeMultiProviderRouterBaseUrl('http://127.0.0.1:10100/api/v1').blocker,
    'multi_provider_router_base_url_must_end_in_v1'
  );
  assert.equal(
    normalizeMultiProviderRouterBaseUrl('file:///tmp/router').blocker,
    'multi_provider_router_base_url_protocol_unsupported'
  );
});

test('router discovers and normalizes the live catalog from the loopback /v1/models endpoint', async (t) => {
  const harness = await makeMultiProviderRouterHarness();
  t.after(async () => fs.rm(harness.temp, { recursive: true, force: true }));
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({
      data: [
        { id: ' anthropic/claude-sonnet ' },
        { model: 'google/gemini-pro' },
        { slug: 'anthropic/claude-sonnet' },
        { name: 'invalid model slug' },
        null
      ]
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  const result: any = await testMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    catalogPath: harness.catalogPath,
    baseUrl: 'http://127.0.0.1:10100',
    model: 'anthropic/claude-sonnet',
    fetchImpl
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(requestUrl, 'http://127.0.0.1:10100/v1/models');
  assert.equal(requestInit?.method, 'GET');
  assert.equal(requestInit?.redirect, 'error');
  assert.equal(new Headers(requestInit?.headers).get('accept'), 'application/json');
  assert.deepEqual(result.probe.models, [
    'anthropic/claude-sonnet',
    'google/gemini-pro'
  ]);
  assert.equal(result.live_model_count, 2);
  assert.equal(result.live_model_present, true);
});

test('router test requires the requested model in both the configured catalog and live router', async (t) => {
  const harness = await makeMultiProviderRouterHarness();
  t.after(async () => fs.rm(harness.temp, { recursive: true, force: true }));

  const ready: any = await testMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    catalogPath: harness.catalogPath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude-sonnet',
    fetchImpl: routerModelsFetch()
  });
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(ready.live_model_present, true);

  const absent = await testMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    catalogPath: harness.catalogPath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude-sonnet',
    fetchImpl: routerModelsFetch(['google/gemini-pro'])
  });
  assert.equal(absent.ok, false);
  assert.ok(absent.blockers.includes('multi_provider_router_model_not_live'));

  let catalogMissFetches = 0;
  const outsideCatalog = await testMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    catalogPath: harness.catalogPath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'mistral/large',
    fetchImpl: (async () => {
      catalogMissFetches += 1;
      return new Response('{}');
    }) as typeof fetch
  });
  assert.equal(outsideCatalog.ok, false);
  assert.ok(outsideCatalog.blockers.includes('multi_provider_router_model_not_in_catalog'));
  assert.equal(catalogMissFetches, 0);

  const invalidSlug = await testMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    catalogPath: harness.catalogPath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude sonnet',
    fetchImpl: routerModelsFetch()
  });
  assert.equal(invalidSlug.ok, false);
  assert.ok(invalidSlug.blockers.includes('multi_provider_router_model_invalid'));
});

test('router activation writes a user-level provider and catalog without storing credentials', async (t) => {
  const harness = await makeMultiProviderRouterHarness();
  t.after(async () => fs.rm(harness.temp, { recursive: true, force: true }));
  await fs.writeFile(harness.configPath, [
    'approval_policy = "on-request"',
    '',
    '[features]',
    'hooks = true',
    ''
  ].join('\n'));

  const result: any = await useMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    configPath: harness.configPath,
    catalogPath: harness.catalogPath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude-sonnet',
    restartApp: true,
    fetchImpl: routerModelsFetch(),
    restartImpl: async () => ({
      schema: 'sks.codex-app-restart.v1',
      ok: true,
      status: 'restarted',
      app_name: 'Codex',
      blockers: []
    })
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.config_applied, true);
  assert.equal(result.restart_ok, true);
  assert.equal(result.desktop_picker?.models_cache_invalidated, true);
  assert.equal(result.models_cache?.ok, true);
  assert.equal(result.restart_completed, true);
  assert.equal(result.runtime_verified, false);
  assert.equal(result.status, 'configured_restarted');

  const config = await fs.readFile(harness.configPath, 'utf8');
  assert.match(config, new RegExp(`^model_provider = "${MULTI_PROVIDER_ROUTER_ID}"$`, 'm'));
  assert.match(config, /^model = "anthropic\/claude-sonnet"$/m);
  assert.match(config, new RegExp(`^model_catalog_json = ${escapeRegExp(JSON.stringify(harness.catalogPath))}$`, 'm'));
  assert.match(config, new RegExp(`^\\[model_providers\\.${MULTI_PROVIDER_ROUTER_ID}\\]$`, 'm'));
  assert.match(config, /^name = "SKS Multi-Provider Router"$/m);
  assert.match(config, /^base_url = "http:\/\/127\.0\.0\.1:10100\/v1"$/m);
  assert.match(config, /^wire_api = "responses"$/m);
  assert.match(config, /^requires_openai_auth = false$/m);
  assert.doesNotMatch(
    config,
    /env_key|http_headers|env_http_headers|experimental_bearer_token|bearer_token|\[model_providers\.sks-router\.auth\]/
  );
  assert.equal(validateCodexConfigRoundTrip(config).ok, true);

  const status = await multiProviderRouterStatus({
    home: harness.home,
    env: harness.env,
    configPath: harness.configPath
  });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.selected, true);
  assert.equal(status.active_model, 'anthropic/claude-sonnet');
  assert.equal(status.active_model_present, true);
  assert.equal(status.provider_contract_ok, true);
  assert.equal(status.runtime_verified, false);
  assert.equal(status.status, 'configured');
});

test('router rejects provider contract drift when explicit no-auth isolation is missing', async (t) => {
  const harness = await makeMultiProviderRouterHarness();
  t.after(async () => fs.rm(harness.temp, { recursive: true, force: true }));
  await fs.writeFile(harness.configPath, configuredRouterToml(harness.catalogPath)
    .replace('requires_openai_auth = false\n', ''));

  const status = await multiProviderRouterStatus({
    home: harness.home,
    env: harness.env,
    configPath: harness.configPath
  });
  assert.equal(status.provider_contract_ok, false);
  assert.ok(status.blockers.includes('multi_provider_router_provider_contract_drift'));

  await fs.writeFile(harness.configPath, `${configuredRouterToml(harness.catalogPath)}
[model_providers.${MULTI_PROVIDER_ROUTER_ID}.http_headers]
Authorization = "secret"
`);
  const nestedCredentialStatus = await multiProviderRouterStatus({
    home: harness.home,
    env: harness.env,
    configPath: harness.configPath
  });
  assert.equal(nestedCredentialStatus.provider_contract_ok, false);
  assert.ok(nestedCredentialStatus.blockers.includes('multi_provider_router_provider_contract_drift'));
});

test('router rejects incomplete or insecure Codex model catalogs', async (t) => {
  const harness = await makeMultiProviderRouterHarness();
  t.after(async () => fs.rm(harness.temp, { recursive: true, force: true }));
  const incompletePath = path.join(harness.codexHome, 'incomplete-catalog.json');
  await fs.writeFile(incompletePath, `${JSON.stringify({
    models: [{ slug: 'anthropic/claude-sonnet', display_name: 'Claude Sonnet' }]
  })}\n`, { mode: 0o600 });
  const incomplete = await testMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    catalogPath: incompletePath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude-sonnet',
    fetchImpl: routerModelsFetch()
  });
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.blockers.some((entry) => entry.includes('codex_model_catalog_required_field_missing')));

  const insecurePath = path.join(harness.codexHome, 'insecure-catalog.json');
  await fs.copyFile(harness.catalogPath, insecurePath);
  await fs.chmod(insecurePath, 0o644);
  const insecure = await testMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    catalogPath: insecurePath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude-sonnet',
    fetchImpl: routerModelsFetch()
  });
  assert.equal(insecure.ok, false);
  assert.ok(insecure.blockers.some((entry) => entry.startsWith('codex_model_catalog_mode_insecure:')));
});

test('router bounds streamed model responses before JSON parsing', async (t) => {
  const harness = await makeMultiProviderRouterHarness();
  t.after(async () => fs.rm(harness.temp, { recursive: true, force: true }));
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3 * 1024 * 1024));
      controller.enqueue(new Uint8Array(2 * 1024 * 1024));
      controller.close();
    }
  });
  const result = await testMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    catalogPath: harness.catalogPath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude-sonnet',
    fetchImpl: (async () => new Response(oversized, { status: 200 })) as typeof fetch
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('multi_provider_router_models_response_too_large'));
});

test('router catalog paths resolve relative to the user config directory and expand home aliases', async (t) => {
  const harness = await makeMultiProviderRouterHarness();
  t.after(async () => fs.rm(harness.temp, { recursive: true, force: true }));
  const configDir = path.join(harness.temp, 'alternate-codex-config');
  const configPath = path.join(configDir, 'config.toml');
  const relativeCatalogPath = path.join(configDir, 'custom-catalog.json');
  await fs.mkdir(configDir, { recursive: true });
  await fs.copyFile(harness.catalogPath, relativeCatalogPath);

  await fs.writeFile(configPath, configuredRouterToml('custom-catalog.json'));
  const relativeStatus = await multiProviderRouterStatus({
    home: harness.home,
    env: harness.env,
    configPath
  });
  assert.equal(relativeStatus.catalog_path, relativeCatalogPath);
  assert.equal(relativeStatus.catalog.ok, true, JSON.stringify(relativeStatus));
  assert.equal(relativeStatus.active_model_present, true);

  await fs.writeFile(configPath, configuredRouterToml('~/.codex/opencodex-catalog.json'));
  const homeStatus = await multiProviderRouterStatus({
    home: harness.home,
    env: harness.env,
    configPath
  });
  assert.equal(homeStatus.catalog_path, harness.catalogPath);
  assert.equal(homeStatus.catalog.ok, true, JSON.stringify(homeStatus));
  assert.equal(homeStatus.active_model_present, true);
});

test('router activation recognizes equivalent relative and home-expanded user catalog paths', async (t) => {
  const harness = await makeMultiProviderRouterHarness();
  t.after(async () => fs.rm(harness.temp, { recursive: true, force: true }));
  const customCatalog = path.join(harness.codexHome, 'custom-catalog.json');
  await fs.copyFile(harness.catalogPath, customCatalog);

  for (const configuredPath of [
    'custom-catalog.json',
    '~/.codex/custom-catalog.json'
  ]) {
    await fs.writeFile(
      harness.configPath,
      `model_catalog_json = ${JSON.stringify(configuredPath)}\n`
    );
    const result: any = await useMultiProviderRouter({
      home: harness.home,
      env: harness.env,
      configPath: harness.configPath,
      catalogPath: customCatalog,
      baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
      model: 'anthropic/claude-sonnet',
      restartApp: false,
      fetchImpl: routerModelsFetch(),
      restartImpl: skippedRouterRestart
    });
    assert.equal(result.ok, true, `${configuredPath}: ${JSON.stringify(result)}`);
    assert.equal(result.blockers.includes('multi_provider_router_user_catalog_conflict'), false);
  }
});

test('router activation preserves a user catalog unless replacement is explicit', async (t) => {
  const harness = await makeMultiProviderRouterHarness();
  t.after(async () => fs.rm(harness.temp, { recursive: true, force: true }));
  const userCatalog = path.join(harness.codexHome, 'user-models.json');
  await fs.writeFile(userCatalog, '{"models":[]}\n');
  const originalConfig = [
    `model_provider = ${JSON.stringify(MULTI_PROVIDER_ROUTER_ID)}`,
    `model_catalog_json = ${JSON.stringify(userCatalog)}`,
    ''
  ].join('\n');
  await fs.writeFile(harness.configPath, originalConfig);

  const blocked = await useMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    configPath: harness.configPath,
    catalogPath: harness.catalogPath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude-sonnet',
    restartApp: false,
    fetchImpl: routerModelsFetch()
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.includes('multi_provider_router_user_catalog_conflict'));
  assert.equal(await fs.readFile(harness.configPath, 'utf8'), originalConfig);

  const replaced = await useMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    configPath: harness.configPath,
    catalogPath: harness.catalogPath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude-sonnet',
    replaceCatalog: true,
    restartApp: false,
    fetchImpl: routerModelsFetch(),
    restartImpl: skippedRouterRestart
  });
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  const config = await fs.readFile(harness.configPath, 'utf8');
  assert.match(config, new RegExp(`^model_catalog_json = ${escapeRegExp(JSON.stringify(harness.catalogPath))}$`, 'm'));
  assert.doesNotMatch(config, new RegExp(escapeRegExp(userCatalog)));
});

test('router activation preserves an existing provider table with credential drift', async (t) => {
  const harness = await makeMultiProviderRouterHarness();
  t.after(async () => fs.rm(harness.temp, { recursive: true, force: true }));
  const originalConfig = `${configuredRouterToml(harness.catalogPath)}
[model_providers.${MULTI_PROVIDER_ROUTER_ID}.http_headers]
Authorization = "secret"
`;
  await fs.writeFile(harness.configPath, originalConfig);

  const result = await useMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    configPath: harness.configPath,
    catalogPath: harness.catalogPath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude-sonnet',
    restartApp: false,
    fetchImpl: routerModelsFetch()
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('multi_provider_router_existing_provider_contract_conflict'));
  assert.equal(await fs.readFile(harness.configPath, 'utf8'), originalConfig);
});

test('router activation fails closed on OpenCodex Design B unless force-routing-override', async (t) => {
  const harness = await makeMultiProviderRouterHarness();
  t.after(async () => fs.rm(harness.temp, { recursive: true, force: true }));
  const original = [
    '# Auto-injected by opencodex',
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    'model_provider = "openai"',
    'model = "anthropic/claude-sonnet"',
    `model_catalog_json = ${JSON.stringify(harness.catalogPath)}`,
    ''
  ].join('\n');
  await fs.writeFile(harness.configPath, original);

  const blocked = await useMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    configPath: harness.configPath,
    catalogPath: harness.catalogPath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude-sonnet',
    restartApp: false,
    fetchImpl: routerModelsFetch()
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.includes('opencodex_design_b_routing_owner'));
  assert.equal(await fs.readFile(harness.configPath, 'utf8'), original);

  const forced: any = await useMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    configPath: harness.configPath,
    catalogPath: harness.catalogPath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude-sonnet',
    forceRoutingOverride: true,
    restartApp: false,
    fetchImpl: routerModelsFetch()
  });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(forced.desktop_picker?.models_cache_invalidated, true);
});

test('router activation refuses to remove codex-lb routing while its shared gateway key is active', async (t) => {
  const harness = await makeMultiProviderRouterHarness();
  t.after(async () => fs.rm(harness.temp, { recursive: true, force: true }));
  const gatewayKey = 'sk-clb-router-shared-auth';
  const remote = 'https://lb.example.test/backend-api/codex';
  const managedCatalog = path.join(harness.codexHome, 'sks-codex-lb-tool-catalog.json');
  const envPath = path.join(harness.codexHome, 'sks-codex-lb.env');
  const authPath = path.join(harness.codexHome, 'auth.json');
  const original = [
    'model_provider = "codex-lb"',
    '# sks-codex-lb-managed-openai-base-url',
    `openai_base_url = "${remote}"`,
    `model_catalog_json = ${JSON.stringify(managedCatalog)}`,
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${remote}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n');
  const auth = `{"auth_mode":"apikey","OPENAI_API_KEY":"${gatewayKey}"}\n`;
  await fs.writeFile(harness.configPath, original);
  await fs.writeFile(managedCatalog, '{"models":[]}\n', { mode: 0o600 });
  await fs.writeFile(
    envPath,
    `export CODEX_LB_BASE_URL=${JSON.stringify(remote)}\nexport CODEX_LB_API_KEY=${JSON.stringify(gatewayKey)}\n`,
    { mode: 0o600 }
  );
  await fs.writeFile(authPath, auth, { mode: 0o600 });

  const result = await useMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    configPath: harness.configPath,
    catalogPath: harness.catalogPath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude-sonnet',
    restartApp: false,
    fetchImpl: routerModelsFetch()
  });

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('legacy_codex_lb_desktop_config_requires_migration'));
  assert.equal(await fs.readFile(harness.configPath, 'utf8'), original);
  assert.equal(await fs.readFile(authPath, 'utf8'), auth);
});

test('router activation rereads config after safe codex-lb deselection instead of using a stale CAS snapshot', async (t) => {
  const harness = await makeMultiProviderRouterHarness();
  t.after(async () => fs.rm(harness.temp, { recursive: true, force: true }));
  const remote = 'https://lb.example.test/backend-api/codex';
  const managedCatalog = path.join(harness.codexHome, 'sks-codex-lb-tool-catalog.json');
  await fs.writeFile(harness.configPath, [
    'model_provider = "codex-lb"',
    '# sks-codex-lb-managed-openai-base-url',
    `openai_base_url = "${remote}"`,
    `model_catalog_json = ${JSON.stringify(managedCatalog)}`,
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${remote}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'));
  await fs.writeFile(managedCatalog, '{"models":[]}\n', { mode: 0o600 });
  await fs.writeFile(path.join(harness.codexHome, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    account_id: 'acct-router-oauth',
    tokens: {
      access_token: 'access-router',
      refresh_token: 'refresh-router'
    }
  }), { mode: 0o600 });

  const result: any = await useMultiProviderRouter({
    home: harness.home,
    env: harness.env,
    configPath: harness.configPath,
    catalogPath: harness.catalogPath,
    baseUrl: MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
    model: 'anthropic/claude-sonnet',
    restartApp: false,
    fetchImpl: routerModelsFetch(),
    restartImpl: skippedRouterRestart
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.write?.status, 'concurrent_change_detected');
  const config = await fs.readFile(harness.configPath, 'utf8');
  assert.match(config, /^model_provider = "sks-router"$/m);
  assert.doesNotMatch(config, /^openai_base_url\s*=/m);
  assert.doesNotMatch(config, /sks-codex-lb-managed-openai-base-url/);
});
