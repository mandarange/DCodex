#!/usr/bin/env node
// @ts-nocheck
// SKS must never remove/block/hide the Codex App UI. normalizeCodexFastModeUiConfig now:
//   - sets current Codex App feature flags / suppress-warning ONLY IF ABSENT
//     (never re-enables a feature the user disabled in the App),
//   - strips legacy [user.fast_mode] and [profiles.sks-fast-high] tables,
//   - never auto-enables marketplace plugins by default (opt-in SKS_MANAGE_CODEX_APP_PLUGINS=1),
//   - still seeds defaults on a fresh/empty config (fresh-install enablement preserved).
import { assertGate, emitGate, importDist } from './gate-lib.js';

const helpers = await importDist('cli/install-helpers.js');
const normalize = helpers.normalizeCodexFastModeUiConfig;

function featureValue(text, key) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => l.trim() === '[features]');
  if (start === -1) return undefined;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i])) break;
    const m = lines[i].match(new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`));
    if (m) return m[1];
  }
  return undefined;
}
const hasPluginTables = (text) => /\[plugins\."[^"]+"\]/.test(String(text));

const results = [];
const prevEnv = process.env.SKS_MANAGE_CODEX_APP_PLUGINS;
delete process.env.SKS_MANAGE_CODEX_APP_PLUGINS;

// 1) A current feature the user disabled in the App must stay disabled (no override).
// Bare features.multi_agent is stripped; MA v2 uses [features.multi_agent_v2].
{
  const user = '[features]\nhooks = false\nmulti_agent = false\n';
  const out = normalize(user);
  const ok = featureValue(out, 'hooks') === 'false' && featureValue(out, 'multi_agent') === undefined;
  results.push({ case: 'preserves_disabled_features', ok, hooks: featureValue(out, 'hooks') });
}

// 1b) Stable host capabilities preserve an explicit user false; only a
// genuinely removed SKS stamp is stripped.
{
  const out = normalize('[features]\nguardian_approval = false\nbrowser_use_external = false\nfast_mode_ui = true\n');
  const ok = featureValue(out, 'guardian_approval') === 'false'
    && featureValue(out, 'browser_use_external') === 'false'
    && featureValue(out, 'fast_mode_ui') === undefined;
  results.push({ case: 'preserves_stable_and_strips_removed_flags', ok });
}

// 2) Default install must NOT auto-enable any marketplace plugins.
{
  const out = normalize('model = "future-codex-model"\n');
  results.push({ case: 'no_plugins_by_default', ok: !hasPluginTables(out) && /model = "future-codex-model"/.test(out) });
}

// 3) A user's disabled plugin must be left untouched (not reverted to enabled).
{
  const user = '[plugins."chrome@openai-bundled"]\nenabled = false\n';
  const out = normalize(user);
  const ok = /\[plugins\."chrome@openai-bundled"\][\s\S]*enabled = false/.test(out);
  results.push({ case: 'preserves_user_disabled_plugin', ok });
}

// 4) suppress_unstable_features_warning is not forced over a user's explicit false.
{
  const out = normalize('suppress_unstable_features_warning = false\n');
  results.push({ case: 'preserves_user_suppress_choice', ok: /suppress_unstable_features_warning = false/.test(out) });
}

// 5) Fresh/empty config still gets [features] + hooks and no legacy fast-mode tables.
{
  const out = normalize('');
  const ok = /\[features\]/.test(out)
    && featureValue(out, 'hooks') === 'true'
    && featureValue(out, 'multi_agent') === undefined
    && /\[features\.multi_agent_v2\]/.test(out)
    && featureValue(out, 'fast_mode') === 'true'
    && featureValue(out, 'computer_use') === 'true'
    && featureValue(out, 'browser_use') === 'true'
    && featureValue(out, 'browser_use_external') === 'true'
    && featureValue(out, 'image_generation') === 'true'
    && featureValue(out, 'in_app_browser') === 'true'
    && featureValue(out, 'tool_suggest') === 'true'
    && featureValue(out, 'plugins') === 'true'
    && !/\[user\.fast_mode\]/.test(out)
    && !/\[profiles\.sks-fast-high\]/.test(out)
    && !/^model\s*=/m.test(out);
  results.push({ case: 'fresh_config_seeds_defaults', ok });
}

// 7) A blank-separated SKS migration block must release only its own native
// model/reasoning locks. The documented service tier and an unrelated user
// model selection remain untouched.
{
  const migrated = normalize([
    '# SKS moved machine-local Codex config from .codex/config.toml at 2026-07-11T00:00:00Z',
    '',
    'service_tier = "fast"',
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "ultra"',
    '',
    '[features]',
    'fast_mode = true',
    ''
  ].join('\n'));
  const user = normalize('model = "user-selected-model"\nmodel_reasoning_effort = "low"\nservice_tier = "fast"\n');
  const ok = !/^model\s*=/m.test(migrated.split(/\n\s*\[/)[0] || '')
    && !/^model_reasoning_effort\s*=/m.test(migrated.split(/\n\s*\[/)[0] || '')
    && /^service_tier\s*=\s*"fast"/m.test(migrated)
    && /^model\s*=\s*"user-selected-model"/m.test(user)
    && /^model_reasoning_effort\s*=\s*"low"/m.test(user);
  results.push({ case: 'bounded_sks_mode_lock_provenance', ok });
}

// 6) Opt-in enables plugins on a fresh config, but still preserves a user-disabled one.
{
  process.env.SKS_MANAGE_CODEX_APP_PLUGINS = '1';
  const fresh = normalize('model = "future-codex-model"\n');
  const userDisabled = normalize('[plugins."chrome@openai-bundled"]\nenabled = false\n');
  delete process.env.SKS_MANAGE_CODEX_APP_PLUGINS;
  const ok = hasPluginTables(fresh) && /model = "future-codex-model"/.test(fresh) && /\[plugins\."chrome@openai-bundled"\][\s\S]*enabled = false/.test(userDisabled);
  results.push({ case: 'optin_enables_but_preserves_user', ok });
}

if (prevEnv === undefined) delete process.env.SKS_MANAGE_CODEX_APP_PLUGINS; else process.env.SKS_MANAGE_CODEX_APP_PLUGINS = prevEnv;

const ok = results.every((r) => r.ok);
if (!ok) {
  console.error(JSON.stringify({ ok: false, message: 'Codex App UI preservation regression failed', results }, null, 2));
  process.exit(1);
}
emitGate('codex-app:ui-preservation', { cases: results.map((r) => r.case) });

function tableBody(text, table) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start < 0) return '';
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}
