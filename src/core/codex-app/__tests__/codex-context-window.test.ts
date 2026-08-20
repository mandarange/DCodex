import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_CONTEXT_1M_SCHEMA,
  CODEX_CONTEXT_1M_TARGETS,
  codexContext1mCommand,
  disableCodexContext1m,
  enableCodexContext1m,
  inspectCodexContext1m,
  normalizeCodexContext1mAction
} from '../codex-context-window.js';
import { removeLegacyTopLevelCodexModeLocks } from '../../codex/codex-config-guard.js';
import { validateCodexConfigRoundTrip } from '../../codex/codex-config-toml.js';

// Mirrors the real host config shape: SKS provenance comments live above a
// non-allowlisted key (model_context_window), so the guard's mode-lock scan
// stops before it can misattribute the operator's `model` line to SKS.
const REALISTIC_CONFIG = [
  '# SKS moved machine-local Codex config from .codex/config.toml at 2026-07-10T08:47:58.841Z',
  'suppress_unstable_features_warning = true',
  'model_context_window = 400000',
  'approval_policy = "never"',
  'model = "gpt-5.6-sol"',
  '[features]',
  'fast_mode = true',
  '[projects."/Users/x/dev"]',
  'trust_level = "trusted"',
  ''
].join('\n');

test('enable inserts both managed keys before the first table on an empty config', () => {
  const result = enableCodexContext1m('');
  assert.equal(result.changed, true);
  assert.deepEqual(result.blockers, []);
  assert.match(result.next, /^model_context_window = 1000000 # sks-codex-context-1m prev=unset$/m);
  assert.match(result.next, /^model_auto_compact_token_limit = 900000 # sks-codex-context-1m prev=unset$/m);
  assert.equal(validateCodexConfigRoundTrip(result.next).ok, true);
  const inspection = inspectCodexContext1m(result.next);
  assert.equal(inspection.enabled, true);
  assert.equal(inspection.keys.model_context_window.value, CODEX_CONTEXT_1M_TARGETS.model_context_window);
});

test('enable preserves a host-owned prior value and disable restores it', () => {
  const enabled = enableCodexContext1m(REALISTIC_CONFIG);
  assert.equal(enabled.changed, true);
  assert.equal(enabled.previous.model_context_window, 400000);
  assert.equal(enabled.previous.model_auto_compact_token_limit, 'unset');
  assert.match(enabled.next, /^model_context_window = 1000000 # sks-codex-context-1m prev=400000$/m);
  // The managed keys stay in the top-level region, before every [table] header.
  const firstTable = enabled.next.indexOf('[features]');
  assert.ok(enabled.next.indexOf('model_auto_compact_token_limit') < firstTable);
  assert.equal(validateCodexConfigRoundTrip(enabled.next).ok, true);
  assert.equal(inspectCodexContext1m(enabled.next).enabled, true);

  const disabled = disableCodexContext1m(enabled.next);
  assert.equal(disabled.changed, true);
  assert.equal(disabled.restored.model_context_window, 400000);
  assert.equal(disabled.restored.model_auto_compact_token_limit, 'unset');
  assert.match(disabled.next, /^model_context_window = 400000$/m);
  assert.doesNotMatch(disabled.next, /model_auto_compact_token_limit/);
  assert.doesNotMatch(disabled.next, /sks-codex-context-1m/);
  const inspection = inspectCodexContext1m(disabled.next);
  assert.equal(inspection.enabled, false);
  assert.equal(inspection.keys.model_context_window.value, 400000);
  assert.equal(inspection.keys.model_context_window.managed, false);
});

test('enable is idempotent and keeps the original prev across re-enables', () => {
  const first = enableCodexContext1m(REALISTIC_CONFIG);
  const second = enableCodexContext1m(first.next);
  assert.equal(second.changed, false);
  assert.equal(second.previous.model_context_window, 400000);
  assert.equal(second.next, first.next);
});

test('disable never deletes a value SKS did not write', () => {
  const hostOwned = 'model_context_window = 272000\nmodel = "gpt-5.6-sol"\n';
  const result = disableCodexContext1m(hostOwned);
  assert.equal(result.changed, false);
  assert.deepEqual(result.warnings, ['codex_context_unmanaged_key_left:model_context_window']);
  assert.match(result.next, /^model_context_window = 272000$/m);
});

test('duplicate key declarations fail closed instead of rewriting ambiguous config', () => {
  const dup = 'model_context_window = 1\nmodel_context_window = 2\n';
  const enabled = enableCodexContext1m(dup);
  assert.equal(enabled.changed, false);
  assert.deepEqual(enabled.blockers, ['codex_context_duplicate_key:model_context_window']);
  const disabled = disableCodexContext1m(dup);
  assert.deepEqual(disabled.blockers, ['codex_context_duplicate_key:model_context_window']);
});

test('managed lines survive the guard mode-lock stripper without claiming the model line', () => {
  const enabled = enableCodexContext1m(REALISTIC_CONFIG);
  const stripped = removeLegacyTopLevelCodexModeLocks(enabled.next);
  assert.match(stripped, /^model = "gpt-5\.6-sol"$/m);
  assert.match(stripped, /^model_context_window = 1000000 # sks-codex-context-1m prev=400000$/m);
  assert.match(stripped, /^model_auto_compact_token_limit = 900000 # sks-codex-context-1m prev=unset$/m);
});

test('inspect flags drift when a managed value was hand-edited', () => {
  const drifted = 'model_context_window = 500000 # sks-codex-context-1m prev=unset\nmodel_auto_compact_token_limit = 900000 # sks-codex-context-1m prev=unset\n';
  const inspection = inspectCodexContext1m(drifted);
  assert.equal(inspection.enabled, false);
  assert.deepEqual(inspection.warnings, ['codex_context_managed_value_drift:model_context_window']);
});

test('action normalization mirrors the fast-mode synonym contract', () => {
  assert.equal(normalizeCodexContext1mAction('on'), 'on');
  assert.equal(normalizeCodexContext1mAction('enable'), 'on');
  assert.equal(normalizeCodexContext1mAction('1m'), 'on');
  assert.equal(normalizeCodexContext1mAction('off'), 'off');
  assert.equal(normalizeCodexContext1mAction('default'), 'off');
  assert.equal(normalizeCodexContext1mAction(undefined), 'status');
  assert.equal(normalizeCodexContext1mAction('--json'), 'status');
});

test('command round-trips a real config file and skips restart when Codex is not running', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-context-1m-home-'));
  try {
    const codexHome = path.join(home, '.codex');
    await fs.mkdir(codexHome, { recursive: true });
    const configPath = path.join(codexHome, 'config.toml');
    await fs.writeFile(configPath, REALISTIC_CONFIG, 'utf8');
    const env = { HOME: home } as NodeJS.ProcessEnv;
    const restartCalls: string[] = [];
    const opts = {
      env,
      home,
      isRunningImpl: async () => false,
      restartImpl: async () => {
        restartCalls.push('restart');
        return { schema: 'sks.codex-app-restart.v1', ok: true, status: 'restarted', app_name: 'ChatGPT', blockers: [] } as any;
      }
    };

    const status = await codexContext1mCommand(['status'], opts);
    assert.equal(status.schema, CODEX_CONTEXT_1M_SCHEMA);
    assert.equal(status.ok, true);
    assert.equal(status.enabled, false);
    assert.equal(status.restart, null);

    const on = await codexContext1mCommand(['on'], opts);
    assert.equal(on.ok, true);
    assert.equal(on.enabled, true);
    assert.equal(on.changed, true);
    assert.equal(on.previous?.model_context_window, 400000);
    assert.equal(on.restart?.attempted, false);
    assert.equal(on.restart?.reason, 'codex_not_running');
    assert.deepEqual(restartCalls, []);
    const written = await fs.readFile(configPath, 'utf8');
    assert.match(written, /^model_context_window = 1000000 # sks-codex-context-1m prev=400000$/m);
    assert.match(written, /^model = "gpt-5\.6-sol"$/m);

    const onAgain = await codexContext1mCommand(['on'], opts);
    assert.equal(onAgain.changed, false);
    assert.equal(onAgain.restart?.reason, 'config_unchanged');

    const off = await codexContext1mCommand(['off'], opts);
    assert.equal(off.ok, true);
    assert.equal(off.enabled, false);
    assert.equal(off.restored?.model_context_window, 400000);
    const restored = await fs.readFile(configPath, 'utf8');
    assert.match(restored, /^model_context_window = 400000$/m);
    assert.doesNotMatch(restored, /sks-codex-context-1m/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('command restarts a running Codex and reports the restart outcome', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-context-1m-restart-'));
  try {
    const codexHome = path.join(home, '.codex');
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n', 'utf8');
    const restartCalls: string[] = [];
    const result = await codexContext1mCommand(['on'], {
      env: { HOME: home } as NodeJS.ProcessEnv,
      home,
      isRunningImpl: async () => true,
      restartImpl: async () => {
        restartCalls.push('restart');
        return { schema: 'sks.codex-app-restart.v1', ok: true, status: 'restarted', app_name: 'ChatGPT', blockers: [] } as any;
      }
    });
    assert.equal(result.ok, true);
    assert.equal(result.restart?.attempted, true);
    assert.equal(result.restart?.status, 'restarted');
    assert.deepEqual(restartCalls, ['restart']);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('command honors SKS_SKIP_CODEX_APP_RESTART and --no-restart without probing the app', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-context-1m-skip-'));
  try {
    const codexHome = path.join(home, '.codex');
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n', 'utf8');
    const probeCalls: string[] = [];
    const probingOpts = (env: NodeJS.ProcessEnv) => ({
      env,
      home,
      isRunningImpl: async () => {
        probeCalls.push('probe');
        return false;
      },
      restartImpl: async () => {
        probeCalls.push('restart');
        return { schema: 'sks.codex-app-restart.v1', ok: true, status: 'restarted', app_name: 'ChatGPT', blockers: [] } as any;
      }
    });
    const skipped = await codexContext1mCommand(['on'], probingOpts({ HOME: home, SKS_SKIP_CODEX_APP_RESTART: '1' } as NodeJS.ProcessEnv));
    assert.equal(skipped.restart?.reason, 'SKS_SKIP_CODEX_APP_RESTART');
    const noRestart = await codexContext1mCommand(['off', '--no-restart'], probingOpts({ HOME: home } as NodeJS.ProcessEnv));
    assert.equal(noRestart.restart?.reason, 'no_restart_flag');
    assert.deepEqual(probeCalls, []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('enable warns when the active model is not the documented 1M model', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-context-1m-model-'));
  try {
    const codexHome = path.join(home, '.codex');
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-luna"\n', 'utf8');
    const result = await codexContext1mCommand(['on'], {
      env: { HOME: home, SKS_SKIP_CODEX_APP_RESTART: '1' } as NodeJS.ProcessEnv,
      home
    });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.includes('codex_context_active_model_not_gpt-5.6-sol:gpt-5.6-luna'));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
