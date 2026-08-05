import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODEX_APP_SERVER_DIRECT_PROVIDER_SELECTION_RETIRED,
  CODEX_APP_SERVER_CONFIG_READ_FAILED,
  CodexAppServerRuntimeEnvError,
  codexAppServerExecutablePath,
  prepareCodexAppServerRuntimeEnv
} from '../codex-app-server-runtime-env.js';

test('App Server runtime PATH keeps node, user tools, and system tools available', () => {
  const runtimePath = codexAppServerExecutablePath({
    nodeBin: '/Users/example/.nvm/versions/node/v24/bin/node',
    home: '/Users/example',
    inheritedPath: '/custom/bin:/usr/bin'
  }).split(':');
  assert.equal(runtimePath[0], '/Users/example/.nvm/versions/node/v24/bin');
  assert.equal(runtimePath[1], '/Users/example/.local/bin');
  assert.ok(runtimePath.includes('/custom/bin'));
  assert.ok(runtimePath.includes('/opt/homebrew/bin'));
  assert.equal(runtimePath.filter((entry) => entry === '/usr/bin').length, 1);
});

test('native provider App Server children do not inherit unrelated codex-lb credentials', async () => {
  const env = await prepareCodexAppServerRuntimeEnv({
    env: {
      HOME: '/Users/example',
      PATH: '/usr/bin:/bin',
      CODEX_LB_API_KEY: 'ambient-secret',
      CODEX_LB_BASE_URL: 'https://ambient.invalid/backend-api/codex'
    },
    configText: 'model_provider = "openai"\n',
    nodeBin: '/opt/node/bin/node'
  });
  assert.equal(env.CODEX_LB_API_KEY, undefined);
  assert.equal(env.CODEX_LB_BASE_URL, undefined);
  assert.match(String(env.PATH), /^\/opt\/node\/bin:/);
});

test('direct provider selections fail before App Server launch and point to Desktop Bridge', async () => {
  for (const provider of ['codex-lb', 'openrouter']) {
    await assert.rejects(
      prepareCodexAppServerRuntimeEnv({
        env: {
          HOME: '/Users/example',
          PATH: '/usr/bin:/bin',
          CODEX_LB_API_KEY: 'ambient-secret'
        },
        configText: `model_provider = "${provider}"\n`
      }),
      (error: unknown) => error instanceof CodexAppServerRuntimeEnvError
        && error.code === CODEX_APP_SERVER_DIRECT_PROVIDER_SELECTION_RETIRED
        && error.message.includes('sks bridge ensure')
        && !error.message.includes('ambient-secret')
    );
  }
});

test('App Server runtime treats only a missing config as empty and surfaces other read failures', async () => {
  const missing = await prepareCodexAppServerRuntimeEnv({
    env: { HOME: '/Users/example', PATH: '/usr/bin:/bin' },
    readConfigTextImpl: async () => {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
  });
  assert.equal(missing.CODEX_LB_API_KEY, undefined);

  await assert.rejects(
    prepareCodexAppServerRuntimeEnv({
      env: { HOME: '/Users/example', PATH: '/usr/bin:/bin' },
      readConfigTextImpl: async () => {
        const error = new Error('/private/config permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
    }),
    (error: unknown) => error instanceof CodexAppServerRuntimeEnvError
      && error.code === CODEX_APP_SERVER_CONFIG_READ_FAILED
      && !error.message.includes('/private/config')
  );
});
