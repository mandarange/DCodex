#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexProviderModelUiStatus, formatCodexAppStatus } from '../core/codex-app.js';
import { GLM_CODEX_CONFIG_PROVIDER_ID } from '../core/codex-app/glm-model-profile.js';
import { GLM_52_OPENROUTER_MODEL } from '../core/codex-app/openrouter-provider.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-app-provider-ui-'));
const home = path.join(tmp, 'home');
const cwd = path.join(tmp, 'project');
await fs.mkdir(path.join(home, '.codex'), { recursive: true });
await fs.mkdir(path.join(cwd, '.codex'), { recursive: true });

const missing = await codexProviderModelUiStatus({ home, cwd, env: { HOME: home } as any });
const missingText = formatCodexAppStatus(statusFixture(missing));

await fs.writeFile(path.join(home, '.codex', 'config.toml'), readyConfig(), 'utf8');
await fs.writeFile(
  path.join(home, '.codex', 'sks-codex-lb.env'),
  "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\nexport CODEX_LB_API_KEY='sk-codex-lb-fixture'\n",
  'utf8'
);
const readyCatalog = {
  schema: 'sks.codex-lb-model-catalog.v1',
  ok: true,
  status: 'ready',
  models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  model_efforts: {
    'gpt-5.6-sol': ['xhigh', 'max', 'ultra'],
    'gpt-5.6-terra': ['xhigh', 'max', 'ultra'],
    'gpt-5.6-luna': ['xhigh', 'max']
  },
  blockers: []
};
const ready = await codexProviderModelUiStatus({
  home,
  cwd,
  env: { HOME: home, OPENROUTER_API_KEY: 'sk-or-fixture' } as any,
  codexLbModelCatalog: readyCatalog
});
const readyText = formatCodexAppStatus(statusFixture(ready));

await fs.writeFile(path.join(home, '.codex', 'config.toml'), codexLbOnlyConfig(), 'utf8');
const selectedCodexLb = await codexProviderModelUiStatus({
  home,
  cwd,
  env: { HOME: home } as any,
  codexLbModelCatalog: readyCatalog
});
const sourceRoot = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources');
const providerViewSource = await fs.readFile(path.join(sourceRoot, 'ProvidersViewController.swift'), 'utf8');
const openRouterSource = await fs.readFile(path.join(sourceRoot, 'ProvidersOpenRouter.swift'), 'utf8');
const roleModelsSource = await fs.readFile(path.join(sourceRoot, 'ProvidersRoleModels.swift'), 'utf8');
const multiProviderSource = await fs.readFile(path.join(sourceRoot, 'ProvidersMultiProvider.swift'), 'utf8');
const openRouterStatusRefresh = openRouterSource.slice(
  openRouterSource.indexOf('func refreshOpenRouterStatus()'),
  openRouterSource.indexOf('func describeOpenRouterStatus')
);
const nativeSourceContract = !/field\.stringValue = "z-ai\/glm-5\.2"/.test(providerViewSource)
  && /var openRouterModelSelectionPending = false/.test(providerViewSource)
  && /!self\.openRouterModelSelectionPending,\s*current\.isEmpty/.test(openRouterStatusRefresh)
  && !/current == "z-ai\/glm-5\.2"/.test(openRouterStatusRefresh)
  && /openRouterModelSelectionPending = true[\s\S]{0,160}openRouterModelField\.stringValue = model/.test(openRouterSource)
  && /if !controls\.model\.itemTitles\.contains\(model\) \{[\s\S]{0,120}controls\.model\.addItem\(withTitle: model\)/.test(roleModelsSource)
  && /!efforts\.contains\(preferred\)[\s\S]{0,100}efforts\.append\(preferred\)/.test(roleModelsSource)
  && /effectiveSource == "selected-main-model" \? effectiveModel : \(defaultModel \?\? effectiveModel\)/.test(roleModelsSource)
  && /effectiveSource == "selected-main-model" \? effectiveReasoning : \(defaultReasoning \?\? effectiveReasoning\)/.test(roleModelsSource)
  && /effectiveSource == "selected-main-model" \? " · inherits active main model"/.test(roleModelsSource)
  && /var modelSelectionPending = false/.test(multiProviderSource)
  && /!self\.multiProvider\.modelSelectionPending,[\s\S]{0,420}self\.synchronizeMultiProviderPopupSelection\(\)/.test(multiProviderSource)
  && !/models\.firstIndex\(of: activeModel\)/.test(multiProviderSource);

const ok = missing.ok === false
  && missing.status === 'available_unverified'
  && missing.readiness_state === 'available_unverified'
  && missing.selected_provider === 'oauth'
  && missing.blockers.length === 0
  && missing.optional_provider_status === 'setup_available'
  && missing.optional_provider_blockers.includes('glm_openrouter_provider_missing')
  && missing.optional_provider_blockers.includes('codex_lb_provider_missing')
  && missing.glm.exposed === false
  && missing.codex_lb.key_entry_visible === true
  && missing.ui_actions.includes('sks codex-app set-openrouter-key --api-key-stdin')
  && missing.ui_actions.includes('sks codex-lb setup --host <domain> --api-key-stdin --yes')
  && /Provider UI:\s*oauth configured, Desktop picker unverified/.test(missingText)
  && /GLM Model:\s*setup/.test(missingText)
  && /codex-lb Key:\s*missing \(input: sks codex-lb setup/.test(missingText)
  && ready.ok === false
  && ready.status === 'available_unverified'
  && ready.readiness_state === 'available_unverified'
  && ready.glm.exposed === true
  && ready.glm.model === GLM_52_OPENROUTER_MODEL
  && ready.glm.profiles_present.length === 0
  && ready.glm.blockers.every((blocker: string) => !blocker.startsWith('retired_glm_desktop_profile_present:'))
  && ready.codex_lb.provider_present === true
  && ready.codex_lb.key_present === true
  && ready.codex_lb.model_catalog_ok === true
  && ready.codex_lb.expected_models_present === true
  && /Provider UI:\s*oauth configured, Desktop picker unverified/.test(readyText)
  && ready.desktop_picker_verified === false
  && readyText.includes(`GLM Model:  ok ${GLM_52_OPENROUTER_MODEL}`)
  && /codex-lb Key:\s*configured/.test(readyText)
  && selectedCodexLb.ok === false
  && selectedCodexLb.status === 'available_unverified'
  && selectedCodexLb.readiness_state === 'available_unverified'
  && selectedCodexLb.selected_provider === 'codex-lb'
  && selectedCodexLb.selected_provider_blockers.length === 0
  && selectedCodexLb.blockers.length === 0
  && selectedCodexLb.optional_provider_blockers.includes('glm_openrouter_provider_missing')
  && nativeSourceContract
  && !JSON.stringify({ missing, ready, selectedCodexLb, missingText, readyText }).includes('sk-codex-lb-fixture');

emit({
  schema: 'sks.codex-app-provider-model-ui-check.v1',
  ok,
  missing,
  ready,
  selected_codex_lb: selectedCodexLb,
  native_source_contract: nativeSourceContract,
  secret_safe: !JSON.stringify({ missing, ready, selectedCodexLb, missingText, readyText }).includes('sk-codex-lb-fixture'),
  blockers: ok ? [] : ['codex_app_provider_model_ui_check_failed']
});

function readyConfig() {
  return [
    `[model_providers.${GLM_CODEX_CONFIG_PROVIDER_ID}]`,
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'wire_api = "responses"',
    'env_key = "OPENROUTER_API_KEY"',
    'requires_openai_auth = false',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    'base_url = "https://lb.example.test/backend-api/codex"',
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n');
}

function codexLbOnlyConfig() {
  return [
    'model_provider = "codex-lb"',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    'base_url = "https://lb.example.test/backend-api/codex"',
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n');
}

function statusFixture(providerModelUi: any) {
  return {
    ok: providerModelUi.ok,
    app: { installed: true, path: '/Applications/Codex.app' },
    codex_cli: { ok: true, version: '0.144.5' },
    remote_control: { ok: true, min_version: '0.130.0', codex_cli: { version_number: '0.144.5' } },
    features: {
      checked: true,
      required_flags_ok: true,
      required_flags: {},
      fast_mode_config: { ok: true, blockers: [] },
      provider_model_ui: providerModelUi,
      git_actions: { ok: true, blockers: [] },
      browser_tool_ready: true,
      browser_tool_source: 'fixture',
      image_generation: true
    },
    plugins: {
      default_plugins: { ok: true },
      design_product: { ok: true, id: 'product-design' },
      picker: { ok: true }
    },
    chrome_extension: { ok: true, blockers: [] },
    mcp: {
      has_computer_use: true,
      computer_use_source: 'mcp_list',
      has_browser_use: true,
      browser_use_source: 'mcp_list'
    },
    guidance: []
  };
}

function emit(report: Record<string, unknown>) {
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
