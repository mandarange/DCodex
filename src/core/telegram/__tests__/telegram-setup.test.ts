import { ISOLATED_TEST_HOME } from '../../__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { telegramCommand } from '../../commands/telegram-command.js';
import type { CommandContractV3 } from '../../safety/command-contract/types.js';

const SYNTHETIC_TOKEN = '123456:telegram_test_secret_abcdefghijklmnop';

test('BotFather setup verifies and inspects before an optional lossless webhook removal and token store', async () => {
  const priorExitCode = process.exitCode;
  const priorLog = console.log;
  const logs: string[] = [];
  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
  process.exitCode = undefined;
  try {
    const defaultCalls: string[] = [];
    const defaultResult = await telegramCommand(['setup', '--token-stdin', '--json'], {
      environment: {},
      readTokenStdin: async () => { defaultCalls.push('read'); return SYNTHETIC_TOKEN; },
      verifyToken: async () => { defaultCalls.push('getMe'); },
      inspectWebhook: async () => { defaultCalls.push('getWebhookInfo'); return { url: '' }; },
      preflightTokenStorage: async () => { defaultCalls.push('preflight'); },
      removeWebhook: async () => { defaultCalls.push('deleteWebhook'); },
      storeToken: async () => { defaultCalls.push('store'); }
    }) as {
      ok: boolean;
      webhook_configured_before: boolean;
      webhook_removed: boolean;
      pending_updates_dropped: boolean;
    };
    assert.deepEqual(defaultCalls, ['read', 'getMe', 'getWebhookInfo', 'preflight', 'store']);
    assert.deepEqual({
      ok: defaultResult.ok,
      webhook_configured_before: defaultResult.webhook_configured_before,
      webhook_removed: defaultResult.webhook_removed,
      pending_updates_dropped: defaultResult.pending_updates_dropped
    }, {
      ok: true,
      webhook_configured_before: false,
      webhook_removed: false,
      pending_updates_dropped: false
    });

    const removalCalls: string[] = [];
    const removalResult = await telegramCommand(['setup', '--token-stdin', '--remove-webhook', '--json'], {
      environment: {},
      readTokenStdin: async () => { removalCalls.push('read'); return SYNTHETIC_TOKEN; },
      verifyToken: async () => {
        removalCalls.push('getMe');
        return { id: 202, is_bot: true, first_name: 'Replacement' };
      },
      inspectWebhook: async () => { removalCalls.push('getWebhookInfo'); return { url: 'https://example.test/hook' }; },
      preflightTokenStorage: async () => { removalCalls.push('preflight'); },
      removeWebhook: async () => { removalCalls.push('deleteWebhook'); },
      bindBotIdentity: async () => {
        removalCalls.push('bindBotIdentity');
        return { bot_id: 202, previous_bot_id: 101, rotated: true, state_reset: true };
      },
      storeToken: async () => { removalCalls.push('store'); }
    }) as {
      ok: boolean;
      webhook_configured_before: boolean;
      webhook_removed: boolean;
      pending_updates_dropped: boolean;
      bot_id: number;
      bot_rotated: boolean;
      bot_state_reset: boolean;
    };
    assert.deepEqual(removalCalls, [
      'read', 'getMe', 'getWebhookInfo', 'preflight',
      'deleteWebhook', 'bindBotIdentity', 'store'
    ]);
    assert.equal(removalResult.ok, true);
    assert.equal(removalResult.webhook_configured_before, true);
    assert.equal(removalResult.webhook_removed, true);
    assert.equal(removalResult.pending_updates_dropped, false);
    assert.equal(removalResult.bot_id, 202);
    assert.equal(removalResult.bot_rotated, true);
    assert.equal(removalResult.bot_state_reset, true);
    assert.equal(JSON.stringify({ defaultResult, removalResult, logs }).includes(SYNTHETIC_TOKEN), false);
  } finally {
    console.log = priorLog;
    process.exitCode = priorExitCode;
  }
});

test('setup binds whichever BotFather bot getMe verifies and preserves actionable identity failures', async () => {
  const priorExitCode = process.exitCode;
  const priorLog = console.log;
  const logs: string[] = [];
  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
  process.exitCode = undefined;
  try {
    let boundBotId: number | null = null;
    const selected = await telegramCommand([
      'setup', '--token-stdin', '--expected-bot-username', '@USER_SELECTED_BOT', '--json'
    ], {
      environment: {},
      readTokenStdin: async () => SYNTHETIC_TOKEN,
      verifyToken: async () => ({
        id: 8_765_432_109,
        is_bot: true,
        first_name: 'User Selected Bot',
        username: 'user_selected_bot'
      }),
      inspectWebhook: async () => ({ url: '' }),
      preflightTokenStorage: async () => undefined,
      bindBotIdentity: async (botId) => {
        boundBotId = botId;
        return { bot_id: botId, previous_bot_id: null, rotated: false, state_reset: false };
      },
      storeToken: async () => undefined
    }) as {
      schema: string;
      ok: boolean;
      bot_id: number;
      bot_username: string | null;
      token_stored: boolean;
    };
    assert.equal(selected.schema, 'sks.telegram-setup-command.v1');
    assert.equal(selected.ok, true);
    assert.equal(selected.bot_id, 8_765_432_109);
    assert.equal(selected.bot_username, 'user_selected_bot');
    assert.equal(selected.token_stored, true);
    assert.equal(boundBotId, 8_765_432_109);

    let invalidUsernameReads = 0;
    process.exitCode = undefined;
    const invalidUsername = await telegramCommand([
      'setup', '--token-stdin', '--expected-bot-username', 'bad name', '--json'
    ], {
      environment: {},
      readTokenStdin: async () => { invalidUsernameReads += 1; return SYNTHETIC_TOKEN; }
    }) as { schema: string; ok: boolean; error: string; failure_stage: string; token_stored: boolean };
    assert.deepEqual(invalidUsername, {
      schema: 'sks.telegram-setup-command.v1',
      ok: false,
      error: 'telegram_expected_bot_username_invalid',
      token_stored: false,
      failure_stage: 'getme'
    });
    assert.equal(invalidUsernameReads, 0);

    let mismatchDownstreamCalls = 0;
    process.exitCode = undefined;
    const mismatch = await telegramCommand([
      'setup', '--token-stdin', '--expected-bot-username', 'intended_bot', '--json'
    ], {
      environment: {},
      readTokenStdin: async () => SYNTHETIC_TOKEN,
      verifyToken: async () => ({
        id: 9_999,
        is_bot: true,
        first_name: 'Different Bot',
        username: 'different_bot'
      }),
      inspectWebhook: async () => { mismatchDownstreamCalls += 1; return { url: 'https://example.test/hook' }; },
      preflightTokenStorage: async () => { mismatchDownstreamCalls += 1; },
      removeWebhook: async () => { mismatchDownstreamCalls += 1; },
      bindBotIdentity: async (botId) => {
        mismatchDownstreamCalls += 1;
        return { bot_id: botId, previous_bot_id: null, rotated: false, state_reset: false };
      },
      storeToken: async () => { mismatchDownstreamCalls += 1; }
    }) as {
      schema: string;
      ok: boolean;
      error: string;
      failure_stage: string;
      token_stored: boolean;
      expected_bot_username: string;
      bot_username: string | null;
    };
    assert.deepEqual(mismatch, {
      schema: 'sks.telegram-setup-command.v1',
      ok: false,
      error: 'telegram_bot_username_mismatch',
      failure_stage: 'getme',
      token_stored: false,
      expected_bot_username: 'intended_bot',
      bot_username: 'different_bot'
    });
    assert.equal(mismatchDownstreamCalls, 0);

    process.exitCode = undefined;
    const rejected = await telegramCommand(['setup', '--token-stdin', '--json'], {
      environment: {},
      readTokenStdin: async () => SYNTHETIC_TOKEN,
      verifyToken: async () => { throw new Error('Unauthorized'); }
    }) as {
      schema: string;
      ok: boolean;
      error: string;
      failure_stage: string;
      token_stored: boolean;
    };
    assert.deepEqual(rejected, {
      schema: 'sks.telegram-setup-command.v1',
      ok: false,
      error: 'telegram_token_rejected',
      token_stored: false,
      failure_stage: 'getme'
    });
    assert.equal(process.exitCode, 1);
    assert.equal(JSON.stringify({ selected, invalidUsername, mismatch, rejected, logs }).includes(SYNTHETIC_TOKEN), false);
  } finally {
    console.log = priorLog;
    process.exitCode = priorExitCode;
  }
});

test('setup rejects webhook data loss and redacts failed removal before storing the token', async () => {
  const priorExitCode = process.exitCode;
  const priorLog = console.log;
  const logs: string[] = [];
  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
  process.exitCode = undefined;
  try {
    let touched = 0;
    const dangerous = await telegramCommand([
      'setup', '--token-stdin', '--remove-webhook', '--drop-pending-updates', '--json'
    ], {
      environment: {},
      readTokenStdin: async () => { touched += 1; return SYNTHETIC_TOKEN; },
      verifyToken: async () => { touched += 1; },
      inspectWebhook: async () => { touched += 1; return { url: '' }; },
      removeWebhook: async () => { touched += 1; },
      storeToken: async () => { touched += 1; }
    }) as { ok: boolean; error: string };
    assert.deepEqual(dangerous, {
      schema: 'sks.telegram-setup-command.v1',
      ok: false,
      error: 'telegram_drop_pending_updates_unsupported',
      token_stored: false
    });
    assert.equal(touched, 0);

    let storeCalls = 0;
    const consentRequired = await telegramCommand(['setup', '--token-stdin', '--json'], {
      environment: {},
      readTokenStdin: async () => SYNTHETIC_TOKEN,
      verifyToken: async () => undefined,
      inspectWebhook: async () => ({ url: 'https://example.test/hook' }),
      storeToken: async () => { storeCalls += 1; }
    }) as { ok: boolean; error: string };
    assert.equal(consentRequired.ok, false);
    assert.equal(consentRequired.error, 'telegram_webhook_configured_remove_consent_required');
    assert.equal(storeCalls, 0);

    const failedRemoval = await telegramCommand(['setup', '--token-stdin', '--remove-webhook', '--json'], {
      environment: {},
      readTokenStdin: async () => SYNTHETIC_TOKEN,
      verifyToken: async () => undefined,
      inspectWebhook: async () => ({ url: 'https://example.test/hook' }),
      preflightTokenStorage: async () => undefined,
      removeWebhook: async () => {
        throw new Error(`Conflict at /bot${SYNTHETIC_TOKEN}/deleteWebhook token=${SYNTHETIC_TOKEN}`);
      },
      storeToken: async () => { storeCalls += 1; }
    }) as { ok: boolean; error: string; failure_stage: string };
    assert.equal(failedRemoval.ok, false);
    assert.match(failedRemoval.error, /^telegram_webhook_remove_failed:/);
    assert.equal(failedRemoval.failure_stage, 'webhook');
    assert.equal(storeCalls, 0);
    assert.equal(JSON.stringify({ dangerous, consentRequired, failedRemoval, logs }).includes(SYNTHETIC_TOKEN), false);
  } finally {
    console.log = priorLog;
    process.exitCode = priorExitCode;
  }
});

test('setup returns stable secret-free stages for post-identity failures', async () => {
  const priorExitCode = process.exitCode;
  const priorLog = console.log;
  const logs: string[] = [];
  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
  process.exitCode = undefined;
  try {
    const identity = { id: 77, is_bot: true, first_name: 'Fixture' };
    const webhook = await telegramCommand(['setup', '--token-stdin', '--json'], {
      environment: {},
      readTokenStdin: async () => SYNTHETIC_TOKEN,
      verifyToken: async () => identity,
      inspectWebhook: async () => { throw new Error('fetch failed'); }
    }) as { ok: boolean; error: string; failure_stage: string; token_stored: boolean };
    assert.deepEqual(webhook, {
      schema: 'sks.telegram-setup-command.v1',
      ok: false,
      error: 'telegram_webhook_inspection_network_failed',
      token_stored: false,
      failure_stage: 'webhook'
    });

    let storageDownstreamCalls = 0;
    const storage = await telegramCommand(['setup', '--token-stdin', '--json'], {
      environment: {},
      readTokenStdin: async () => SYNTHETIC_TOKEN,
      verifyToken: async () => identity,
      inspectWebhook: async () => ({ url: '' }),
      preflightTokenStorage: async () => { throw new Error('permission detail'); },
      bindBotIdentity: async () => {
        storageDownstreamCalls += 1;
        return { bot_id: 77, previous_bot_id: null, rotated: true, state_reset: true };
      },
      storeToken: async () => { storageDownstreamCalls += 1; }
    }) as { ok: boolean; error: string; failure_stage: string; token_stored: boolean };
    assert.deepEqual(storage, {
      schema: 'sks.telegram-setup-command.v1',
      ok: false,
      error: 'telegram_token_storage_preflight_failed',
      token_stored: false,
      failure_stage: 'storage'
    });
    assert.equal(storageDownstreamCalls, 0);

    let stateStoreCalls = 0;
    const state = await telegramCommand(['setup', '--token-stdin', '--json'], {
      environment: {},
      readTokenStdin: async () => SYNTHETIC_TOKEN,
      verifyToken: async () => identity,
      inspectWebhook: async () => ({ url: '' }),
      preflightTokenStorage: async () => undefined,
      bindBotIdentity: async () => { throw new Error('state detail'); },
      storeToken: async () => { stateStoreCalls += 1; }
    }) as { ok: boolean; error: string; failure_stage: string; token_stored: boolean };
    assert.deepEqual(state, {
      schema: 'sks.telegram-setup-command.v1',
      ok: false,
      error: 'telegram_bot_state_bind_failed',
      token_stored: false,
      failure_stage: 'state'
    });
    assert.equal(stateStoreCalls, 0);
    assert.equal(JSON.stringify({ webhook, storage, state, logs }).includes(SYNTHETIC_TOKEN), false);
  } finally {
    console.log = priorLog;
    process.exitCode = priorExitCode;
  }
});

test('setup preflights storage before webhook mutation and returns secret-free partial recovery', async () => {
  const priorExitCode = process.exitCode;
  const priorLog = console.log;
  const logs: string[] = [];
  const calls: string[] = [];
  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
  process.exitCode = undefined;
  try {
    const result = await telegramCommand([
      'setup', '--token-stdin', '--expected-bot-username', '@fixture_bot', '--remove-webhook', '--json'
    ], {
      environment: {},
      readTokenStdin: async () => { calls.push('read'); return SYNTHETIC_TOKEN; },
      verifyToken: async () => {
        calls.push('getMe');
        return { id: 77, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' };
      },
      inspectWebhook: async () => {
        calls.push('getWebhookInfo');
        return { url: 'https://example.test/hook' };
      },
      preflightTokenStorage: async () => { calls.push('preflight'); },
      removeWebhook: async () => { calls.push('deleteWebhook'); },
      bindBotIdentity: async () => {
        calls.push('bindBotIdentity');
        return { bot_id: 77, previous_bot_id: 66, rotated: true, state_reset: true };
      },
      storeToken: async () => {
        calls.push('store');
        throw new Error(`disk rejected token=${SYNTHETIC_TOKEN}`);
      }
    }) as {
      schema: string;
      ok: boolean;
      partial_success: boolean;
      error: string;
      detail: string;
      token_stored: boolean;
      token_source: string;
      webhook_removed: boolean;
      pending_updates_dropped: boolean;
      bot_id: number;
      expected_bot_username: string;
      bot_rotated: boolean;
      bot_state_reset: boolean;
      recovery: { action: string; command: string; note: string };
    };

    assert.deepEqual(calls, [
      'read', 'getMe', 'getWebhookInfo', 'preflight',
      'deleteWebhook', 'bindBotIdentity', 'store'
    ]);
    assert.equal(result.schema, 'sks.telegram-setup-command.v1');
    assert.equal(result.ok, false);
    assert.equal(result.partial_success, true);
    assert.equal(result.error, 'telegram_token_store_failed_after_webhook_removed');
    assert.equal(result.token_stored, false);
    assert.equal(result.token_source, 'unchanged');
    assert.equal(result.webhook_removed, true);
    assert.equal(result.pending_updates_dropped, false);
    assert.equal(result.bot_id, 77);
    assert.equal(result.expected_bot_username, 'fixture_bot');
    assert.equal(result.bot_rotated, true);
    assert.equal(result.bot_state_reset, true);
    assert.deepEqual(result.recovery, {
      action: 'rerun_secure_setup',
      command: 'sks telegram setup --token-stdin --expected-bot-username fixture_bot',
      note: 'The token was not printed or stored. Supply it again through non-TTY standard input.'
    });
    assert.equal(process.exitCode, 1);
    assert.equal(JSON.stringify({ result, logs }).includes(SYNTHETIC_TOKEN), false);
    assert.match(result.detail, /\[redacted\]/);
  } finally {
    console.log = priorLog;
    process.exitCode = priorExitCode;
  }
});

test('setup fails closed before stdin when an operator environment token can override the file bot', async () => {
  const priorExitCode = process.exitCode;
  const priorLog = console.log;
  const logs: string[] = [];
  const overrideToken = '987654:operator_override_secret_abcdefghijklmnop';
  let touched = 0;
  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
  process.exitCode = undefined;
  try {
    const dependencies = {
      readTokenStdin: async () => { touched += 1; return SYNTHETIC_TOKEN; },
      verifyToken: async () => { touched += 1; },
      inspectWebhook: async () => { touched += 1; return { url: '' }; },
      preflightTokenStorage: async () => { touched += 1; },
      removeWebhook: async () => { touched += 1; },
      bindBotIdentity: async () => {
        touched += 1;
        return { bot_id: 1, previous_bot_id: null, rotated: true, state_reset: true };
      },
      storeToken: async () => { touched += 1; }
    };
    const primaryEnvironmentResult = await telegramCommand(['setup', '--token-stdin', '--json'], {
      ...dependencies,
      environment: { TELEGRAM_BOT_TOKEN: overrideToken }
    });
    const secondaryEnvironmentResult = await telegramCommand(['setup', '--token-stdin', '--json'], {
      ...dependencies,
      environment: { SKS_TELEGRAM_BOT_TOKEN: overrideToken }
    });
    const nativeFlagResult = await telegramCommand([
      'setup', '--token-stdin', '--operator-env-override-active', '--json'
    ], { ...dependencies, environment: {} });
    const expected = {
      schema: 'sks.telegram-setup-command.v1',
      ok: false,
      partial_success: false,
      error: 'telegram_operator_env_override_active',
      token_source: 'env',
      token_stored: false,
      storage_attempted: false,
      webhook_removed: false,
      pending_updates_dropped: false,
      operator_action: 'Remove the operator-managed Telegram token environment override before storing a file token, or keep managing the bot through that environment source.'
    };
    assert.deepEqual(primaryEnvironmentResult, expected);
    assert.deepEqual(secondaryEnvironmentResult, expected);
    assert.deepEqual(nativeFlagResult, expected);
    assert.equal(touched, 0);
    assert.equal(process.exitCode, 1);
    const publicEvidence = JSON.stringify({ primaryEnvironmentResult, secondaryEnvironmentResult, nativeFlagResult, logs });
    assert.equal(publicEvidence.includes(overrideToken), false);
    assert.equal(publicEvidence.includes(SYNTHETIC_TOKEN), false);
    assert.doesNotMatch(publicEvidence, /TELEGRAM_BOT_TOKEN|SKS_TELEGRAM_BOT_TOKEN/);
  } finally {
    console.log = priorLog;
    process.exitCode = priorExitCode;
  }
});

test('native CLI gateway binds typed commands to the validated project root and ignores JSON cwd injection', async () => {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = [];
  const requestedRoot = '/requested/project';
  const trustedRoot = '/trusted/canonical-project';
  const resolvedRoots: string[] = [];
  const dependency = {
    readCommandStdin: async () => ({ name: 'status', input: { json: true } }),
    resolveProjectRoot: async (root: string) => {
      resolvedRoots.push(root);
      return trustedRoot;
    },
    executionAdapter: {
      executeArgv: async (argv: readonly string[], _contract: CommandContractV3, cwd?: string) => {
        calls.push({ argv: [...argv], cwd });
        return { ok: true };
      }
    }
  };
  const prepared = await telegramCommand([
    'prepare', '--stdin-json', '--json', '--project-root', requestedRoot
  ], dependency) as {
    allowed: boolean; confirmation_required: boolean;
  };
  assert.equal(prepared.allowed, true);
  assert.equal(prepared.confirmation_required, false);
  const executed = await telegramCommand([
    'execute', '--stdin-json', '--json', '--project-root', requestedRoot
  ], dependency) as {
    ok: boolean; output: unknown;
  };
  assert.equal(executed.ok, true);
  assert.deepEqual(resolvedRoots, [requestedRoot, requestedRoot]);
  assert.deepEqual(calls, [{ argv: ['status', '--json'], cwd: trustedRoot }]);

  const injectedRoot = await telegramCommand([
    'prepare', '--stdin-json', '--json', '--project-root', requestedRoot
  ], {
    ...dependency,
    readCommandStdin: async () => ({
      name: 'status', input: { json: true, project_root: '/attacker-controlled' }
    })
  }) as { allowed: boolean; public_error: string | null };
  assert.equal(injectedRoot.allowed, false);
  assert.match(injectedRoot.public_error ?? '', /^telegram_command_input_invalid:/);
  assert.deepEqual(calls, [{ argv: ['status', '--json'], cwd: trustedRoot }]);
});

test('production Telegram adapter spawns allowlisted argv in the validated exact project root', async (t) => {
  const directory = await fs.mkdtemp(path.join(ISOLATED_TEST_HOME, 'telegram-command-cwd-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const trustedRoot = path.join(directory, 'trusted-project');
  const entrypoint = path.join(directory, 'child-entrypoint.cjs');
  await fs.mkdir(trustedRoot, { recursive: true });
  await fs.writeFile(entrypoint, [
    "'use strict';",
    'console.log(JSON.stringify({',
    '  cwd: process.cwd(),',
    '  argv: process.argv.slice(2),',
    '  telegram_token_present: Boolean(process.env.TELEGRAM_BOT_TOKEN || process.env.SKS_TELEGRAM_BOT_TOKEN)',
    '}));'
  ].join('\n'));

  const previousEntrypoint = process.argv[1];
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  process.argv[1] = entrypoint;
  process.exitCode = undefined;
  console.log = () => undefined;
  try {
    const result = await telegramCommand([
      'execute', '--stdin-json', '--json', '--project-root', trustedRoot
    ], {
      readCommandStdin: async () => ({ name: 'status', input: { json: true } }),
      resolveProjectRoot: async (candidate) => {
        assert.equal(candidate, trustedRoot);
        return await fs.realpath(candidate);
      }
    }) as {
      ok: boolean;
      output: { cwd: string; argv: string[]; telegram_token_present: boolean };
    };
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      cwd: await fs.realpath(trustedRoot),
      argv: ['status', '--json'],
      telegram_token_present: false
    });
  } finally {
    if (previousEntrypoint === undefined) delete process.argv[1];
    else process.argv[1] = previousEntrypoint;
    process.exitCode = previousExitCode;
    console.log = previousLog;
  }
});
