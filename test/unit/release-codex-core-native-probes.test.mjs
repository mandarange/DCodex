import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_CURRENT_CORE_NATIVE_EXEC_ARGS,
  nativeCodexCurrentCoreProbeEnv,
  withNativeCodexCurrentCoreExecArgs
} from '../../dist/core/codex-control/codex-current-core-native-exec.js';

test('release-authorizing current-core exec stays on native OpenAI without host loopback config', () => {
  const args = withNativeCodexCurrentCoreExecArgs(['--ephemeral']);
  assert.equal(CODEX_CURRENT_CORE_NATIVE_EXEC_ARGS[0], '--ignore-user-config');
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('model_provider="openai"'));
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes('--ephemeral'));
  const env = nativeCodexCurrentCoreProbeEnv({
    PATH: '/bin',
    OPENAI_BASE_URL: 'http://127.0.0.1:53451/backend-api/codex',
    CODEX_BASE_URL: 'http://127.0.0.1:53451/backend-api/codex'
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.CODEX_BASE_URL, undefined);
});
