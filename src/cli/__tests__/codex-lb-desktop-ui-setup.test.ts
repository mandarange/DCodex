import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureCodexLb } from '../install-helpers.js';
import { hasTopLevelCodexLbSelected } from '../install-helpers-codex-lb-shared.js';
import { CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION } from '../../core/codex-lb/codex-lb-tool-output-recovery.js';
import { codexLbToolCatalogPath } from '../../core/codex-lb/codex-lb-tool-catalog.js';

const BASE_URL = 'https://lb.desktop-ui.fixture/backend-api/codex';

function gpt56Model(slug: string) {
  return {
    slug,
    display_name: slug,
    supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced' }],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    base_instructions: 'You are Codex.',
    supports_reasoning_summaries: true,
    support_verbosity: true,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    tool_mode: 'code_mode_only',
    use_responses_lite: true,
    minimal_client_version: '0.144.5'
  };
}

const READY_CATALOG = {
  models: [
    gpt56Model('gpt-5.6-sol'),
    gpt56Model('gpt-5.6-terra'),
    gpt56Model('gpt-5.6-luna')
  ]
};

async function homeFixture(t: test.TestContext) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-desktop-ui-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  await fsp.mkdir(codexHome, { recursive: true });
  const initialConfig = [
    'model = "user-owned-model"',
    'model_reasoning_effort = "low"',
    'service_tier = "standard"',
    '',
    '[features]',
    'fast_mode = false',
    ''
  ].join('\n');
  await fsp.writeFile(path.join(codexHome, 'config.toml'), initialConfig, { mode: 0o600 });
  await fsp.writeFile(
    path.join(codexHome, 'auth.json'),
    `${JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'oauth-fixture' } }, null, 2)}\n`,
    { mode: 0o600 }
  );
  return {
    home,
    codexHome,
    configPath: path.join(codexHome, 'config.toml'),
    authPath: path.join(codexHome, 'auth.json')
  };
}

async function toolOutputRecoveryFetch() {
  return new Response('{}', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-app-version': CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION
    }
  });
}

test('configureCodexLb stores an unselected CLI provider without mutating Desktop auth, catalog, or Fast settings', async (t) => {
  const { home, codexHome, configPath, authPath } = await homeFixture(t);
  const catalogPath = codexLbToolCatalogPath(codexHome);
  const envPath = path.join(codexHome, 'sks-codex-lb.env');
  await fsp.writeFile(envPath, "export CODEX_LB_BASE_URL='https://old.example.test/backend-api/codex'\nexport CODEX_LB_API_KEY='still-valid-old-key'\n", { mode: 0o600 });
  const beforeAuth = await fsp.readFile(authPath);
  let catalogFetchCalls = 0;
  const previousSkip = process.env.SKS_SKIP_CODEX_LB_LAUNCH_ENV;
  process.env.SKS_SKIP_CODEX_LB_LAUNCH_ENV = '1';
  t.after(() => {
    if (previousSkip === undefined) delete process.env.SKS_SKIP_CODEX_LB_LAUNCH_ENV;
    else process.env.SKS_SKIP_CODEX_LB_LAUNCH_ENV = previousSkip;
  });
  const result = await configureCodexLb({
    home,
    host: BASE_URL,
    apiKey: 'sk-clb-desktop-ui-ready',
    forceCodexLbApiKeyAuth: true,
    authMode: 'codex-lb',
    shellProfile: 'skip',
    syncLaunchctl: false,
    toolOutputRecoveryFetch,
    toolCatalogFetch: async () => {
      catalogFetchCalls += 1;
      return new Response(JSON.stringify(READY_CATALOG), { status: 200 });
    }
  });

  const config = await fsp.readFile(configPath, 'utf8');
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'cli-provider');
  assert.equal(result.routing_plane, 'cli_provider');
  assert.equal(result.identity_plane, 'unchanged');
  assert.equal(result.oauth_preserved, true);
  assert.equal(result.auth_mutated, false);
  assert.equal(result.auth_reconcile?.status, 'oauth_untouched');
  assert.equal(result.codex_login?.status, 'not_required');
  assert.equal(result.tool_catalog?.status, 'not_bound_for_cli_provider');
  assert.equal(result.tool_catalog?.required, false);
  assert.equal(result.codex_lb?.selected, false);
  assert.equal(hasTopLevelCodexLbSelected(config), false);
  assert.doesNotMatch(config, /^\s*model_catalog_json\s*=/m);
  assert.match(config, /\[model_providers\.codex-lb\]/);
  assert.match(config, /^name\s*=\s*"codex-lb"$/m);
  assert.match(config, /^requires_openai_auth\s*=\s*false$/m);
  assert.match(config, /^model\s*=\s*"user-owned-model"$/m);
  assert.match(config, /^model_reasoning_effort\s*=\s*"low"$/m);
  assert.match(config, /^service_tier\s*=\s*"standard"$/m);
  assert.match(config, /^fast_mode\s*=\s*false$/m);
  assert.equal(catalogFetchCalls, 0);
  assert.equal(await fsp.access(catalogPath).then(() => true, () => false), false);
  assert.deepEqual(await fsp.readFile(authPath), beforeAuth);
  assert.deepEqual(result.secret_recovery_paths, []);
  assert.ok(!result.recovery_paths?.some((entry) => entry.startsWith(`${envPath}.sks-setup-claimed-`)));
  assert.ok(!(await fsp.readdir(codexHome)).some((entry) => entry.includes('sks-codex-lb.env.sks-setup-claimed-')));
  assert.doesNotMatch(await fsp.readFile(envPath, 'utf8'), /still-valid-old-key/);
});

test('configureCodexLb ignores catalog quality and legacy activation flags during credential-only setup', async (t) => {
  const { home, codexHome, configPath, authPath } = await homeFixture(t);
  const catalogPath = codexLbToolCatalogPath(codexHome);
  const previousSkip = process.env.SKS_SKIP_CODEX_LB_LAUNCH_ENV;
  process.env.SKS_SKIP_CODEX_LB_LAUNCH_ENV = '1';
  t.after(() => {
    if (previousSkip === undefined) delete process.env.SKS_SKIP_CODEX_LB_LAUNCH_ENV;
    else process.env.SKS_SKIP_CODEX_LB_LAUNCH_ENV = previousSkip;
  });
  const beforeAuth = await fsp.readFile(authPath, 'utf8');
  let catalogFetchCalls = 0;
  const result = await configureCodexLb({
    home,
    host: BASE_URL,
    apiKey: 'sk-clb-desktop-ui-bad',
    forceCodexLbApiKeyAuth: true,
    authMode: 'codex-lb',
    shellProfile: 'skip',
    syncLaunchctl: false,
    toolOutputRecoveryFetch,
    toolCatalogFetch: async () => {
      catalogFetchCalls += 1;
      return new Response(JSON.stringify({ models: [{ id: 'gpt-4o' }] }), { status: 200 });
    }
  });

  const config = await fsp.readFile(configPath, 'utf8');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'configured');
  assert.equal(result.mode, 'cli-provider');
  assert.equal(hasTopLevelCodexLbSelected(config), false);
  assert.match(config, /\[model_providers\.codex-lb\]/);
  assert.doesNotMatch(config, /^\s*model_provider\s*=\s*"codex-lb"/m);
  assert.doesNotMatch(config, /^\s*model_catalog_json\s*=/m);
  assert.match(config, /^service_tier\s*=\s*"standard"$/m);
  assert.match(config, /^fast_mode\s*=\s*false$/m);
  assert.equal(result.codex_login?.status, 'not_required');
  assert.equal(result.auth_reconcile?.status, 'oauth_untouched');
  assert.equal(result.tool_catalog?.status, 'not_bound_for_cli_provider');
  assert.equal(catalogFetchCalls, 0);
  assert.equal(await fsp.access(catalogPath).then(() => true, () => false), false);
  assert.equal(await fsp.readFile(authPath, 'utf8'), beforeAuth);
  assert.match(beforeAuth, /chatgpt/);
});
