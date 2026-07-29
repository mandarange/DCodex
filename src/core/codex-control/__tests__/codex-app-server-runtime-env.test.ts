import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODEX_APP_SERVER_PROVIDER_CREDENTIALS_UNAVAILABLE,
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

test('selected codex-lb App Server child receives only the validated durable credentials', async () => {
  const loaderCalls: Record<string, unknown>[] = [];
  const env = await prepareCodexAppServerRuntimeEnv({
    env: {
      HOME: '/Users/example',
      PATH: '/usr/bin:/bin',
      CODEX_LB_API_KEY: 'stale-secret',
      CODEX_LB_BASE_URL: 'https://stale.invalid/backend-api/codex'
    },
    codexHome: '/Users/example/.codex',
    configText: 'model_provider = "codex-lb"\n',
    nodeBin: '/opt/node/bin/node',
    loadCodexLbEnvImpl: async (options) => {
      loaderCalls.push(options);
      return {
        schema: 'sks.codex-lb-env.v1',
        configured: true,
        missing: [],
        source: 'env-file',
        source_priority: ['env-file', 'keychain', 'process.env'],
        base_url: 'https://validated.example/backend-api/codex',
        api_key: {
          present: true,
          usable: true,
          source: 'env-file',
          redacted: true,
          fingerprint: 'fixture'
        },
        secret_api_key: 'validated-secret',
        credential_binding: {
          checked: true,
          present: true,
          valid: true,
          status: 'matched',
          metadata_path: '/Users/example/.codex/sks-codex-lb.json',
          api_key_matches: true,
          base_url_matches: true,
          blockers: []
        },
        env_paths: [
          '/Users/example/.codex/sks-codex-lb.env'
        ],
        keychain: {
          checked: false,
          available: false,
          status: 'not_checked'
        }
      };
    }
  });
  assert.equal(env.CODEX_LB_API_KEY, 'validated-secret');
  assert.equal(env.CODEX_LB_BASE_URL, 'https://validated.example/backend-api/codex');
  assert.equal(loaderCalls[0]?.envPath, '/Users/example/.codex/sks-codex-lb.env');
  assert.equal(loaderCalls[0]?.metadataPath, '/Users/example/.codex/sks-codex-lb.json');
  assert.deepEqual(loaderCalls[0]?.processEnv, {});
});

test('selected codex-lb fails before App Server launch when durable credentials are unavailable', async () => {
  await assert.rejects(
    prepareCodexAppServerRuntimeEnv({
      env: { HOME: '/Users/example', PATH: '/usr/bin:/bin' },
      configText: 'model_provider = "codex-lb"\n',
      loadCodexLbEnvImpl: async () => ({
        schema: 'sks.codex-lb-env.v1',
        configured: false,
        missing: ['CODEX_LB_API_KEY'],
        source: 'missing',
        source_priority: ['env-file', 'keychain', 'process.env'],
        base_url: null,
        api_key: {
          present: false,
          usable: false,
          source: null,
          redacted: true,
          fingerprint: null
        },
        secret_api_key: null,
        credential_binding: {
          checked: false,
          present: false,
          valid: false,
          status: 'missing',
          metadata_path: '/Users/example/.codex/sks-codex-lb.json',
          api_key_matches: null,
          base_url_matches: null,
          blockers: []
        },
        env_paths: [],
        keychain: {
          checked: false,
          available: false,
          status: 'not_checked'
        }
      })
    }),
    (error: unknown) => error instanceof CodexAppServerRuntimeEnvError
      && error.code === CODEX_APP_SERVER_PROVIDER_CREDENTIALS_UNAVAILABLE
  );
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
