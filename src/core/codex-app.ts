import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { exists, runProcess } from './fsx.js';
import { EMPTY_CODEX_INFO, getCodexInfo } from './codex-adapter.js';
import { CODEX_CHROME_EXTENSION_DOC_URL, DEFAULT_CODEX_APP_PLUGINS as DEFAULT_CODEX_APP_PLUGIN_TUPLES, RESERVED_CODEX_PLUGIN_SKILL_NAMES } from './routes.js';
import { PRODUCT_DESIGN_PLUGIN, normalizeProductDesignPluginEvidence } from './product-design-plugin.js';
import { PRODUCT_DESIGN_AUTO_INSTALL_ENV, ensureProductDesignPluginInstalled, productDesignAutoInstallRequested } from './product-design-app-server.js';
import { GLM_CODEX_CONFIG_PROVIDER_ID, GLM_52_OPENROUTER_MODEL, RETIRED_GLM_DESKTOP_CONFIG_PROFILE_IDS } from './codex-app/openrouter-provider.js';
import { sksOpenRouterCatalogPath } from './codex-app/codex-model-catalog.js';
import { resolveOpenRouterApiKey } from './providers/openrouter/openrouter-secret-store.js';
import {
  codexLbEnvPath,
  codexLbMetadataPath,
  loadCodexLbEnv,
  parseShellEnvValue,
  readCodexLbModelCatalog
} from './codex-lb/codex-lb-env.js';
import {
  codexLbToolCatalogPath,
  inspectCodexLbToolCatalog,
  shouldBindLocalModelCatalog
} from './codex-lb/codex-lb-tool-catalog.js';
import type {
  CodexLbDesktopMode,
  CodexLbGatewayAuthTransport
} from './codex-lb/desktop-mode.js';
import { isSksOwnedGlobalUiLock } from './codex-app/codex-app-ui-state-snapshot.js';
import { redactString } from './secret-redaction.js';
import { escapeRegExp } from './text/regex.js';

export const CODEX_APP_DOCS_URL = 'https://developers.openai.com/codex/app/features';
export const CODEX_CHANGELOG_URL = 'https://developers.openai.com/codex/changelog';
export const CODEX_ACCESS_TOKENS_DOCS_URL = 'https://developers.openai.com/codex/enterprise/access-tokens';
export const CODEX_CHROME_EXTENSION_SETUP_DOCS_URL = CODEX_CHROME_EXTENSION_DOC_URL;
export const CODEX_REMOTE_CONTROL_MIN_VERSION = '0.130.0';
const REQUIRED_CODEX_APP_FEATURE_FLAGS = [
  'codex_git_commit',
  'hooks',
  'fast_mode',
  'computer_use',
  'browser_use',
  'browser_use_external',
  'image_generation',
  'in_app_browser',
  'guardian_approval',
  'tool_suggest',
  'apps',
  'plugins'
];
const DEFAULT_CODEX_APP_PLUGINS = DEFAULT_CODEX_APP_PLUGIN_TUPLES.map(([name, marketplace]: any) => ({ name, marketplace }));

export function codexAppCandidatePaths(home: any = os.homedir(), env: any = process.env) {
  const candidates: any[] = [];
  if (env.SKS_CODEX_APP_PATH) candidates.push(env.SKS_CODEX_APP_PATH);
  if (process.platform === 'darwin') {
    candidates.push('/Applications/ChatGPT.app');
    candidates.push(path.join(home || '', 'Applications', 'ChatGPT.app'));
    candidates.push('/Applications/Codex.app');
    candidates.push(path.join(home || '', 'Applications', 'Codex.app'));
  }
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home || '', 'AppData', 'Local');
    candidates.push(path.join(local, 'Programs', 'Codex', 'Codex.exe'));
    candidates.push(path.join(local, 'Codex', 'Codex.exe'));
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

export async function findCodexApp(opts: any = {}) {
  for (const candidate of codexAppCandidatePaths(opts.home || os.homedir(), opts.env || process.env)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function findPluginCache(pluginName: any, opts: any = {}) {
  const home = opts.home || os.homedir();
  const roots = [
    path.join(home || '', '.codex', 'plugins', 'cache'),
    path.join(home || '', '.agents', 'plugins', 'cache')
  ];
  const needle = String(pluginName || '').toLowerCase();
  const maxEntries = Number(opts.maxEntries || 3000);
  let seen = 0;

  async function walk(dir: any, depth: any = 0): Promise<string | null> {
    if (!dir || seen > maxEntries || depth > 6 || !(await exists(dir))) return null;
    let entries: any[] = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (seen++ > maxEntries) return null;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === needle) return full;
        const hit: string | null = await walk(full, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  for (const root of roots) {
    const hit = await walk(root);
    if (hit) return hit;
  }
  return null;
}

export async function codexMcpList(opts: any = {}) {
  const codex = opts.codex || await getCodexInfo().catch(() => EMPTY_CODEX_INFO);
  if (!codex.bin) return { ok: false, checked: false, stdout: '', stderr: 'Codex CLI missing.' };
  const execute = opts.runProcess || runProcess;
  const out = await execute(codex.bin, ['mcp', 'list'], {
    timeoutMs: opts.timeoutMs || 10000,
    maxOutputBytes: 64 * 1024
  }).catch((err: any) => ({ code: 1, stdout: '', stderr: err.message }));
  return {
    ok: out.code === 0,
    checked: true,
    stdout: redactString(out.stdout || ''),
    stderr: redactString(out.stderr || '')
  };
}

export async function codexFeatureList(opts: any = {}) {
  const codex = opts.codex || await getCodexInfo().catch(() => EMPTY_CODEX_INFO);
  if (!codex.bin) return { ok: false, checked: false, stdout: '', stderr: 'Codex CLI missing.' };
  const execute = opts.runProcess || runProcess;
  const out = await execute(codex.bin, ['features', 'list'], {
    timeoutMs: opts.timeoutMs || 10000,
    maxOutputBytes: 64 * 1024
  }).catch((err: any) => ({ code: 1, stdout: '', stderr: err.message }));
  return {
    ok: out.code === 0,
    checked: true,
    stdout: redactString(out.stdout || ''),
    stderr: redactString(out.stderr || '')
  };
}

export async function codexAppIntegrationStatus(opts: any = {}) {
  const appPath = await findCodexApp(opts);
  const codex = opts.codex || await getCodexInfo().catch(() => EMPTY_CODEX_INFO);
  const mcpList = await codexMcpList({ ...opts, codex });
  const featureList = await codexFeatureList({ ...opts, codex });
  const remoteControl = codexRemoteControlStatusFromInfo(codex);
  const mcpText = `${mcpList.stdout}\n${mcpList.stderr}`;
  const featureText = `${featureList.stdout}\n${featureList.stderr}`;
  const browserUsePath = await findPluginCache('browser-use', opts);
  const chromePath = await findPluginCache('chrome', opts);
  const computerUsePath = await findPluginCache('computer-use', opts);
  const defaultPlugins = await codexDefaultPluginStatus(opts);
  const productDesignPlugin = await codexProductDesignPluginStatus(opts);
  const pluginSkillShadows = await codexPluginSkillShadowStatus(opts);
  const fastModeConfig = await codexFastModeConfigStatus(opts);
  const providerModelUi = await codexProviderModelUiStatus(opts);
  const nativeSksMenu = codexNativeSksMenuStatus();
  const computerUseMcpListed = /computer[-_ ]?use/i.test(mcpText);
  const browserUseMcpListed = /browser[-_ ]?use/i.test(mcpText);
  const imageGenerationReady = codexFeatureEnabled(featureText, 'image_generation');
  const inAppBrowserReady = codexFeatureEnabled(featureText, 'in_app_browser');
  const browserUseFeatureReady = codexFeatureEnabled(featureText, 'browser_use');
  const requiredFeatureFlags = Object.fromEntries(REQUIRED_CODEX_APP_FEATURE_FLAGS.map((name: any) => [name, codexFeatureEnabled(featureText, name)]));
  const requiredFeatureFlagsOk = Object.values(requiredFeatureFlags).every(Boolean);
  const computerUseReady = computerUseMcpListed || Boolean(computerUsePath);
  const browserUseReady = browserUseMcpListed || Boolean(browserUsePath);
  const browserToolReady = inAppBrowserReady || browserUseFeatureReady || browserUseReady;
  const appInstalled = Boolean(appPath);
  const chromeExtension = codexChromeExtensionStatusFromApp({
    appInstalled,
    codex,
    featureList,
    requiredFeatureFlags,
    defaultPlugins,
    pluginSkillShadows,
    chromePath
  });
  const pluginPickerReady = requiredFeatureFlags.tool_suggest && requiredFeatureFlags.plugins && requiredFeatureFlags.apps && defaultPlugins.ok && pluginSkillShadows.ok && fastModeConfig.ok;
  const gitActions = codexGitActionReadiness({ requiredFeatureFlags, remoteControl });
  const selectedProviderReady = providerModelUi.effective_ready === true;
  const ready = appInstalled && Boolean(codex.bin) && mcpList.ok && featureList.ok && requiredFeatureFlagsOk && pluginPickerReady && fastModeConfig.ok && selectedProviderReady && imageGenerationReady && gitActions.ok && computerUseReady && browserToolReady && chromeExtension.ok;
  return {
    ok: ready,
    app: {
      installed: appInstalled,
      path: appPath,
      docs_url: CODEX_APP_DOCS_URL,
      sks_menu: nativeSksMenu
    },
    codex_cli: {
      ok: Boolean(codex.bin),
      bin: codex.bin || null,
      version: codex.version || null
    },
    remote_control: remoteControl,
    mcp: {
      checked: mcpList.checked,
      ok: mcpList.ok,
      has_computer_use: computerUseReady,
      has_browser_use: browserUseReady,
      computer_use_source: computerUseMcpListed ? 'mcp_list' : computerUsePath ? 'plugin_cache' : 'missing',
      browser_use_source: browserUseMcpListed ? 'mcp_list' : browserUsePath ? 'plugin_cache' : 'missing',
      stdout: mcpList.stdout,
      stderr: mcpList.stderr
    },
    features: {
      checked: featureList.checked,
      ok: featureList.ok,
      ...requiredFeatureFlags,
      required_flags: requiredFeatureFlags,
      required_flags_ok: requiredFeatureFlagsOk,
      fast_mode_config: fastModeConfig,
      provider_model_ui: providerModelUi,
      selected_provider_ready: selectedProviderReady,
      codex_lb_capabilities: opts.codexLbCapabilityReport || null,
      git_actions: gitActions,
      image_generation: imageGenerationReady,
      image_generation_source: imageGenerationReady ? 'codex_features_list' : 'missing',
      in_app_browser: inAppBrowserReady,
      browser_use: browserUseFeatureReady,
      browser_tool_ready: browserToolReady,
      chrome_extension: chromeExtension.ok,
      chrome_extension_source: chromeExtension.source,
      chrome_extension_docs_url: CODEX_CHROME_EXTENSION_SETUP_DOCS_URL,
      browser_tool_source: inAppBrowserReady
        ? 'codex_features_list:in_app_browser'
        : browserUseFeatureReady
          ? 'codex_features_list:browser_use'
          : browserUseMcpListed
            ? 'mcp_list:browser_use'
            : browserUsePath
              ? 'plugin_cache:browser-use'
              : 'missing',
      stdout: featureList.stdout,
      stderr: featureList.stderr
    },
    plugins: {
      computer_use_cache: computerUsePath,
      browser_use_cache: browserUsePath,
      chrome_cache: chromePath,
      default_plugins: defaultPlugins,
      design_product: productDesignPlugin,
      skill_shadows: pluginSkillShadows,
      picker: {
        ok: pluginPickerReady,
        required_flags_ok: Boolean(requiredFeatureFlags.tool_suggest && requiredFeatureFlags.plugins && requiredFeatureFlags.apps),
        default_plugins_ok: defaultPlugins.ok,
        skill_shadows_ok: pluginSkillShadows.ok,
        fast_mode_config_ok: fastModeConfig.ok
      }
    },
    chrome_extension: chromeExtension,
    guidance: codexAppGuidance({ appInstalled, codex, mcpList, featureList, requiredFeatureFlags, requiredFeatureFlagsOk, defaultPlugins, productDesignPlugin, pluginSkillShadows, fastModeConfig, providerModelUi, nativeSksMenu, gitActions, imageGenerationReady, inAppBrowserReady, browserUseFeatureReady, computerUseReady, browserUseReady, browserToolReady, computerUseMcpListed, browserUseMcpListed, chromeExtension, remoteControl })
  };
}

export async function codexChromeExtensionStatus(opts: any = {}) {
  if (opts.forceMissing === true || process.env.SKS_TEST_FORCE_CHROME_EXTENSION_MISSING === '1') {
    return codexChromeExtensionStatusFromApp({
      app: { installed: true },
      codex_cli: { ok: true },
      features: { ok: true, required_flags: { browser_use_external: true, plugins: true, apps: true } },
      plugins: { default_plugins: { entries: [] }, skill_shadows: { blocking: [] } }
    });
  }
  const status = opts.status || await codexAppIntegrationStatus(opts);
  return codexChromeExtensionStatusFromApp(status);
}

export function codexChromeExtensionStatusFromApp(input: any = {}) {
  const status = input.chrome_extension ? input : null;
  if (status?.chrome_extension?.schema === 'sks.codex-chrome-extension-status.v1') return status.chrome_extension;
  const appInstalled = Boolean(input.appInstalled ?? input.app?.installed);
  const codexOk = Boolean(input.codex?.bin ?? input.codex_cli?.ok);
  const featureListOk = input.featureList?.ok ?? input.features?.ok ?? false;
  const flags = input.requiredFeatureFlags || input.features?.required_flags || {};
  const defaultPlugins = input.defaultPlugins || input.plugins?.default_plugins || {};
  const pluginSkillShadows = input.pluginSkillShadows || input.plugins?.skill_shadows || {};
  const chromeEntry = Array.isArray(defaultPlugins.entries)
    ? defaultPlugins.entries.find((entry: any) => entry?.name === 'chrome' || entry?.id === 'chrome@openai-bundled')
    : null;
  const chromePath = input.chromePath || input.plugins?.chrome_cache || chromeEntry?.source || null;
  const blockers: string[] = [];
  if (!appInstalled) blockers.push('codex_app_missing');
  if (!codexOk) blockers.push('codex_cli_missing');
  if (!featureListOk) blockers.push('codex_feature_list_unverified');
  if (featureListOk && flags.browser_use_external !== true) blockers.push('browser_use_external_feature_missing');
  if (featureListOk && flags.plugins !== true) blockers.push('plugins_feature_missing');
  if (featureListOk && flags.apps !== true) blockers.push('apps_feature_missing');
  if (!chromeEntry && chromePath) blockers.push('chrome_extension_plugin_cache_only_unverified');
  if (!chromeEntry && !chromePath) blockers.push('chrome_extension_plugin_missing');
  if (chromeEntry && chromeEntry.installed !== true) blockers.push('chrome_extension_plugin_not_installed');
  if (chromeEntry && chromeEntry.enabled !== true) blockers.push('chrome_extension_plugin_not_enabled');
  const chromeShadow = Array.isArray(pluginSkillShadows.blocking)
    ? pluginSkillShadows.blocking.find((entry: any) => entry?.name === 'chrome')
    : null;
  if (chromeShadow) blockers.push(`chrome_plugin_shadow:${chromeShadow.scope || 'unknown'}`);
  const ok = blockers.length === 0;
  return {
    schema: 'sks.codex-chrome-extension-status.v1',
    ok,
    status: ok ? 'available' : 'setup_required',
    evidence_source: 'codex_chrome_extension',
    docs_url: CODEX_CHROME_EXTENSION_SETUP_DOCS_URL,
    source: chromeEntry?.source ? 'default_plugin' : chromePath ? 'plugin_cache_unverified' : 'missing',
    plugin: {
      installed: Boolean(chromeEntry?.installed),
      enabled: chromeEntry ? chromeEntry.enabled === true : false,
      id: chromeEntry?.id || 'chrome@openai-bundled',
      source: chromeEntry?.source || null,
      cache_detected: Boolean(chromePath),
      cache_source: chromePath || null
    },
    required_flags: ['browser_use_external', 'plugins', 'apps'],
    blockers,
    guidance: ok
      ? ['Codex Chrome Extension path is ready for web/browser/webapp verification.']
      : [
        `Install and enable the Codex Chrome Extension first: ${CODEX_CHROME_EXTENSION_SETUP_DOCS_URL}`,
        'After installation is complete, tell SKS that the extension is installed; only then resume web QA/UX/browser verification.',
        'Do not use Codex Computer Use to bypass this web verification gate.'
      ]
  };
}

export async function codexRemoteControlStatus(opts: any = {}) {
  const codex = opts.codex || await getCodexInfo().catch(() => EMPTY_CODEX_INFO);
  return codexRemoteControlStatusFromInfo(codex);
}

export function codexRemoteControlStatusFromInfo(codex: any = {}) {
  const current = codexCliVersionNumber(codex.version);
  const versionKnown = Boolean(current);
  const supported = Boolean(codex.bin && current && compareVersions(current, CODEX_REMOTE_CONTROL_MIN_VERSION) >= 0);
  return {
    ok: supported,
    min_version: CODEX_REMOTE_CONTROL_MIN_VERSION,
    docs_url: CODEX_CHANGELOG_URL,
    codex_cli: {
      ok: Boolean(codex.bin),
      bin: codex.bin || null,
      version: codex.version || null,
      version_number: current
    },
    command: codex.bin ? `${codex.bin} remote-control` : 'codex remote-control',
    reason: supported
      ? 'available'
      : !codex.bin
        ? 'codex_cli_missing'
        : versionKnown
          ? `requires_codex_cli_${CODEX_REMOTE_CONTROL_MIN_VERSION}_or_newer`
          : 'codex_cli_version_unknown'
  };
}

export function codexSupportsRemoteControl(versionText: any) {
  const current = codexCliVersionNumber(versionText);
  return Boolean(current && compareVersions(current, CODEX_REMOTE_CONTROL_MIN_VERSION) >= 0);
}

export function parseProcessRows(text: any = '') {
  return String(text || '')
    .split(/\r?\n/)
    .map((line: any) => line.trim())
    .filter(Boolean)
    .map((line: any) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
        command: match[3]
      };
    })
    .filter((row: any) => Number.isFinite(row?.pid) && Number.isFinite(row?.ppid) && row.command);
}

export function findCodexAppUpgradeRepairTargets(rows: any = []) {
  return rows.filter((row: any) => (
    row?.ppid === 1
    && /\/Codex\.app\/Contents\/Resources\/codex\s+app-server\s+--analytics-default-enabled(?:\s|$)/.test(String(row.command || ''))
  ));
}

export async function reconcileCodexAppUpgradeProcesses(opts: any = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  if (platform !== 'darwin') return { status: 'skipped', reason: 'platform', killed: [] };
  if (env.SKS_SKIP_CODEX_APP_UPGRADE_REPAIR === '1') return { status: 'skipped', reason: 'SKS_SKIP_CODEX_APP_UPGRADE_REPAIR=1', killed: [] };
  const run = opts.runProcess || runProcess;
  const ps = await run('ps', ['-axo', 'pid=', '-o', 'ppid=', '-o', 'command='], {
    timeoutMs: opts.timeoutMs || 5000,
    maxOutputBytes: opts.maxOutputBytes || 256 * 1024
  }).catch((err: any) => ({ code: 1, stdout: '', stderr: err.message }));
  if (ps.code !== 0) return { status: 'failed', reason: 'ps_failed', error: ps.stderr || ps.stdout || 'ps exited non-zero', killed: [] };
  const rows = parseProcessRows(ps.stdout);
  const targets = findCodexAppUpgradeRepairTargets(rows);
  const killed: any[] = [];
  const failed: any[] = [];
  for (const target of targets) {
    if (opts.dryRun) {
      killed.push({ pid: target.pid, command: target.command, dry_run: true });
      continue;
    }
    const kill = await run('kill', ['-TERM', String(target.pid)], {
      timeoutMs: opts.timeoutMs || 5000,
      maxOutputBytes: 8 * 1024
    }).catch((err: any) => ({ code: 1, stdout: '', stderr: err.message }));
    if (kill.code === 0) killed.push({ pid: target.pid, command: target.command });
    else failed.push({ pid: target.pid, command: target.command, error: kill.stderr || kill.stdout || 'kill exited non-zero' });
  }
  return {
    status: failed.length ? 'partial' : killed.length ? 'repaired' : 'clean',
    killed,
    failed,
    checked: rows.length
  };
}

export function formatCodexRemoteControlStatus(status: any) {
  const lines = [
    'Codex remote-control',
    '',
    `Codex CLI: ${status.codex_cli.ok ? 'ok' : 'missing'}${status.codex_cli.version ? ` ${status.codex_cli.version}` : ''}`,
    `Minimum:   ${status.min_version}`,
    `Ready:     ${status.ok ? 'yes' : 'no'}`,
    `Command:   ${status.command}`,
    '',
    status.ok
      ? 'Run: sks codex-app remote-control -- <codex remote-control args>'
      : remoteControlGuidance(status)
  ];
  return lines.filter(Boolean).join('\n');
}

export function codexAccessTokenStatus(env: any = process.env) {
  const accessTokenVars = ['CODEX_ACCESS_TOKEN'];
  const adjacentSecretVars = ['OPENAI_API_KEY', 'CODEX_LB_API_KEY'];
  const accessTokens = accessTokenVars.map((name: any) => ({ name, present: Boolean(env[name]), value: env[name] ? '[redacted]' : null }));
  const adjacentSecrets = adjacentSecretVars.map((name: any) => ({ name, present: Boolean(env[name]), value: env[name] ? '[redacted]' : null }));
  const extraTokenLikeVars = Object.keys(env)
    .filter((name: any) => /(?:CODEX|OPENAI|CHATGPT).*TOKEN/i.test(name) && !accessTokenVars.includes(name))
    .sort()
    .map((name: any) => ({ name, present: true, value: '[redacted]' }));
  const present = accessTokens.some((entry: any) => entry.present);
  return {
    schema: 'sks.codex-access-token-status.v1',
    ok: true,
    status: present ? 'present_redacted' : 'missing',
    supported_for: 'ChatGPT Business and Enterprise workspace programmatic local Codex workflows',
    docs_url: CODEX_ACCESS_TOKENS_DOCS_URL,
    official_cli_ingest: 'codex login --with-access-token reads CODEX_ACCESS_TOKEN from stdin when the caller provides it',
    storage_policy: 'Store access tokens in an external secret manager or ephemeral environment variable; never write plaintext tokens into .sneakoscope, hooks, proof, stdout, stderr, or screenshots.',
    access_token_env_vars: accessTokens,
    adjacent_secret_env_vars: adjacentSecrets,
    extra_token_like_env_vars: extraTokenLikeVars,
    redaction: {
      ok: true,
      strategy: 'presence-only reporting with literal [redacted] value placeholders'
    },
    warnings: present
      ? ['Token presence was detected without printing the value. Rotate regularly and use only trusted runners.']
      : ['No CODEX_ACCESS_TOKEN detected in the current process environment. This is fine for interactive ChatGPT login or API-key auth.']
  };
}

function codexNativeSksMenuStatus() {
  return {
    schema: 'sks.codex-app-native-menu.v1',
    supported: false,
    status: 'unsupported_official_api',
    requested_label: 'SKS',
    requested_position: 'between Window and Help',
    companion_supported: process.platform === 'darwin',
    companion_position: 'right macOS menu bar status item',
    companion_install_command: 'sks doctor --fix',
    alternatives: [
      'sks doctor --fix',
      'sks codex-lb use-desktop-full',
      'sks codex-lb disable',
      'sks codex-app set-openrouter-key --api-key-stdin',
      'codex://settings'
    ],
    evidence: [
      'Codex official docs expose settings deep links, slash commands, skills/plugins, and app-server/remote-control surfaces, not third-party native macOS menu insertion.'
    ]
  };
}

export function codexAppGuidance({ appInstalled, codex, mcpList, featureList, requiredFeatureFlags = {}, requiredFeatureFlagsOk = true, defaultPlugins = { ok: true, missing_enabled: [] }, productDesignPlugin = null, pluginSkillShadows = { ok: true, blocking: [] }, fastModeConfig = { ok: true, blockers: [] }, providerModelUi = null, nativeSksMenu = null, gitActions = { ok: true, blockers: [] }, imageGenerationReady, inAppBrowserReady, browserUseFeatureReady, computerUseReady, browserUseReady, browserToolReady, computerUseMcpListed, browserUseMcpListed, chromeExtension, remoteControl }: any) {
  const lines: any[] = [];
  if (!appInstalled) {
    lines.push('Install and open Codex App for first-party MCP/plugin tools. SKS Zellij launch can still run with Codex CLI alone, but Codex Computer Use and imagegen/gpt-image-2 evidence will be unavailable until Codex App is ready.');
    lines.push(`Docs: ${CODEX_APP_DOCS_URL}`);
  }
  if (!codex?.bin) lines.push('Install Codex CLI too: npm i -g @openai/codex, or set SKS_CODEX_BIN.');
  if (remoteControl?.ok) {
    lines.push('Codex remote-control is available for headless remotely controllable app-server sessions: sks codex-app remote-control.');
    lines.push('Codex CLI 0.130.0+ app-server threads can pick up config changes without restarting the app-server; restart older CLI/TUI sessions if they were launched before config changes.');
  } else if (codex?.bin) {
    lines.push(remoteControlGuidance(remoteControl || codexRemoteControlStatusFromInfo(codex)));
  }
  if (mcpList?.checked && !mcpList.ok) {
    lines.push(`Codex MCP/config check failed: ${summarizeCodexMcpError(mcpList.stderr || mcpList.stdout)}`);
    lines.push('Verify with: codex mcp list');
  }
  if (featureList?.checked && !featureList.ok) {
    lines.push(`Codex feature check failed: ${summarizeCodexMcpError(featureList.stderr || featureList.stdout)}`);
    lines.push('Verify with: codex features list');
  }
  if (featureList?.checked && featureList.ok && !requiredFeatureFlagsOk) {
    const missing = missingRequiredFeatureFlags(requiredFeatureFlags);
    lines.push(`Codex App feature flag(s) disabled or missing: ${missing.join(', ')}. Commit message generation, mobile/remote-control, and app-only tool paths can fail even when CLI chat works.`);
    lines.push('Verify with: codex features list | rg "codex_git_commit|hooks|fast_mode|computer_use|browser_use|browser_use_external|image_generation|in_app_browser|guardian_approval|tool_suggest|apps|plugins"');
  }
  if (defaultPlugins?.missing_enabled?.length) {
    lines.push(`Codex default plugin(s) installed but not enabled: ${defaultPlugins.missing_enabled.join(', ')}. Composer/tool UI can hide built-in surfaces even while feature flags look green.`);
    lines.push('Run: sks doctor --fix');
  }
  if (defaultPlugins?.missing_installed?.length) {
    lines.push(`Codex default plugin source(s) missing: ${defaultPlugins.missing_installed.join(', ')}. The @ plugin picker can hide built-in surfaces when plugin files are absent even if config says enabled.`);
    lines.push('Run: sks doctor --fix, then restart Codex App if the plugin cache was just restored.');
  }
  if (productDesignPlugin?.ok) {
    lines.push(`Product Design plugin is ready for design routes via ${productDesignPlugin.source || 'verified evidence'} (${productDesignPlugin.id}).`);
  } else if (productDesignPlugin?.auto_install?.attempted) {
    lines.push(`Product Design auto-install was attempted but did not produce ready evidence: ${(productDesignPlugin.blockers || []).join(', ') || 'unverified'}. Recheck with: ${productDesignPlugin.auto_install.command}`);
  } else if (productDesignPlugin?.app_server?.checked && !productDesignPlugin.app_server.ok) {
    lines.push(`Product Design app-server lookup ran but is not ready: ${(productDesignPlugin.blockers || []).join(', ') || 'unverified'}. Run: ${productDesignPlugin.auto_install?.command || 'sks codex-app product-design --json'}`);
  } else if (productDesignPlugin?.remote_lookup_required) {
    lines.push(`Product Design is a remote vertical marketplace plugin and may not appear in \`codex plugin list\`; design routes should run ${productDesignPlugin.auto_install?.command || 'sks codex-app product-design --json'} or set ${PRODUCT_DESIGN_AUTO_INSTALL_ENV}=1 before falling back to legacy design.md skills.`);
  }
  if (pluginSkillShadows?.generated?.length) {
    const names = pluginSkillShadows.generated.map((entry: any) => `${entry.name}:${entry.scope}`).join(', ');
    lines.push(`Codex plugin picker generated skill shadow(s) detected: ${names}. Generated SKS skills with first-party plugin names can hide @ plugin entries after upgrades.`);
    lines.push('Run: sks doctor --fix');
  }
  if (pluginSkillShadows?.custom?.length) {
    const names = pluginSkillShadows.custom.map((entry: any) => `${entry.name}:${entry.scope}`).join(', ');
    lines.push(`Codex plugin picker user-owned reserved skill name(s) detected: ${names}. Rename or remove these custom skills to avoid hiding first-party @ plugin entries; SKS doctor will not delete user-owned skills.`);
  }
  if (fastModeConfig?.blockers?.length) {
    lines.push(`Codex App speed selector can be hidden or locked by config: ${fastModeConfig.blockers.join(', ')}.`);
    lines.push('Run: sks doctor --fix');
  }
  if (providerModelUi?.glm?.exposed && providerModelUi.glm.openrouter_key_present) {
    lines.push(`OpenRouter provider is ready: ${providerModelUi.glm.model} (activate with ${providerModelUi.glm.install_command}).`);
  } else if (providerModelUi?.glm?.exposed) {
    lines.push(`OpenRouter provider is present for ${providerModelUi.glm.model}, but the OpenRouter key is missing.`);
    lines.push(`Run: ${providerModelUi.glm.key_command}; restart Codex App if the model picker was already open.`);
  } else if (providerModelUi?.glm) {
    lines.push(`OpenRouter provider is not ready yet: ${providerModelUi.glm.blockers.join(', ') || 'provider setup required'}.`);
    lines.push(`Run: ${providerModelUi.glm.key_command}; then ${providerModelUi.glm.install_command}; restart Codex App if the model picker was already open.`);
  }
  if (providerModelUi?.codex_lb?.key_entry_visible && providerModelUi.codex_lb.key_present && providerModelUi.codex_lb.provider_present && providerModelUi.codex_lb.provider_contract_ok && providerModelUi.codex_lb.base_url_present) {
    lines.push(`codex-lb key entry path is configured; provider catalog ${providerModelUi.codex_lb.expected_models_present ? 'contains GPT-5.6 Sol/Terra/Luna' : 'is not verified'}. Update command: ${providerModelUi.codex_lb.set_key_command}.`);
    lines.push('Provider/config readiness does not by itself prove the already-running Desktop picker; auth/profile actions restart ChatGPT/Codex so it reloads model/list.');
  } else if (providerModelUi?.codex_lb?.key_entry_visible) {
    lines.push(`codex-lb key entry path is visible, but setup is incomplete: ${providerModelUi.codex_lb.blockers.join(', ') || 'setup required'}.`);
    lines.push(`Run: ${providerModelUi.codex_lb.setup_command} or ${providerModelUi.codex_lb.set_key_command}.`);
  } else if (providerModelUi?.codex_lb) {
    lines.push(`codex-lb key entry path is not exposed yet: ${providerModelUi.codex_lb.blockers.join(', ') || 'setup required'}.`);
    lines.push(`Run: ${providerModelUi.codex_lb.setup_command} or ${providerModelUi.codex_lb.set_key_command}.`);
  }
  if (!gitActions?.ok) {
    lines.push(`Codex App git commit/push actions are blocked: ${gitActions?.blockers?.join(', ') || 'git action readiness'}. The app Commit, Push, Commit and Push, and PR flows need codex_git_commit, hooks, and Codex CLI remote-control support.`);
    lines.push('Run: sks doctor --fix; if remote-control is still blocked, update Codex CLI to the official latest stable release and restart older app-server/TUI sessions.');
  } else {
    lines.push('Codex App git actions are enabled for Commit, Push, Commit and Push, and PR flows; SKS hooks treat those app metadata actions as lightweight git UI actions.');
  }
  if (nativeSksMenu?.supported === false) {
    lines.push('Codex App does not expose a documented third-party API for inserting SKS between Window and Help, so SKS uses a right-side macOS menu bar companion instead. Run `sks doctor --fix` to install or refresh it.');
  }
  if (appInstalled && (!computerUseReady || !browserToolReady)) {
    lines.push('Open Codex App settings and enable recommended MCP/plugin tools. Codex CLI sessions that expose remote-control/app-server can pick up config changes live; restart older CLI/TUI sessions.');
    lines.push(`Required for SKS web QA/UX/browser evidence: Codex Chrome Extension first (${CODEX_CHROME_EXTENSION_SETUP_DOCS_URL}). Computer Use is reserved for native Mac/non-web surfaces.`);
    lines.push('Verify with: codex features list; codex mcp list');
  }
  if (chromeExtension && !chromeExtension.ok) {
    lines.push(`Codex Chrome Extension is not ready for web/browser/webapp verification: ${chromeExtension.blockers?.join(', ') || 'setup_required'}.`);
    lines.push(`Set it up first: ${CODEX_CHROME_EXTENSION_SETUP_DOCS_URL}`);
  } else if (chromeExtension?.ok) {
    lines.push('Codex Chrome Extension is ready; SKS web/browser/webapp QA and UX review should use it before any other web surface.');
  }
  if (imageGenerationReady) {
    lines.push('Image generation is enabled; required raster assets and generated image-review evidence must invoke $imagegen/gpt-image-2 and record real output.');
  } else if (appInstalled || codex?.bin) {
    lines.push('Codex image_generation was not visible from `codex features list`. Required imagegen/gpt-image-2 evidence must stay blocked or unverified until $imagegen is available in Codex App.');
    lines.push('Run: sks doctor --fix to attempt Codex CLI/App image_generation repair, then rerun the blocked visual route.');
  }
  if (computerUseReady && !computerUseMcpListed) {
    lines.push('Computer Use plugin files are installed, but this check cannot prove the current thread exposes the live Computer Use tools. Start a new Codex App thread and invoke @Computer or @AppName only for native Mac/non-web target apps or screens; web/browser/webapp verification must use the Chrome Extension gate.');
  }
  if (browserToolReady) {
    const source = inAppBrowserReady ? 'in-app browser feature' : browserUseFeatureReady ? 'browser_use feature' : 'Browser Use plugin';
    lines.push(`Browser tooling is visible via ${source}; SKS web verification still gates on the Codex Chrome Extension before proceeding.`);
  }
  if (browserUseReady && !browserUseMcpListed) {
    lines.push('Browser Use plugin files are installed, but `codex mcp list` does not list a browser-use MCP server. Treat Browser Use as plugin-scoped, not as SKS browser verification evidence.');
  }
  if (!lines.length) lines.push('Codex App, Codex CLI, Chrome Extension, native Computer Use, Browser tooling, and image generation checks look ready. Web UI E2E uses the Chrome Extension path; native non-web visual evidence uses Computer Use; generated image evidence still requires $imagegen/gpt-image-2 output.');
  return lines;
}

export function formatCodexAppStatus(status: any, { includeRaw = false }: any = {}) {
  const lines = [
    'Codex App / MCP Plugin Readiness',
    '',
    `Codex App:   ${status.app.installed ? 'ok' : 'missing'}${status.app.path ? ` ${status.app.path}` : ''}`,
    `Codex CLI:   ${status.codex_cli.ok ? 'ok' : 'missing'}${status.codex_cli.version ? ` ${status.codex_cli.version}` : ''}`,
    `Remote Ctrl: ${status.remote_control?.ok ? 'ok' : 'missing'}${status.remote_control?.codex_cli?.version_number ? ` min ${status.remote_control.min_version}` : ''}`,
    `App Flags:  ${status.features?.required_flags_ok ? 'ok' : `missing ${missingRequiredFeatureFlags(status.features?.required_flags).join(', ') || 'required flags'}`}`,
    `Fast UI:    ${status.features?.fast_mode_config?.ok ? 'ok' : `locked ${(status.features?.fast_mode_config?.blockers || []).join(', ') || 'config'}`}`,
    `SKS Menu:   ${sksNativeMenuSummary(status.app?.sks_menu)}`,
    `Provider UI:${providerModelUiSummary(status.features?.provider_model_ui)}`,
    `GLM Model:  ${glmModelUiSummary(status.features?.provider_model_ui?.glm)}`,
    `codex-lb Key:${codexLbKeyUiSummary(status.features?.provider_model_ui?.codex_lb)}`,
    `Default Plugins:${status.plugins?.default_plugins?.ok ? ' ok' : ` missing ${defaultPluginMissingSummary(status.plugins?.default_plugins) || 'plugin install/config'}`}`,
    `Product Design:${productDesignStatusSummary(status.plugins?.design_product)}`,
    `Plugin Picker:${status.plugins?.picker?.ok ? ' ok' : ` blocked ${pluginPickerBlockers(status).join(', ') || 'config'}`}`,
    `Git Actions:${status.features?.git_actions?.ok ? ' ok' : ` blocked ${(status.features?.git_actions?.blockers || []).join(', ') || 'config'}`}`,
    `Chrome Ext: ${status.chrome_extension?.ok ? 'ok' : `setup ${(status.chrome_extension?.blockers || []).join(', ') || 'required'}`}`,
    `Computer Use:${status.mcp.has_computer_use ? status.mcp.computer_use_source === 'plugin_cache' ? ' installed (verify @Computer in thread)' : ' ok' : ' missing'}`,
    `Browser:     ${status.features?.browser_tool_ready ? `ok (${status.features.browser_tool_source})` : status.mcp.has_browser_use ? status.mcp.browser_use_source === 'plugin_cache' ? 'installed (plugin scoped)' : 'ok' : 'missing'}`,
    `Image Gen:   ${status.features?.image_generation ? 'ok ($imagegen/gpt-image-2)' : status.features?.checked ? 'missing' : 'not checked'}`,
    `Ready:       ${status.ok ? 'yes' : 'no'}`,
    '',
    ...status.guidance.map((line: any) => `- ${line}`)
  ];
  if (includeRaw && status.mcp.stdout) lines.push('', status.mcp.stdout.trim());
  if (includeRaw && status.features?.stdout) lines.push('', status.features.stdout.trim());
  return lines.join('\n');
}

export function formatCodexProductDesignPluginStatus(status: any) {
  const lines = [
    'Codex App Product Design Plugin',
    '',
    `Ready:        ${status.ok ? 'yes' : 'no'}`,
    `Installed:    ${status.installed ? 'yes' : 'no'}`,
    `Enabled:      ${status.enabled === true ? 'yes' : status.enabled === false ? 'no' : 'unknown'}`,
    `Source:       ${status.source || 'unverified'}`,
    `Marketplace:  ${status.marketplace}`,
    `Remote ID:    ${status.remote_plugin_id}`,
    `Auto Install: ${status.auto_install?.requested ? 'requested' : 'not requested'}${status.auto_install?.attempted ? ' (attempted)' : ''}`,
    `Command:      ${status.auto_install?.command || 'sks codex-app product-design --json'}`,
    '',
    ...(status.blockers || []).map((blocker: any) => `- ${blocker}`)
  ];
  if (status.remote_evidence?.missing_skills?.length) {
    lines.push(`- missing skills: ${status.remote_evidence.missing_skills.join(', ')}`);
  }
  if (status.ok) lines.push('- Product Design is ready for design routes.');
  else if (!status.auto_install?.requested) lines.push('- Run `sks codex-app product-design --json`, or set SKS_PRODUCT_DESIGN_AUTO_INSTALL=1 for design-route auto-ensure.');
  return lines.join('\n');
}

function summarizeCodexMcpError(text: any) {
  const cleanLines = String(text || '')
    .split(/\r?\n/)
    .map((line: any) => line.trim())
    .filter(Boolean)
    .filter((line: any) => !line.startsWith('WARNING: proceeding'));
  const variantLine = cleanLines.find((line: any) => line.includes('unknown variant'));
  const errorLine = cleanLines.find((line: any) => line.startsWith('Error:'));
  if (errorLine && variantLine && errorLine !== variantLine) return `${errorLine}; ${variantLine}`;
  return variantLine || errorLine || cleanLines[0] || 'codex mcp list failed';
}

function codexFeatureEnabled(text: any, featureName: any) {
  const expected = String(featureName || '').toLowerCase();
  return String(text || '').split(/\r?\n/).some((line: any) => {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    return parts[0]?.toLowerCase() === expected && parts[parts.length - 1]?.toLowerCase() === 'true';
  });
}

function missingRequiredFeatureFlags(flags: any = {}) {
  return REQUIRED_CODEX_APP_FEATURE_FLAGS.filter((name: any) => flags?.[name] !== true);
}

export function codexGitActionReadiness({ requiredFeatureFlags = {}, remoteControl = {} }: any = {}) {
  const blockers: any[] = [];
  if (requiredFeatureFlags.codex_git_commit !== true) blockers.push('codex_git_commit');
  if (requiredFeatureFlags.hooks !== true) blockers.push('hooks');
  if (!remoteControl?.ok) blockers.push(remoteControl?.reason || 'codex_cli_remote_control');
  const ok = blockers.length === 0;
  return {
    ok,
    blockers,
    commit: ok,
    push: ok,
    commit_push: ok,
    pull_request: ok,
    required_flags: ['codex_git_commit', 'hooks'],
    required_capabilities: ['codex_cli_remote_control'],
    remote_control_min_version: CODEX_REMOTE_CONTROL_MIN_VERSION
  };
}

async function codexDefaultPluginStatus(opts: any = {}) {
  const home = opts.home || os.homedir();
  const cwd = opts.cwd || process.cwd();
  const globalConfigPath = path.join(home || '', '.codex', 'config.toml');
  const projectConfigPath = path.join(cwd || '', '.codex', 'config.toml');
  const globalConfig = await readTextIfExists(globalConfigPath);
  const projectConfig = path.resolve(projectConfigPath) === path.resolve(globalConfigPath)
    ? ''
    : await readTextIfExists(projectConfigPath);
  const configText = `${globalConfig}\n${projectConfig}`;
  const entries: any[] = [];
  for (const plugin of DEFAULT_CODEX_APP_PLUGINS) {
    const source = await findDefaultPluginSource(plugin, { home, configText });
    const enabled = codexPluginEnabled(configText, plugin);
    entries.push({
      id: `${plugin.name}@${plugin.marketplace}`,
      name: plugin.name,
      marketplace: plugin.marketplace,
      installed: Boolean(source),
      source,
      enabled
    });
  }
  const installed = entries.filter((entry: any) => entry.installed);
  const missingInstalled = entries.filter((entry: any) => !entry.installed).map((entry: any) => entry.id);
  const missingEnabled = installed.filter((entry: any) => !entry.enabled).map((entry: any) => entry.id);
  return {
    ok: missingInstalled.length === 0 && missingEnabled.length === 0,
    checked: true,
    entries,
    missing_installed: missingInstalled,
    missing_enabled: missingEnabled
  };
}

export async function codexProductDesignPluginStatus(opts: any = {}) {
  const home = opts.home || os.homedir();
  const cwd = opts.cwd || process.cwd();
  const globalConfigPath = path.join(home || '', '.codex', 'config.toml');
  const projectConfigPath = path.join(cwd || '', '.codex', 'config.toml');
  const globalConfig = await readTextIfExists(globalConfigPath);
  const projectConfig = path.resolve(projectConfigPath) === path.resolve(globalConfigPath)
    ? ''
    : await readTextIfExists(projectConfigPath);
  const configText = `${globalConfig}\n${projectConfig}`;
  const plugin = { name: PRODUCT_DESIGN_PLUGIN.name, marketplace: PRODUCT_DESIGN_PLUGIN.marketplace };
  const autoInstallProductDesign = productDesignAutoInstallRequested(opts);
  const appServerStatus = opts.productDesignAppServerStatus || (autoInstallProductDesign
    ? await ensureProductDesignPluginInstalled({
        ...opts,
        autoInstallProductDesign
      })
    : null);
  const injectedRemoteEvidence = opts.productDesignPluginReadResponse
    ? normalizeProductDesignPluginEvidence(opts.productDesignPluginReadResponse)
    : null;
  const appServerEvidence = appServerStatus?.remote_evidence?.schema === 'sks.product-design-plugin-evidence.v1'
    ? appServerStatus.remote_evidence
    : null;
  const remoteEvidence = appServerEvidence || injectedRemoteEvidence;
  const localSource = await findDefaultPluginSource(plugin, { home, configText });
  const configEnabled = codexPluginEnabled(configText, plugin);
  const enabled = remoteEvidence?.enabled === true ? true : configEnabled ? true : null;
  const installed = Boolean(localSource) || remoteEvidence?.installed === true;
  const ok = Boolean(remoteEvidence?.ok || (installed && enabled === true));
  const remoteLookupRequired = !remoteEvidence?.ok && (!localSource || enabled !== true) && !appServerStatus?.checked;
  const blockers = ok ? [] : Array.from(new Set([
    ...(!installed ? ['product_design_plugin_not_installed_or_not_locally_visible'] : []),
    ...(enabled !== true ? ['product_design_plugin_enabled_state_requires_remote_evidence'] : []),
    ...(remoteLookupRequired ? ['product_design_remote_vertical_lookup_required'] : []),
    ...(autoInstallProductDesign && appServerStatus && !appServerStatus.ok ? ['product_design_app_server_install_failed'] : []),
    ...(appServerStatus?.blockers || [])
  ]));
  return {
    schema: 'sks.codex-product-design-plugin-status.v1',
    ok,
    checked: true,
    route_required_only: true,
    id: PRODUCT_DESIGN_PLUGIN.id,
    name: PRODUCT_DESIGN_PLUGIN.name,
    display_name: PRODUCT_DESIGN_PLUGIN.display_name,
    marketplace: PRODUCT_DESIGN_PLUGIN.marketplace,
    marketplace_kind: PRODUCT_DESIGN_PLUGIN.marketplace_kind,
    remote_plugin_id: PRODUCT_DESIGN_PLUGIN.remote_plugin_id,
    installed,
    enabled,
    source: remoteEvidence?.ok
      ? appServerStatus?.install_attempted ? 'app_server_plugin_install' : 'app_server_plugin_read'
      : localSource ? 'local_plugin_cache_or_marketplace_source' : null,
    local_source: localSource,
    remote_evidence: remoteEvidence,
    app_server: appServerStatus,
    auto_install: {
      requested: autoInstallProductDesign,
      attempted: Boolean(appServerStatus?.install_attempted),
      command: 'sks codex-app product-design --json',
      env: PRODUCT_DESIGN_AUTO_INSTALL_ENV
    },
    remote_lookup_required: remoteLookupRequired,
    app_server_read_params: PRODUCT_DESIGN_PLUGIN.app_server.read_params,
    app_server_install_params: PRODUCT_DESIGN_PLUGIN.app_server.install_params,
    app_server_list_params: PRODUCT_DESIGN_PLUGIN.app_server.list_params,
    blockers
  };
}

async function codexPluginSkillShadowStatus(opts: any = {}) {
  const home = opts.home || os.homedir();
  const cwd = opts.cwd || process.cwd();
  const roots = [
    { scope: 'global', root: path.join(home || '', '.agents', 'skills') }
  ];
  const projectRoot = path.join(cwd || '', '.agents', 'skills');
  const globalEntry = roots[0];
  if (globalEntry && path.resolve(projectRoot) !== path.resolve(globalEntry.root)) roots.push({ scope: 'project', root: projectRoot });
  const entries: any[] = [];
  for (const root of roots) {
    for (const name of RESERVED_CODEX_PLUGIN_SKILL_NAMES) {
      const skillPath = path.join(root.root, name, 'SKILL.md');
      if (!(await exists(skillPath))) continue;
      const text = await readTextIfExists(skillPath);
      entries.push({
        name,
        scope: root.scope,
        path: skillPath,
        generated: isGeneratedSksPluginShadow(text, name)
      });
    }
  }
  return {
    ok: entries.length === 0,
    checked: true,
    reserved_names: RESERVED_CODEX_PLUGIN_SKILL_NAMES,
    blocking: entries,
    generated: entries.filter((entry: any) => entry.generated),
    custom: entries.filter((entry: any) => !entry.generated)
  };
}

function isGeneratedSksPluginShadow(text: any = '', name: any = '') {
  const s = String(text || '');
  if (!new RegExp(`^name:\\s*${escapeRegExp(name)}\\s*$`, 'm').test(s)) return false;
  if (/\bnot generated by SKS\b/i.test(s)) return false;
  return /Sneakoscope generated|Codex App pipeline activation:|Dollar-command route generated by SKS|stale plugin collision/i.test(s);
}

async function codexFastModeConfigStatus(opts: any = {}) {
  const home = opts.home || os.homedir();
  const cwd = opts.cwd || process.cwd();
  const globalConfigPath = path.join(home || '', '.codex', 'config.toml');
  const projectConfigPath = path.join(cwd || '', '.codex', 'config.toml');
  const configs = [
    { scope: 'global', path: globalConfigPath, text: await readTextIfExists(globalConfigPath) }
  ];
  if (path.resolve(projectConfigPath) !== path.resolve(globalConfigPath)) {
    configs.push({ scope: 'project', path: projectConfigPath, text: await readTextIfExists(projectConfigPath) });
  }
  const blockers: any[] = [];
  for (const config of configs) {
    if (!config.text) continue;
    const lines = String(config.text).split(/\r?\n/);
    const topLevelEnd = lines.findIndex((line) => /^\s*\[/.test(line));
    const topLevelBound = topLevelEnd === -1 ? lines.length : topLevelEnd;
    for (let index = 0; index < topLevelBound; index += 1) {
      const line = lines[index] || '';
      if (!/^\s*model_reasoning_effort\s*=/.test(line)) continue;
      // Preserve unmarked user reasoning choices. Only SKS-provenanced locks hide Fast UI.
      if (config.scope === 'global' ? isSksOwnedGlobalUiLock(lines, index) : true) {
        blockers.push(`${config.scope}:top_level_model_reasoning_effort`);
      }
    }
    if (/(^|\n)\s*fast_default_opt_out\s*=\s*true\s*(?:#.*)?(?=\n|$)/.test(tomlTable(config.text, 'notice'))) blockers.push(`${config.scope}:fast_default_opt_out`);
  }
  // 2026-07 renewal: [user.fast_mode] left the config schema. Its PRESENCE is now
  // the defect (a stale legacy stamp), not its absence — the old visible/enabled
  // "missing" blockers inverted into a single legacy-residue blocker.
  const merged = configs.map((config: any) => config.text).join('\n');
  if (tomlTable(merged, 'user.fast_mode').trim()) blockers.push('user.fast_mode.legacy_table_present');
  return {
    ok: blockers.length === 0,
    checked: true,
    blockers
  };
}

export async function codexProviderModelUiStatus(opts: any = {}) {
  const inputEnv = opts.env || process.env;
  const home = opts.home || inputEnv.HOME || os.homedir();
  const cwd = opts.cwd || process.cwd();
  const env = { ...inputEnv, HOME: String(opts.home || inputEnv.HOME || home) };
  const globalConfigPath = opts.configPath || path.join(home || '', '.codex', 'config.toml');
  const projectConfigPath = path.join(cwd || '', '.codex', 'config.toml');
  const globalConfig = await readTextIfExists(globalConfigPath);
  const projectConfig = path.resolve(projectConfigPath) === path.resolve(globalConfigPath)
    ? ''
    : await readTextIfExists(projectConfigPath);
  const configText = `${globalConfig}\n${projectConfig}`;
  const openRouterKey = await resolveOpenRouterApiKey({ env }).catch((err: any) => ({
    key: null,
    source: null,
    key_preview: null,
    blockers: ['openrouter_key_lookup_failed'],
    warnings: [err?.message || 'openrouter key lookup failed']
  }));
  const codexLbEnvFilePath = opts.codexLbEnvPath || codexLbEnvPath(home);
  const codexLbEnvText = await readTextIfExists(codexLbEnvFilePath);
  const codexLbApiKeySource = String(env.CODEX_LB_API_KEY || '').trim()
    ? 'process.env'
    : parseShellEnvValue(codexLbEnvText, 'CODEX_LB_API_KEY')
      ? 'env-file'
      : 'missing';
  const codexLbBaseUrlSource = String(env.CODEX_LB_BASE_URL || '').trim()
    ? 'process.env'
    : parseShellEnvValue(codexLbEnvText, 'CODEX_LB_BASE_URL')
      ? 'env-file'
      : 'missing';
  const openrouterProvider = tomlTableAny(configText, [
    `model_providers.${GLM_CODEX_CONFIG_PROVIDER_ID}`,
    `model_providers."${GLM_CODEX_CONFIG_PROVIDER_ID}"`
  ]);
  const glmProviderPresent = Boolean(openrouterProvider);
  const profilesPresent: string[] = [];
  const profilesMissing: string[] = [];
  const glmProfileBlockers: string[] = [];
  for (const profileId of RETIRED_GLM_DESKTOP_CONFIG_PROFILE_IDS) {
    const body = tomlTableAny(configText, [`profiles.${profileId}`, `profiles."${profileId}"`]);
    if (!body) continue;
    profilesPresent.push(profileId);
    glmProfileBlockers.push(`retired_glm_desktop_profile_present:${profileId}`);
  }
  const codexLbProvider = tomlTableAny(configText, ['model_providers.codex-lb', 'model_providers."codex-lb"']);
  const codexLbProviderPresent = Boolean(codexLbProvider);
  const codexLbCliProviderContractOk = codexLbProviderPresent
    && hasTomlString(codexLbProvider, 'name', 'codex-lb')
    && hasTomlString(codexLbProvider, 'wire_api', 'responses')
    && hasTomlString(codexLbProvider, 'env_key', 'CODEX_LB_API_KEY')
    && hasTomlBoolean(codexLbProvider, 'supports_websockets', true)
    && hasTomlBoolean(codexLbProvider, 'requires_openai_auth', false);
  const codexLbSelectedDefault = /(?:^|\n)\s*model_provider\s*=\s*"codex-lb"\s*(?:#.*)?(?=\n|$)/.test(topLevelToml(globalConfig));
  const codexLbDesktopMode: CodexLbDesktopMode = opts.codexLbDesktopMode
    || inferCodexLbDesktopModeForUi(globalConfig);
  const retiredCodexLbCompatConfigured = codexLbDesktopMode === 'desktop-dual-auth-compat';
  const codexLbProviderContractOk = !retiredCodexLbCompatConfigured
    && codexLbCliProviderContractOk;
  const metadata = await readJsonIfExists(
    opts.codexLbMetadataPath || codexLbMetadataPath(home)
  );
  const gatewayAuthTransport = normalizeCodexLbGatewayAuthTransportForUi(
    opts.codexLbGatewayAuthTransport || metadata?.gateway_auth_transport
  );
  const localCatalogBindingAllowed = shouldBindLocalModelCatalog(codexLbDesktopMode);
  const selectedProviderValue = topLevelToml(globalConfig)
    .match(/(?:^|\n)\s*model_provider\s*=\s*"([^"]+)"\s*(?:#.*)?(?=\n|$)/)?.[1] || null;
  const managedCatalogPath = codexLbToolCatalogPath(path.join(home || '', '.codex'));
  const configuredCatalogPath = topLevelToml(globalConfig).match(/(?:^|\n)\s*model_catalog_json\s*=\s*"([^"]+)"\s*(?:#.*)?(?=\n|$)/)?.[1] || '';
  const managedCatalogConfigured = Boolean(configuredCatalogPath)
    && path.resolve(configuredCatalogPath) === path.resolve(managedCatalogPath);
  let persistedCatalog: any = null;
  if (!opts.codexLbModelCatalog && managedCatalogConfigured && localCatalogBindingAllowed) {
    persistedCatalog = await inspectCodexLbToolCatalog(managedCatalogPath).catch(() => null);
  }
  let liveCatalog = opts.codexLbModelCatalog || null;
  if (!liveCatalog && !persistedCatalog?.ok && codexLbProviderContractOk && codexLbApiKeySource !== 'missing' && codexLbBaseUrlSource !== 'missing') {
    const loadedEnv = await loadCodexLbEnv({ home, envPath: codexLbEnvFilePath }).catch(() => null);
    liveCatalog = loadedEnv
      ? await readCodexLbModelCatalog({
          loadedEnv,
          gatewayAuthTransport
        }).catch(() => null)
      : null;
  }
  // Prefer the persisted Codex-owned catalog that Desktop actually loads. Live
  // /models remains freshness telemetry and a fallback when no managed file exists.
  const codexLbModelCatalog = opts.codexLbModelCatalog || (persistedCatalog?.ok
    ? {
        ok: true,
        models: Array.isArray(persistedCatalog.gpt56_models) ? persistedCatalog.gpt56_models : [],
        blockers: [],
        source: 'persisted_model_catalog_json',
        tools_transport: persistedCatalog.tools_transport || null
      }
    : liveCatalog
      ? { ...liveCatalog, source: liveCatalog.source || 'live_models' }
      : persistedCatalog
        ? {
            ok: false,
            models: Array.isArray(persistedCatalog.gpt56_models) ? persistedCatalog.gpt56_models : [],
            blockers: persistedCatalog.blockers || ['codex_lb_persisted_catalog_invalid'],
            source: 'persisted_model_catalog_json'
          }
        : null);
  const catalogModels = Array.isArray(codexLbModelCatalog?.models) ? codexLbModelCatalog.models.map(String) : [];
  const advertisedCodexLbModelsPresent = codexLbModelCatalog?.ok === true && catalogModels.length > 0;
  const glmBlockers = [
    ...(glmProviderPresent ? [] : ['glm_openrouter_provider_missing']),
    ...glmProfileBlockers,
    ...(openRouterKey.key ? [] : ['openrouter_key_missing'])
  ];
  const codexLbBlockers = [
    ...(codexLbProviderPresent ? [] : ['codex_lb_provider_missing']),
    ...(retiredCodexLbCompatConfigured
      ? ['desktop_dual_auth_compat_unavailable']
      : codexLbProviderPresent && !codexLbProviderContractOk
        ? ['codex_lb_provider_contract_drift']
        : []),
    ...(codexLbApiKeySource !== 'missing' ? [] : ['codex_lb_api_key_missing']),
    ...(codexLbBaseUrlSource !== 'missing' ? [] : ['codex_lb_base_url_missing']),
    ...(codexLbDesktopMode === 'desktop-native-bridge' && managedCatalogConfigured
      ? ['native_bridge_local_catalog_replacement_forbidden']
      : []),
    ...(codexLbSelectedDefault && localCatalogBindingAllowed && !managedCatalogConfigured && !advertisedCodexLbModelsPresent
      ? ['codex_lb_model_catalog_json_unselected']
      : []),
    ...(codexLbProviderContractOk && codexLbApiKeySource !== 'missing' && codexLbBaseUrlSource !== 'missing' && !advertisedCodexLbModelsPresent
      ? ['codex_lb_model_catalog_unverified']
      : [])
  ];
  const openRouterSelectedDefault = selectedProviderValue === GLM_CODEX_CONFIG_PROVIDER_ID;
  const openRouterManagedCatalogPath = sksOpenRouterCatalogPath({ home });
  const openRouterCatalogBound = Boolean(configuredCatalogPath)
    && path.resolve(configuredCatalogPath) === path.resolve(openRouterManagedCatalogPath);
  // A bound OpenRouter catalog REPLACES the bundled catalog; if it survives a
  // provider switch it hides every OpenAI model until it is unbound.
  const openRouterCatalogDangling = openRouterCatalogBound && !openRouterSelectedDefault;
  const openRouterSelectedBlockers = openRouterSelectedDefault
    ? [
        ...glmBlockers,
        ...(openRouterCatalogBound ? [] : ['openrouter_model_catalog_json_unselected'])
      ]
    : [];
  const selectedProviderBlockers = [
    ...(codexLbSelectedDefault
      ? codexLbBlockers
      : openRouterSelectedDefault
        ? openRouterSelectedBlockers
        : []),
    ...(openRouterCatalogDangling ? ['openrouter_model_catalog_json_dangling'] : [])
  ];
  const optionalProviderBlockers = codexLbSelectedDefault
    ? glmBlockers
    : openRouterSelectedDefault
      ? codexLbBlockers
      : [...glmBlockers, ...codexLbBlockers];
  const keyCommand = 'sks codex-app set-openrouter-key --api-key-stdin';
  const installCommand = 'sks codex-app use-openrouter --model z-ai/glm-5.2';
  const setupCommand = 'sks codex-lb setup --host <domain> --api-key-stdin --yes';
  const setKeyCommand = 'sks codex-lb set-key --api-key-stdin';
  const desktopPickerEvidence = opts.desktopPickerEvidence
    || opts.codexLbCapabilityReport?.model_picker
    || opts.codexLbCapabilityReport?.capabilities?.model_picker
    || opts.codexLbStatus?.capabilities?.model_picker
    || null;
  const desktopPickerVerified = desktopPickerEvidence?.state === 'verified'
    || desktopPickerEvidence?.verified === true;
  const selectedProviderConfigured = selectedProviderBlockers.length === 0;
  const selectedProviderAdvertised = codexLbSelectedDefault
    ? advertisedCodexLbModelsPresent
    : true;
  const effectiveReady = selectedProviderConfigured && selectedProviderAdvertised && desktopPickerVerified;
  return {
    schema: 'sks.codex-app-provider-model-ui.v1',
    // The top-level readiness contract is intentionally scoped to the active
    // provider. Optional GLM/OpenRouter and codex-lb setup diagnostics remain
    // visible below without making an unrelated provider selection fail.
    ok: effectiveReady,
    selected_provider_ok: effectiveReady,
    configured: selectedProviderConfigured,
    advertised: selectedProviderAdvertised,
    effective_ready: effectiveReady,
    selected_provider: codexLbSelectedDefault ? 'codex-lb' : (selectedProviderValue || 'oauth'),
    selected_provider_blockers: selectedProviderBlockers,
    optional_provider_blockers: optionalProviderBlockers,
    checked: true,
    verification_scope: 'config_and_provider_catalog',
    desktop_picker_verified: desktopPickerVerified,
    desktop_picker_evidence: desktopPickerEvidence,
    readiness_state: selectedProviderBlockers.length > 0
      ? 'blocked'
      : effectiveReady
        ? 'verified'
        : 'available_unverified',
    status: selectedProviderBlockers.length > 0
      ? 'setup_required'
      : effectiveReady
        ? 'ready'
        : 'available_unverified',
    optional_provider_status: optionalProviderBlockers.length === 0 ? 'ready' : 'setup_available',
    config_paths: {
      codex_config: globalConfigPath,
      project_config: projectConfig ? projectConfigPath : null,
      codex_lb_env: codexLbEnvFilePath
    },
    glm: {
      exposed: glmProviderPresent && glmProfileBlockers.length === 0,
      provider_present: glmProviderPresent,
      provider: GLM_CODEX_CONFIG_PROVIDER_ID,
      model: GLM_52_OPENROUTER_MODEL,
      profiles_present: profilesPresent,
      profiles_missing: profilesMissing,
      openrouter_key_present: Boolean(openRouterKey.key),
      openrouter_key_source: openRouterKey.source || null,
      openrouter_key_preview: openRouterKey.key_preview || null,
      openrouter_selected: openRouterSelectedDefault,
      model_catalog_json_configured: openRouterCatalogBound,
      model_catalog_json_path: openRouterManagedCatalogPath,
      key_command: keyCommand,
      install_command: installCommand,
      doctor_command: 'sks codex-app openrouter-status',
      blockers: glmBlockers
    },
    codex_lb: {
      key_entry_visible: true,
      provider_present: codexLbProviderPresent,
      provider_contract_ok: codexLbProviderContractOk,
      provider_contract: retiredCodexLbCompatConfigured
        ? 'retired-desktop-dual-auth-compat'
        : 'cli-provider',
      selected_default: codexLbSelectedDefault,
      key_present: codexLbApiKeySource !== 'missing',
      api_key_source: codexLbApiKeySource,
      base_url_present: codexLbBaseUrlSource !== 'missing',
      base_url_source: codexLbBaseUrlSource,
      model_catalog_checked: Boolean(codexLbModelCatalog),
      model_catalog_ok: codexLbModelCatalog?.ok === true,
      model_catalog_source: codexLbModelCatalog?.source || null,
      desktop_mode: codexLbDesktopMode,
      gateway_auth_transport: gatewayAuthTransport,
      local_catalog_binding_allowed: localCatalogBindingAllowed,
      model_catalog_json_configured: managedCatalogConfigured,
      model_catalog_json_path: managedCatalogConfigured ? managedCatalogPath : configuredCatalogPath || null,
      model_catalog_models: catalogModels,
      expected_models: [],
      expected_models_present: advertisedCodexLbModelsPresent,
      advertised_models_present: advertisedCodexLbModelsPresent,
      tools_transport: codexLbModelCatalog?.tools_transport || null,
      model_catalog_blockers: codexLbModelCatalog?.blockers || [],
      setup_command: setupCommand,
      set_key_command: setKeyCommand,
      status_command: 'sks codex-lb status',
      blockers: codexLbBlockers
    },
    ui_actions: [
      keyCommand,
      installCommand,
      setupCommand,
      setKeyCommand,
      'sks codex-app status'
    ],
    blockers: selectedProviderBlockers
  };
}

async function readTextIfExists(file: any) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

async function readJsonIfExists(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function inferCodexLbDesktopModeForUi(config: string): CodexLbDesktopMode {
  const topLevel = topLevelToml(config);
  const selected = topLevel.match(
    /(?:^|\n)\s*model_provider\s*=\s*"([^"]+)"\s*(?:#.*)?(?=\n|$)/
  )?.[1] || '';
  const openAiBaseUrl = topLevel.match(
    /(?:^|\n)\s*openai_base_url\s*=\s*"([^"]+)"\s*(?:#.*)?(?=\n|$)/
  )?.[1] || '';
  if (
    config.includes('# sks-codex-lb-managed-desktop-bridge')
    && /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+\/backend-api\/codex\/?$/i.test(openAiBaseUrl)
  ) {
    return 'desktop-native-bridge';
  }
  if (
    config.includes('# sks-codex-lb-managed-desktop-compat')
    && selected === 'codex-lb'
  ) {
    return 'desktop-dual-auth-compat';
  }
  return tomlTableAny(config, ['model_providers.codex-lb', 'model_providers."codex-lb"'])
    ? 'cli-provider'
    : 'disabled';
}

function normalizeCodexLbGatewayAuthTransportForUi(
  value: unknown
): CodexLbGatewayAuthTransport {
  return value === 'authorization-bearer-compat'
    ? 'authorization-bearer-compat'
    : 'x-codex-lb-api-key';
}

async function findDefaultPluginSource(plugin: any, { home, configText }: any) {
  const cached = await findPluginCache(plugin.name, { home });
  if (cached) return cached;
  for (const source of marketplaceSources(configText, plugin.marketplace)) {
    const candidate = path.join(source, 'plugins', plugin.name, '.codex-plugin', 'plugin.json');
    if (await exists(candidate)) return path.dirname(path.dirname(candidate));
  }
  return null;
}

function marketplaceSources(configText: any = '', marketplaceName: any = '') {
  const table = `marketplaces.${marketplaceName}`;
  const re = new RegExp(`(?:^|\\n)\\[${escapeRegExp(table)}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|\\s*$)`, 'g');
  const sources: any[] = [];
  for (const match of String(configText || '').matchAll(re)) {
    const source = match[1]?.match(/(?:^|\n)\s*source\s*=\s*"([^"]+)"/)?.[1];
    if (source) sources.push(source);
  }
  return Array.from(new Set(sources));
}

function codexPluginEnabled(configText: any = '', plugin: any = {}) {
  const table = `plugins."${plugin.name}@${plugin.marketplace}"`;
  const re = new RegExp(`(?:^|\\n)\\[${escapeRegExp(table)}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|\\s*$)`);
  const block = String(configText || '').match(re)?.[1] || '';
  return /(?:^|\n)\s*enabled\s*=\s*true\s*(?:#.*)?(?=\n|$)/.test(block);
}

function pluginPickerBlockers(status: any = {}) {
  const out: any[] = [];
  if (!status.plugins?.picker?.required_flags_ok) out.push('tool_suggest/plugins/apps');
  if (!status.plugins?.picker?.default_plugins_ok) out.push('default_plugins');
  if (!status.plugins?.picker?.skill_shadows_ok) out.push('skill_shadows');
  if (!status.plugins?.picker?.fast_mode_config_ok) out.push('fast_mode_config');
  return out;
}

function productDesignStatusSummary(status: any = {}) {
  if (status.ok) return ' ok';
  if (status.auto_install?.attempted) return ' install unverified';
  if (status.remote_lookup_required) return ' remote lookup required';
  if (status.app_server?.checked) return ' app-server unverified';
  return ' not checked';
}

function providerModelUiSummary(status: any = {}) {
  if (!status?.checked) return ' not checked';
  const selected = status.selected_provider || 'oauth';
  if (status.ok) {
    const optionalSetup = (status.optional_provider_blockers || []).length > 0
      ? ', optional providers can be configured'
      : '';
    return ` ${selected} ready${optionalSetup} (live picker reload required)`;
  }
  if (status.configured && status.readiness_state === 'available_unverified') {
    return ` ${selected} configured, Desktop picker unverified`;
  }
  return ` ${selected} setup ${(status.selected_provider_blockers || status.blockers || []).join(', ') || 'required'}`;
}

function sksNativeMenuSummary(status: any = {}) {
  if (!status) return 'not checked';
  if (status.supported) return 'ok';
  return `${status.status || 'unsupported'} (use CLI/settings)`;
}

function glmModelUiSummary(status: any = {}) {
  if (!status) return 'not checked';
  if (status.exposed) {
    const key = status.openrouter_key_present ? `key ${status.openrouter_key_source || 'present'}` : 'key missing';
    return `ok ${status.model} (${key})`;
  }
  return `setup ${(status.blockers || []).join(', ') || 'provider missing'}; run ${status.key_command || 'sks codex-app set-openrouter-key --api-key-stdin'}`;
}

function codexLbKeyUiSummary(status: any = {}) {
  if (!status) return ' not checked';
  if (status.key_present && status.provider_contract_ok !== false) return ` configured (${status.api_key_source || 'present'})`;
  if (status.key_present) return ` setup provider drift; run ${status.setup_command || 'sks codex-lb setup --host <domain> --api-key-stdin --yes'}`;
  return ` missing (input: ${status.setup_command || 'sks codex-lb setup --host <domain> --api-key-stdin --yes'})`;
}

function defaultPluginMissingSummary(defaultPlugins: any = {}) {
  return [
    ...(defaultPlugins?.missing_installed || []),
    ...(defaultPlugins?.missing_enabled || [])
  ].join(', ');
}

function topLevelToml(text: any = '') {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line: any) => /^\s*\[.+\]\s*$/.test(line));
  return (firstTable === -1 ? lines : lines.slice(0, firstTable)).join('\n');
}

function tomlTable(text: any = '', table: any = '') {
  const re = new RegExp(`(?:^|\\n)\\[${escapeRegExp(table)}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|\\s*$)`);
  return String(text || '').match(re)?.[1] || '';
}

function tomlTableAny(text: any = '', tables: any[] = []) {
  for (const table of tables) {
    const body = tomlTable(text, table);
    if (body) return body;
  }
  return '';
}

function hasTomlString(text: any = '', key: any = '', value: any = '') {
  const re = new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"${escapeRegExp(value)}"\\s*(?:#.*)?(?=\\n|$)`);
  return re.test(String(text || ''));
}

function hasTomlBoolean(text: any = '', key: any = '', value: boolean) {
  const expected = value ? 'true' : 'false';
  const re = new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*${expected}\\s*(?:#.*)?(?=\\n|$)`);
  return re.test(String(text || ''));
}

// Guidance stays capability-first: the machine comparison against
// CODEX_REMOTE_CONTROL_MIN_VERSION still gates the feature, but the operator is
// told to install the official latest stable release rather than a number that
// goes stale the next time Codex ships.
function remoteControlGuidance(status: any = {}) {
  if (!status.codex_cli?.ok) return 'Codex remote-control needs a Codex CLI that exposes the app-server entrypoint. Install the official latest stable release: npm i -g @openai/codex@latest';
  if (status.reason === 'codex_cli_version_unknown') return 'Codex remote-control needs a Codex CLI that exposes the app-server entrypoint, but the installed CLI version could not be parsed. Check: codex --version';
  return 'The installed Codex CLI does not expose remote-control. Update to the official latest stable release: npm i -g @openai/codex@latest';
}

function codexCliVersionNumber(versionText: any = '') {
  const match = String(versionText || '').match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

function compareVersions(a: any, b: any) {
  const pa = String(a || '').split(/[.-]/).map((x: any) => Number.parseInt(x, 10) || 0);
  const pb = String(b || '').split(/[.-]/).map((x: any) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}
