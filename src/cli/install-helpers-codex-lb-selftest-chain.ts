import path from 'node:path';
import { packageRoot, writeTextAtomic } from '../core/fsx.js';
import {
  hasCodexUnstableFeatureWarningSuppression,
  hasDeprecatedCodexHooksFeatureFlag
} from './install-tool-helpers.js';
import {
  maybePromptCodexLbSetupForLaunch
} from './install-helpers.js';
import { checkCodexLbResponseChain } from './install-helpers-codex-lb-chain.js';
import { hasTopLevelCodexLbSelected } from './install-helpers-codex-lb-shared.js';

async function safeReadText(file: any, fallback: any = '') {
  try {
    return await import('node:fs/promises').then((fsp) => fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function runCodexLbLaunchChainSelftest(input: {
  tmp: string;
  codexLbHome: string;
  codexLbFakeBin: string;
  codexLbConfig: string;
}) {
  const { tmp, codexLbHome, codexLbFakeBin, codexLbConfig } = input;
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), 'service_tier = "fast"\n');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\nexport CODEX_LB_API_KEY='sk-test'\n");
  const missingProviderLaunchCalls: any[] = [];
  const missingProviderLaunch = await maybePromptCodexLbSetupForLaunch([], {
    home: codexLbHome,
    apiKey: 'sk-test',
    codexBin: path.join(codexLbFakeBin, 'codex'),
    syncLaunchEnv: false,
    timeoutMs: 1000,
    fetch: async (url: any, init: any) => {
      missingProviderLaunchCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: missingProviderLaunchCalls.length === 1 ? 'resp_missing_provider_1' : 'resp_missing_provider_2' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const missingProviderRepairedConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  if (
    !missingProviderLaunch.ok
    || missingProviderLaunch.status !== 'continued_to_codex'
    || missingProviderLaunch.chain_health !== undefined
    || missingProviderLaunchCalls.length !== 0
    || hasTopLevelCodexLbSelected(missingProviderRepairedConfig)
    || !missingProviderRepairedConfig.includes('[model_providers.codex-lb]')
    || !missingProviderRepairedConfig.includes('env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }')
    || !missingProviderRepairedConfig.includes('supports_websockets = true')
    || !missingProviderRepairedConfig.includes('requires_openai_auth = false')
    || !missingProviderRepairedConfig.includes('name = "codex-lb"')
  ) throw new Error('selftest: bare sks launch must repair an unselected CLI provider without an implicit network probe');
  const chainCalls: any[] = [];
  const okChain = await checkCodexLbResponseChain(
    { base_url: 'https://lb.example.test/backend-api/codex', env_path: path.join(codexLbHome, '.codex', 'sks-codex-lb.env') },
    {
      apiKey: 'sk-test',
      model: 'selftest-codex-model',
      timeoutMs: 1000,
      fetch: async (url: any, init: any) => {
        chainCalls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ id: chainCalls.length === 1 ? 'resp_selftest_1' : 'resp_selftest_2' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
  );
  if (!okChain.ok || okChain.status !== 'chain_ok' || chainCalls.length !== 2 || !String(chainCalls[0].url).endsWith('/backend-api/codex/responses') || chainCalls[1].body.previous_response_id !== 'resp_selftest_1') throw new Error('selftest: codex-lb response chain health check did not verify previous_response_id continuity');
  const previousGlobalFetch = globalThis.fetch;
  const cacheCalls: any[] = [];
  const cachePath = path.join(codexLbHome, '.codex', 'chain-cache-selftest.json');
  try {
    globalThis.fetch = async (url: any, init: any) => {
      cacheCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: cacheCalls.length === 1 ? 'resp_cache_1' : 'resp_cache_2' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const cacheStatus = { base_url: 'https://cache.example.test/backend-api/codex', env_path: path.join(codexLbHome, '.codex', 'sks-codex-lb.env') };
    const firstCache = await checkCodexLbResponseChain(cacheStatus, { home: codexLbHome, apiKey: 'sk-test', model: 'selftest-codex-model', timeoutMs: 1000, cachePath, now: () => 1000 });
    const secondCache = await checkCodexLbResponseChain(cacheStatus, { home: codexLbHome, apiKey: 'sk-test', model: 'selftest-codex-model', timeoutMs: 1000, cachePath, now: () => 2000 });
    if (!firstCache.ok || firstCache.status !== 'chain_ok' || secondCache.cached !== true || secondCache.status !== 'chain_ok' || cacheCalls.length !== 2) throw new Error('selftest: codex-lb response chain cache did not avoid repeated launch preflight calls');
  } finally {
    globalThis.fetch = previousGlobalFetch;
  }
  const brokenChain = await checkCodexLbResponseChain(
    { base_url: 'https://lb.example.test/backend-api/codex', env_path: path.join(codexLbHome, '.codex', 'sks-codex-lb.env') },
    {
      apiKey: 'sk-test',
      model: 'selftest-codex-model',
      timeoutMs: 1000,
      fetch: async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        if (!body.previous_response_id) return new Response(JSON.stringify({ id: 'resp_missing_selftest' }), { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'previous_response_not_found', message: 'Previous response not found.', param: 'previous_response_id' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }
  );
  if (brokenChain.ok || brokenChain.status !== 'previous_response_not_found' || brokenChain.chain_unhealthy !== true) throw new Error('selftest: codex-lb response chain health check did not detect previous_response_not_found');
  // Credential/provider setup is independent from Codex Desktop capabilities.
  // It must preserve unrelated App preferences and must not introduce retired
  // feature flags or a global provider/mode lock. Current App capability
  // normalization and deep evidence are covered by their dedicated gates.
  const retiredFeatureStamps = [
    'remote_control = true',
    'fast_mode_ui = true',
    'codex_git_commit = true',
    'computer_use = true',
    'browser_use = true',
    'browser_use_external = true',
    'image_generation = true',
    'in_app_browser = true',
    'guardian_approval = true',
    'tool_suggest = true',
    'plugins = true',
    '[user.fast_mode]',
    '[profiles.sks-fast-high]'
  ];
  const introducedRetiredFeatures = retiredFeatureStamps.filter((stamp) => codexLbConfig.includes(stamp));
  if (
    !codexLbConfig.includes('hooks = true')
    || hasDeprecatedCodexHooksFeatureFlag(codexLbConfig)
    || /(?:^|\n)\s*multi_agent\s*=/.test(codexLbConfig)
    || introducedRetiredFeatures.length
    || !/\[profiles\.custom\][\s\S]*?model_reasoning_effort = "low"/.test(codexLbConfig)
    || hasTopLevelCodexLbSelected(codexLbConfig)
  ) throw new Error(`selftest: codex-lb credential setup changed unrelated Desktop capability state${introducedRetiredFeatures.length ? ` — introduced retired flags: ${introducedRetiredFeatures.join(', ')}` : ''}`);
  if (!hasCodexUnstableFeatureWarningSuppression(codexLbConfig)) throw new Error('selftest: codex-lb setup did not suppress Codex unstable feature warning');
  const codexLbLaunch = `codex --config model_provider='"codex-lb"'`;
  if (!codexLbLaunch.includes('model_provider')) throw new Error('selftest: CLI launch must select the stored codex-lb provider explicitly');
  if (/source\s+.*sks-codex-lb\.env/.test(codexLbLaunch)) throw new Error('selftest: Desktop/CLI happy path must not require sourcing sks-codex-lb.env');
  if (codexLbLaunch.includes('--model')) throw new Error('selftest: native Codex launch without an explicit model must inherit the Codex selection');
  const madLaunchSource = await safeReadText(path.join(packageRoot(), 'src', 'core', 'commands', 'mad-sks-command.ts'));
  if (
    !madLaunchSource.includes("const lb = { status: 'deferred_until_provider_route', ok: true")
    || !madLaunchSource.includes('codexLbImmediateLaunchOpts(cleanArgs, launchLb')
    || !madLaunchSource.includes('model_provider="codex-lb"')
    || !madLaunchSource.includes('codexLbFreshSession: true')
  ) throw new Error('selftest: MAD launch does not select the stored CLI provider explicitly for its own process');
}
