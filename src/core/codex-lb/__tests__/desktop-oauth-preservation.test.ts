import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  configureCodexLb,
  configureCodexLbCliProvider,
  configureCodexLbDesktopRouting
} from '../../../cli/install-helpers.js';
import { CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION } from '../codex-lb-tool-output-recovery.js';
import {
  assertDesktopOAuthSemanticIdentity,
  captureCodexAuthSnapshot
} from '../desktop-auth-invariant.js';

const REMOTE = 'https://lb.example.test/backend-api/codex';
const BRIDGE = 'http://127.0.0.1:47821/backend-api/codex';

async function fixture(t: test.TestContext) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-desktop-oauth-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const authPath = path.join(codexHome, 'auth.json');
  await fsp.mkdir(codexHome, { recursive: true });
  const auth = `${JSON.stringify({
    auth_mode: 'chatgpt',
    account_id: 'acct-stable',
    tokens: {
      access_token: 'access-before',
      refresh_token: 'refresh-before'
    }
  }, null, 2)}\n`;
  await fsp.writeFile(authPath, auth, { mode: 0o600 });
  await fsp.writeFile(configPath, 'service_tier = "fast"\n');
  return { home, configPath, authPath, auth };
}

test('native and disabled Desktop routing preserve auth.json byte for byte', async (t) => {
  const setup = await fixture(t);
  const enabled = await configureCodexLbDesktopRouting({
    mode: 'desktop-native-bridge',
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE,
    gatewayAuthTransport: 'authorization-bearer-compat'
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.identity_plane, 'chatgpt_oauth');
  assert.equal(enabled.routing_plane, 'desktop_native_bridge');
  assert.equal(enabled.gateway_auth_transport, 'authorization-bearer-compat');
  assert.equal(enabled.oauth_preserved, true);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);

  const disabled = await configureCodexLbDesktopRouting({
    mode: 'disabled',
    home: setup.home
  });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.routing_plane, 'disabled');
  assert.equal(disabled.oauth_preserved, true);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
});

test('compat mode preserves OAuth and rejects bearer gateway auth without changing files', async (t) => {
  const setup = await fixture(t);
  const blocked = await configureCodexLbDesktopRouting({
    mode: 'desktop-dual-auth-compat',
    home: setup.home,
    remoteBaseUrl: REMOTE,
    gatewayAuthTransport: 'authorization-bearer-compat'
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'desktop_gateway_auth_transport_unsupported');
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), 'service_tier = "fast"\n');
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);

  const configured = await configureCodexLbDesktopRouting({
    mode: 'desktop-dual-auth-compat',
    home: setup.home,
    remoteBaseUrl: REMOTE,
    gatewayAuthTransport: 'x-codex-lb-api-key'
  });
  assert.equal(configured.ok, true);
  assert.equal(configured.routing_plane, 'desktop_compat_provider');
  assert.equal(configured.oauth_preserved, true);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
});

test('CLI provider stays separate and does not alter Desktop OAuth', async (t) => {
  const setup = await fixture(t);
  const result = await configureCodexLbCliProvider({
    home: setup.home,
    remoteBaseUrl: REMOTE,
    selectGlobally: false
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'cli-provider');
  assert.equal(result.identity_plane, 'unchanged');
  assert.equal(result.oauth_preserved, true);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
  const config = await fsp.readFile(setup.configPath, 'utf8');
  assert.equal(config, [
    'service_tier = "fast"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'));
  assert.doesNotMatch(config, /^model_provider\s*=/m);
  assert.match(config, /^requires_openai_auth\s*=\s*false$/m);
});

test('ordinary credential setup ignores legacy auth-switch flags and does not bind a Desktop catalog', async (t) => {
  const setup = await fixture(t);
  const result = await configureCodexLb({
    home: setup.home,
    host: REMOTE,
    apiKey: 'sk-clb-credential-only',
    useDefaultProvider: true,
    forceCodexLbApiKeyAuth: true,
    authMode: 'codex-lb',
    shellProfile: 'skip',
    syncLaunchctl: false,
    toolOutputRecoveryFetch: async () => new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-app-version': CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION
      }
    })
  });
  assert.equal(result.ok, true);
  assert.equal(result.auth_reconcile?.status, 'oauth_untouched');
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
  const config = await fsp.readFile(setup.configPath, 'utf8');
  assert.doesNotMatch(config, /^model_provider\s*=/m);
  assert.doesNotMatch(config, /^model_catalog_json\s*=/m);
  assert.match(config, /^name\s*=\s*"codex-lb"$/m);
  assert.match(config, /^requires_openai_auth\s*=\s*false$/m);
});

test('semantic OAuth identity allows token rotation but rejects account rotation', async (t) => {
  const setup = await fixture(t);
  const before = await captureCodexAuthSnapshot({ home: setup.home });
  await fsp.writeFile(setup.authPath, `${JSON.stringify({
    auth_mode: 'chatgpt',
    account_id: 'acct-stable',
    tokens: {
      access_token: 'access-after',
      refresh_token: 'refresh-after'
    }
  })}\n`);
  const rotated = await captureCodexAuthSnapshot({ home: setup.home });
  assert.notEqual(before.sha256, rotated.sha256);
  assertDesktopOAuthSemanticIdentity(before, rotated);

  await fsp.writeFile(setup.authPath, `${JSON.stringify({
    auth_mode: 'chatgpt',
    account_id: 'acct-other',
    tokens: {
      access_token: 'access-other',
      refresh_token: 'refresh-other'
    }
  })}\n`);
  const changedAccount = await captureCodexAuthSnapshot({ home: setup.home });
  assert.throws(() => assertDesktopOAuthSemanticIdentity(before, changedAccount), /desktop_oauth_identity_changed/);
});

test('semantic OAuth identity fails closed when opaque tokens expose no stable account claim', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(setup.authPath, `${JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'opaque-access-before',
      refresh_token: 'opaque-refresh-before'
    }
  })}\n`);
  const before = await captureCodexAuthSnapshot({ home: setup.home });
  assert.equal(before.mode, 'chatgpt_oauth');
  assert.equal(before.semantic_fingerprint, null);

  await fsp.writeFile(setup.authPath, `${JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'opaque-access-after',
      refresh_token: 'opaque-refresh-after'
    }
  })}\n`);
  const after = await captureCodexAuthSnapshot({ home: setup.home });
  assert.equal(after.semantic_fingerprint, null);
  assert.throws(
    () => assertDesktopOAuthSemanticIdentity(before, after),
    /desktop_oauth_identity_unverifiable/
  );
});
