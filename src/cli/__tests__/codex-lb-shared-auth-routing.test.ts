import '../../core/__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexLbRestartPostcondition } from '../../commands/codex-lb.js';
import { runProcess } from '../../core/fsx.js';
import {
  codexLbStatus,
  ensureCodexLbAuthDuringInstall,
  formatCodexLbStatusText,
  reconcileCodexLbAuthConflict,
  releaseCodexLbAuthHold,
  unselectCodexLbProvider
} from '../install-helpers.js';
import { checkCodexLbResponseChain } from '../install-helpers-codex-lb-chain.js';
import {
  removeCodexLbSharedOpenAiRouting,
  upsertCodexLbSharedOpenAiRouting
} from '../install-helpers-codex-lb-config.js';

const BASE_URL = 'https://lb.example.test/backend-api/codex';
const API_KEY = 'sk-clb-fixture-not-real';
const OAUTH = `${JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'oauth-fixture-not-real' } }, null, 2)}\n`;

function isolatedRuntime(home: string) {
  return {
    home,
    processEnv: {},
    securityBin: '/usr/bin/false',
    launchctlBin: '/usr/bin/false',
    syncLaunchEnv: false
  };
}

function providerConfig(selected = true, topLevel = '') {
  return [
    topLevel,
    selected ? 'model_provider = "codex-lb"' : '',
    '',
    '[model_providers.codex-lb]',
    'name = "OpenAI"',
    `base_url = "${BASE_URL}"`,
    'wire_api = "responses"',
    'env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }',
    'supports_websockets = true',
    'requires_openai_auth = true',
    ''
  ].filter((line, index) => line || index > 1).join('\n');
}

async function fixture(t: test.TestContext, input: { selected?: boolean; topLevel?: string; authText?: string } = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-routing-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const envPath = path.join(codexHome, 'sks-codex-lb.env');
  const authPath = path.join(codexHome, 'auth.json');
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.writeFile(configPath, providerConfig(input.selected ?? true, input.topLevel || ''));
  await fsp.writeFile(envPath, `export CODEX_LB_BASE_URL='${BASE_URL}'\nexport CODEX_LB_API_KEY='${API_KEY}'\n`, { mode: 0o600 });
  if (input.authText !== undefined) await fsp.writeFile(authPath, input.authText, { mode: 0o600 });
  return {
    home,
    configPath,
    envPath,
    authPath,
    status: { config_path: configPath, env_path: envPath, env_key_configured: true, base_url: BASE_URL }
  };
}

test('prepared unselected codex-lb credentials preserve OAuth and do not pin built-in OpenAI', async (t) => {
  const setup = await fixture(t, { selected: false, authText: OAUTH });
  const result = await reconcileCodexLbAuthConflict({ ...isolatedRuntime(setup.home), status: setup.status });
  assert.equal(result.status, 'oauth_preserved');
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), OAUTH);
  assert.doesNotMatch(await fsp.readFile(setup.configPath, 'utf8'), /openai_base_url|sks-codex-lb-managed-openai-base-url/);
});

test('legacy compatibility helper pins built-in OpenAI before placing a gateway key in shared auth', async (t) => {
  const setup = await fixture(t, { authText: OAUTH });
  const result = await reconcileCodexLbAuthConflict({ ...isolatedRuntime(setup.home), status: setup.status, forceCodexLbApiKeyAuth: true });
  assert.equal(result.status, 'apikey_forced');
  assert.equal(result.routing_guard?.status, 'added');

  const config = await fsp.readFile(setup.configPath, 'utf8');
  const auth = JSON.parse(await fsp.readFile(setup.authPath, 'utf8'));
  assert.match(config, /# sks-codex-lb-managed-openai-base-url\nopenai_base_url = "https:\/\/lb\.example\.test\/backend-api\/codex"/);
  assert.equal(auth.OPENAI_API_KEY, API_KEY);

  const status = await codexLbStatus({
    home: setup.home,
    processEnv: {},
    securityBin: '/usr/bin/false',
    launchctlBin: '/usr/bin/false'
  });
  assert.equal(status.codex_lb_key_in_shared_auth, true);
  assert.deepEqual(status.shared_openai_routing, {
    status: 'matched',
    safe: true,
    managed: true,
    configured_base_url: BASE_URL
  });
  assert.deepEqual(status.secret_resolution, {
    source: 'env-file',
    path: setup.envPath,
    prompt_risk: 'none'
  });
  const statusText = formatCodexLbStatusText(status, { home: setup.home });
  const keySourceLine = statusText.split('\n').find((line) => line.startsWith('Key source:'));
  assert.equal(
    keySourceLine,
    'Key source: env-file (~/.codex/sks-codex-lb.env) · keychain: not used · prompt risk: none'
  );
  t.diagnostic(keySourceLine);
});

test('status text surfaces an explicit one-time migration prompt risk', () => {
  const text = formatCodexLbStatusText({
    secret_resolution: {
      source: 'missing',
      path: null,
      prompt_risk: 'one_time_on_repair'
    }
  });
  assert.match(text, /Key source: missing · keychain: not used · prompt risk: one_time_on_repair/);
});

test('install reconciliation refuses an already active legacy shared-auth routing selection', async (t) => {
  const userSettings = [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "max"',
    'service_tier = "fast"'
  ].join('\n');
  const setup = await fixture(t, { topLevel: userSettings, authText: OAUTH });
  const activated = await reconcileCodexLbAuthConflict({
    ...isolatedRuntime(setup.home),
    status: setup.status,
    forceCodexLbApiKeyAuth: true
  });
  assert.equal(activated.status, 'apikey_forced');

  const beforeConfig = await fsp.readFile(setup.configPath, 'utf8');
  const beforeAuth = await fsp.readFile(setup.authPath, 'utf8');
  const result = await ensureCodexLbAuthDuringInstall({
    home: setup.home,
    processEnv: {},
    securityBin: '/usr/bin/false',
    launchctlBin: '/usr/bin/false',
    syncLaunchEnv: false,
    forceCodexLbApiKeyAuth: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'legacy_migration_required');
  assert.equal(result.auth_reconcile?.status, 'legacy_migration_required');
  assert.equal(result.codex_login?.status, 'not_required');
  assert.equal(result.codex_lb?.selected, true);
  assert.equal(result.codex_lb?.auth_routing_coherent, false);
  assert.equal(result.codex_lb?.shared_openai_routing?.safe, true);
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), beforeConfig);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), beforeAuth);
  assert.match(beforeConfig, /model_provider = "codex-lb"/);
  assert.match(beforeConfig, /model = "gpt-5\.6-sol"/);
  assert.match(beforeConfig, /model_reasoning_effort = "max"/);
});

test('install reconciliation repairs an unselected legacy provider contract without changing OAuth', async (t) => {
  const userSettings = [
    'model = "gpt-5.6-pro"',
    'model_reasoning_effort = "high"',
    'service_tier = "standard"'
  ].join('\n');
  const setup = await fixture(t, { selected: false, topLevel: userSettings, authText: OAUTH });
  const beforeConfig = await fsp.readFile(setup.configPath, 'utf8');
  const beforeAuth = await fsp.readFile(setup.authPath, 'utf8');

  const result = await ensureCodexLbAuthDuringInstall({
    home: setup.home,
    processEnv: {},
    securityBin: '/usr/bin/false',
    launchctlBin: '/usr/bin/false',
    syncLaunchEnv: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'repaired');
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), beforeAuth);
  const afterConfig = await fsp.readFile(setup.configPath, 'utf8');
  assert.notEqual(afterConfig, beforeConfig);
  assert.doesNotMatch(afterConfig, /model_provider = "codex-lb"/);
  assert.match(afterConfig, /model = "gpt-5\.6-pro"/);
  assert.match(afterConfig, /model_reasoning_effort = "high"/);
  assert.match(afterConfig, /name = "codex-lb"/);
  assert.match(afterConfig, /requires_openai_auth = false/);
});

test('activation fails closed on a different user-owned openai_base_url', async (t) => {
  const userOverride = 'openai_base_url = "https://user-proxy.example.test/v1"';
  const setup = await fixture(t, { topLevel: userOverride, authText: OAUTH });
  const beforeConfig = await fsp.readFile(setup.configPath, 'utf8');
  const result = await reconcileCodexLbAuthConflict({ ...isolatedRuntime(setup.home), status: setup.status, forceCodexLbApiKeyAuth: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'shared_openai_base_url_conflict');
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), beforeConfig);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), OAUTH);
});

test('activation rolls back its managed routing pin when auth.json cannot be written', async (t) => {
  const setup = await fixture(t);
  const blockedParent = path.join(setup.home, 'not-a-directory');
  await fsp.writeFile(blockedParent, 'blocker');
  const result = await reconcileCodexLbAuthConflict({
    ...isolatedRuntime(setup.home),
    authPath: path.join(blockedParent, 'auth.json'),
    status: setup.status,
    forceCodexLbApiKeyAuth: true
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'write_failed');
  assert.equal(result.routing_rollback?.status, 'rolled_back');
  assert.doesNotMatch(await fsp.readFile(setup.configPath, 'utf8'), /openai_base_url|sks-codex-lb-managed-openai-base-url/);
});

test('unselect refuses to expose an active shared codex-lb key to built-in OpenAI', async (t) => {
  const setup = await fixture(t, { authText: OAUTH });
  const activated = await reconcileCodexLbAuthConflict({ ...isolatedRuntime(setup.home), status: setup.status, forceCodexLbApiKeyAuth: true });
  assert.equal(activated.status, 'apikey_forced');
  const result = await unselectCodexLbProvider({
    home: setup.home,
    processEnv: {},
    securityBin: '/usr/bin/false'
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'shared_codex_lb_auth_active');
  assert.match(await fsp.readFile(setup.configPath, 'utf8'), /model_provider = "codex-lb"/);
});

test('unselect still refuses API-key fallthrough when the codex-lb env key is missing or rotated', async (t) => {
  const setup = await fixture(t, { authText: OAUTH });
  const activated = await reconcileCodexLbAuthConflict({
    ...isolatedRuntime(setup.home),
    status: setup.status,
    forceCodexLbApiKeyAuth: true
  });
  assert.equal(activated.status, 'apikey_forced');
  const beforeConfig = await fsp.readFile(setup.configPath, 'utf8');
  await fsp.rm(setup.envPath, { force: true });

  const result = await unselectCodexLbProvider({
    home: setup.home,
    envPath: setup.envPath,
    processEnv: {},
    securityBin: '/usr/bin/false'
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'shared_codex_lb_auth_active');
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), beforeConfig);
  assert.equal(JSON.parse(await fsp.readFile(setup.authPath, 'utf8')).OPENAI_API_KEY, API_KEY);
});

test('unselect refuses a fully stripped router orphan while the codex-lb provider contract remains', async (t) => {
  const setup = await fixture(t, { authText: OAUTH });
  const activated = await reconcileCodexLbAuthConflict({
    ...isolatedRuntime(setup.home),
    status: setup.status,
    forceCodexLbApiKeyAuth: true
  });
  assert.equal(activated.status, 'apikey_forced');
  const activeConfig = await fsp.readFile(setup.configPath, 'utf8');
  const orphanedConfig = activeConfig
    .replace(/^model_provider\s*=.*\n/m, '')
    .replace(/^model_catalog_json\s*=.*\n/m, '')
    .replace(/^openai_base_url\s*=.*\n/m, '')
    .replace(/^# sks-codex-lb-managed-openai-base-url\s*\n/m, '');
  await fsp.writeFile(setup.configPath, orphanedConfig);

  const result = await unselectCodexLbProvider({
    home: setup.home,
    processEnv: {},
    securityBin: '/usr/bin/false'
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'shared_codex_lb_auth_active');
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), orphanedConfig);
  assert.equal(JSON.parse(await fsp.readFile(setup.authPath, 'utf8')).OPENAI_API_KEY, API_KEY);
});

test('release rejects keep-provider under shared auth and leaves the coherent LB state intact', async (t) => {
  const setup = await fixture(t, { authText: OAUTH });
  const activated = await reconcileCodexLbAuthConflict({ ...isolatedRuntime(setup.home), status: setup.status, forceCodexLbApiKeyAuth: true });
  assert.equal(activated.status, 'apikey_forced');
  const result = await releaseCodexLbAuthHold({ ...isolatedRuntime(setup.home), keepProvider: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'keep_provider_unsafe_with_shared_auth');
  assert.equal(JSON.parse(await fsp.readFile(setup.authPath, 'utf8')).OPENAI_API_KEY, API_KEY);
  assert.match(await fsp.readFile(setup.configPath, 'utf8'), /model_provider = "codex-lb"/);
});

test('non-forced reconcile restores OAuth only with an unselected, unpinned provider state', async (t) => {
  const setup = await fixture(t, { authText: OAUTH });
  const activated = await reconcileCodexLbAuthConflict({ ...isolatedRuntime(setup.home), status: setup.status, forceCodexLbApiKeyAuth: true });
  assert.equal(activated.status, 'apikey_forced');
  const restored = await reconcileCodexLbAuthConflict({ ...isolatedRuntime(setup.home), status: setup.status });
  assert.equal(restored.status, 'oauth_restored');
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), OAUTH);
  assert.doesNotMatch(await fsp.readFile(setup.configPath, 'utf8'), /model_provider = "codex-lb"|openai_base_url|sks-codex-lb-managed-openai-base-url/);
});

test('release restores OAuth, unselects codex-lb, and removes only its managed routing pin', async (t) => {
  const setup = await fixture(t, { authText: OAUTH });
  const activated = await reconcileCodexLbAuthConflict({ ...isolatedRuntime(setup.home), status: setup.status, forceCodexLbApiKeyAuth: true });
  assert.equal(activated.status, 'apikey_forced');
  const result = await releaseCodexLbAuthHold(isolatedRuntime(setup.home));
  assert.equal(result.status, 'released');
  assert.equal(result.provider_unselected, true);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), OAUTH);
  const config = await fsp.readFile(setup.configPath, 'utf8');
  assert.doesNotMatch(config, /model_provider = "codex-lb"|openai_base_url|sks-codex-lb-managed-openai-base-url/);
  assert.match(config, /\[model_providers\.codex-lb\]/);
});

test('routing cleanup removes only an SKS-provenanced exact pin', () => {
  const userOwned = `openai_base_url = "${BASE_URL}"\n`;
  assert.equal(removeCodexLbSharedOpenAiRouting(userOwned, BASE_URL).changed, false);

  const managed = upsertCodexLbSharedOpenAiRouting('', BASE_URL);
  assert.equal(managed.ok, true);
  assert.equal(removeCodexLbSharedOpenAiRouting(managed.text, BASE_URL).changed, true);
  assert.doesNotMatch(removeCodexLbSharedOpenAiRouting(managed.text, BASE_URL).text, /openai_base_url|sks-codex-lb-managed-openai-base-url/);
});

test('activation claims an exact matching unmanaged openai_base_url so release can clean it up', () => {
  const existing = `openai_base_url = "${BASE_URL}"\n`;
  const claimed = upsertCodexLbSharedOpenAiRouting(existing, BASE_URL);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.status, 'added');
  assert.equal(claimed.managed, true);
  assert.match(claimed.text, /# sks-codex-lb-managed-openai-base-url\nopenai_base_url = "https:\/\/lb\.example\.test\/backend-api\/codex"/);
  assert.equal(removeCodexLbSharedOpenAiRouting(claimed.text, BASE_URL).changed, true);
});

test('codex-lb response-chain blocks insecure non-loopback transport before using the API key', async () => {
  let fetchCalls = 0;
  const result = await checkCodexLbResponseChain({
    base_url: 'http://0.0.0.0:8787/backend-api/codex'
  }, {
    force: true,
    recordCircuit: false,
    apiKey: 'sk-clb-dummy-proof-only',
    model: 'gpt-5.6-luna',
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('fetch must not run for blocked transport');
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'transport_blocked');
  assert.deepEqual(result.blockers, ['codex_lb_insecure_base_url']);
  assert.equal(fetchCalls, 0);
});

test('codex-lb response-chain makes zero requests when provider URL differs from the credential-bound URL', async () => {
  let fetchCalls = 0;
  const result = await checkCodexLbResponseChain({
    base_url: BASE_URL,
    provider_base_url_matches_credential: false
  }, {
    force: true,
    recordCircuit: false,
    apiKey: API_KEY,
    model: 'gpt-5.6-luna',
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('fetch must not run for a provider/credential origin mismatch');
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'provider_base_url_mismatch');
  assert.deepEqual(result.blockers, ['codex_lb_provider_base_url_mismatch']);
  assert.equal(fetchCalls, 0);
});

test('legacy compatibility never invokes a generic Keychain reader or mutates shared auth', async (t) => {
  const setup = await fixture(t, { authText: OAUTH });
  await fsp.rm(setup.envPath, { force: true });
  const securityStub = path.join(setup.home, 'security-stub');
  const invokedMarker = path.join(setup.home, 'security-stub-invoked');
  await fsp.writeFile(
    securityStub,
    `#!/bin/sh\nprintf invoked > ${JSON.stringify(invokedMarker)}\nexit 99\n`,
    { mode: 0o700 }
  );
  await fsp.chmod(securityStub, 0o700);
  await fsp.writeFile(path.join(setup.home, '.codex', 'sks-codex-lb.json'), `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: BASE_URL,
    api_key: { redacted: true, sha256: createHash('sha256').update(API_KEY).digest('hex') }
  })}\n`, { mode: 0o600 });

  const status = await codexLbStatus({
    home: setup.home,
    processEnv: {},
    forceMacos: true,
    securityBin: securityStub,
    syncLaunchEnv: false
  });
  assert.equal(status.env_file, false);
  assert.equal(status.env_loader.api_key.source, null);
  assert.equal(status.env_loader.keychain.checked, false);
  assert.equal(status.env_loader.keychain.status, 'not_used');
  assert.ok((status.env_loader.blockers || []).includes('codex_lb_api_key_missing'));
  assert.ok(status.env_loader.credential_binding.blockers.includes('codex_lb_api_key_missing'));
  assert.match(status.env_loader.guidance?.[0] || '', /sks codex-lb setup/);
  assert.match(status.env_loader.guidance?.[0] || '', /export CODEX_LB_API_KEY/);

  const result = await reconcileCodexLbAuthConflict({
    home: setup.home,
    status,
    processEnv: {},
    forceMacos: true,
    securityBin: securityStub,
    forceCodexLbApiKeyAuth: true
  });
  assert.deepEqual(result, {
    status: 'skipped',
    reason: 'codex_lb_not_ready',
    auth_path: setup.authPath
  });
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), OAUTH);
  await assert.rejects(fsp.access(invokedMarker), { code: 'ENOENT' });
});

test('explicit Codex App restart cannot be satisfied by a skipped restart', () => {
  assert.deepEqual(codexLbRestartPostcondition({ ok: true, status: 'skipped', reason: 'disabled' }, true), {
    required: true,
    performed: false,
    satisfied: false
  });
  assert.deepEqual(codexLbRestartPostcondition({ ok: true, status: 'restarted' }, true), {
    required: true,
    performed: true,
    satisfied: true
  });
});

test('codex-lb health tests stored credentials without globally selecting the CLI provider', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-health-readiness-'));
  const requests: Array<{
    url: string | undefined;
    authorization: string | undefined;
    gateway_api_key: string | undefined;
    previous_response_id: string | null;
  }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      gateway_api_key: request.headers['x-codex-lb-api-key'] as string | undefined,
      previous_response_id: typeof body.previous_response_id === 'string' ? body.previous_response_id : null
    });
    if (request.url === '/backend-api/codex/responses') {
      const id = body.previous_response_id ? 'resp_health_2' : 'resp_health_1';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id, object: 'response', output: [] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(home, { recursive: true, force: true });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/backend-api/codex`;
  const codexDir = path.join(home, '.codex');
  await fsp.mkdir(codexDir, { recursive: true });
  await fsp.writeFile(path.join(codexDir, 'config.toml'), [
    'model = "gpt-5.6-luna"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${baseUrl}"`,
    'env_key = "CODEX_LB_API_KEY"',
    'wire_api = "responses"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'));
  const envPath = path.join(codexDir, 'sks-codex-lb.env');
  await fsp.writeFile(envPath, [
    `export CODEX_LB_BASE_URL='${baseUrl}'`,
    "export CODEX_LB_API_KEY='sk-clb-health-fixture'",
    ''
  ].join('\n'), { mode: 0o600 });
  await fsp.chmod(envPath, 0o600);

  const result = await runProcess(process.execPath, [path.resolve('dist/bin/sks.js'), 'codex-lb', 'health', '--json'], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexDir,
      CODEX_LB_API_KEY: '',
      CODEX_LB_BASE_URL: '',
      SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global'),
      SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1',
      SKS_CODEX_LB_CHAIN_CHECK: '1'
    },
    timeoutMs: 20_000,
    maxOutputBytes: 256 * 1024
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const json = JSON.parse(result.stdout) as Record<string, any>;
  assert.equal(json.ok, true);
  assert.equal(json.status, 'chain_ok');
  assert.equal(json.codex_lb.provider_ready, true);
  assert.equal(json.codex_lb.selected, false);
  assert.equal(json.model_selection.source, 'global_config');
  assert.deepEqual(requests.map((request) => request.previous_response_id), [null, 'resp_health_1']);
  assert.ok(requests.every((request) => request.authorization === 'Bearer sk-clb-health-fixture'));
  assert.ok(requests.every((request) => request.gateway_api_key === undefined));
});
