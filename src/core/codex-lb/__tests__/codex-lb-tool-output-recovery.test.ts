import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION,
  compareCodexLbVersions,
  probeCodexLbToolOutputRecovery
} from '../codex-lb-tool-output-recovery.js';
import { buildCodexLbSetupPlan } from '../codex-lb-setup.js';
import { codexLbStatus, configureCodexLb } from '../../../cli/install-helpers.js';
import { inspectCodexLbToolOutputRecoveryForLaunch } from '../../preflight/parallel-preflight-engine.js';

test('codex-lb recovery version comparison enforces beta.3 and accepts later stable versions', () => {
  assert.equal(CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION, '1.21.0-beta.3');
  assert.equal(compareCodexLbVersions('1.20.1', CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION) < 0, true);
  assert.equal(compareCodexLbVersions('1.21.0-beta.2', CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION) < 0, true);
  assert.equal(compareCodexLbVersions('v1.21.0-beta.3', CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION), 0);
  assert.equal(compareCodexLbVersions('1.21.0', CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION) > 0, true);
  assert.equal(compareCodexLbVersions('1.22.0', CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION) > 0, true);
});

test('codex-lb recovery probe reads origin health header without a model request', async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requests.push(String(input));
    return new Response('{"status":"ok"}', {
      status: 200,
      headers: { 'x-app-version': '1.21.0-beta.3' }
    });
  };
  const result = await probeCodexLbToolOutputRecovery({
    baseUrl: 'https://lb.fixture.internal/backend-api/codex',
    fetchImpl
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'compatible');
  assert.equal(result.observed_version, '1.21.0-beta.3');
  assert.deepEqual(requests, ['https://lb.fixture.internal/health']);
});

test('old or headerless codex-lb stays blocked unless the operator explicitly acknowledges an override', async () => {
  const oldFetch: typeof fetch = async () => new Response('{}', {
    status: 200,
    headers: { 'x-app-version': '1.20.1' }
  });
  const missingHeaderFetch: typeof fetch = async () => new Response('{}', { status: 200 });
  const old = await probeCodexLbToolOutputRecovery({
    baseUrl: 'https://lb.fixture.internal/backend-api/codex',
    fetchImpl: oldFetch
  });
  assert.equal(old.ok, false);
  assert.equal(old.status, 'version_too_old');
  assert.deepEqual(old.blockers, ['codex_lb_tool_output_recovery_version_too_old']);

  const unknown = await probeCodexLbToolOutputRecovery({
    baseUrl: 'https://lb.fixture.internal/backend-api/codex',
    fetchImpl: missingHeaderFetch
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 'version_unverified');

  const override = await probeCodexLbToolOutputRecovery({
    baseUrl: 'https://lb.fixture.internal/backend-api/codex',
    fetchImpl: oldFetch,
    allowUnverified: true
  });
  assert.equal(override.ok, true);
  assert.equal(override.status, 'override_acknowledged');
  assert.equal(override.override_acknowledged, true);
});

test('codex-lb recovery probe rejects failed health responses even when they advertise a compatible version', async () => {
  for (const status of [404, 503]) {
    const fetchImpl: typeof fetch = async () => new Response('{}', {
      status,
      headers: { 'x-app-version': '1.21.0-beta.3' }
    });
    const result = await probeCodexLbToolOutputRecovery({
      baseUrl: 'https://lb.fixture.internal/backend-api/codex',
      fetchImpl
    });
    assert.equal(result.ok, false, String(status));
    assert.equal(result.status, 'probe_unavailable', String(status));
    assert.equal(result.http_status, status);
    assert.deepEqual(result.blockers, [`codex_lb_tool_output_recovery_health_http_error:${status}`]);
  }
});

test('reserved documentation hosts bypass network only with an explicit hermetic-test option', async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    throw new Error('reserved host should not be fetched');
  };
  const production = await probeCodexLbToolOutputRecovery({
    baseUrl: 'https://lb.example.test/backend-api/codex',
    fetchImpl
  });
  assert.equal(production.ok, false);
  assert.equal(production.status, 'probe_unavailable');
  assert.equal(called, true);

  called = false;
  const testOnly = await probeCodexLbToolOutputRecovery({
    baseUrl: 'https://lb.example.test/backend-api/codex',
    fetchImpl,
    allowReservedTestHostBypass: true
  });
  assert.equal(testOnly.ok, true);
  assert.equal(testOnly.status, 'skipped_reserved_host');
  assert.equal(testOnly.test_bypass, true);
  assert.equal(called, false);
});

test('recovery probe serialization redacts URL userinfo and transport error secrets', async () => {
  const blocked = await probeCodexLbToolOutputRecovery({
    baseUrl: 'https://alice:super-secret@lb.fixture.internal/backend-api/codex?token=short-secret'
  });
  const blockedText = JSON.stringify(blocked);
  assert.equal(blocked.status, 'transport_blocked');
  assert.equal(blocked.base_url, 'https://lb.fixture.internal/backend-api/codex?token=[redacted]');
  assert.doesNotMatch(blockedText, /alice|super-secret|short-secret/);

  const failed = await probeCodexLbToolOutputRecovery({
    baseUrl: 'https://lb.fixture.internal/backend-api/codex',
    fetchImpl: async () => {
      throw new Error('request failed https://bob:transport-secret@lb.fixture.internal/health token=topsecret')
    }
  });
  const failedText = JSON.stringify(failed);
  assert.equal(failed.status, 'probe_unavailable');
  assert.doesNotMatch(failedText, /bob|transport-secret|topsecret/);
  assert.match(String(failed.error || ''), /\[redacted\]/);
});

test('codex-lb setup blocks an old proxy before writing config, auth, or secrets', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-recovery-setup-'));
  const oldFetch: typeof fetch = async () => new Response('{}', {
    status: 200,
    headers: { 'x-app-version': '1.20.1' }
  });
  try {
    const result = await configureCodexLb({
      home,
      host: 'https://lb.fixture.internal/backend-api/codex',
      apiKey: 'sk-clb-never-written',
      processEnv: {},
      toolOutputRecoveryFetch: oldFetch,
      securityBin: '/definitely/not/a/security/bin',
      launchctlBin: '/definitely/not/a/launchctl/bin'
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'tool_output_recovery_blocked');
    assert.equal(result.tool_output_recovery?.observed_version, '1.20.1');
    await assert.rejects(fsp.access(path.join(home, '.codex', 'config.toml')));
    await assert.rejects(fsp.access(path.join(home, '.codex', 'auth.json')));
    await assert.rejects(fsp.access(path.join(home, '.codex', 'sks-codex-lb.env')));
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('codex-lb setup rejects URL credentials and external plaintext HTTP before probe or write', async () => {
  for (const [host, blocker] of [
    ['https://alice:secret@lb.fixture.internal', 'codex_lb_base_url_userinfo_forbidden'],
    ['http://lb.fixture.internal', 'codex_lb_insecure_base_url']
  ] as const) {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-unsafe-url-'));
    let probes = 0;
    try {
      const result = await configureCodexLb({
        home,
        host,
        apiKey: 'sk-clb-never-written',
        toolOutputRecoveryFetch: async () => {
          probes += 1;
          return new Response('{}', { status: 200 });
        }
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'plan_blocked');
      assert.ok(result.drift?.includes(blocker));
      assert.equal(probes, 0);
      await assert.rejects(fsp.access(path.join(home, '.codex', 'config.toml')));
      await assert.rejects(fsp.access(path.join(home, '.codex', 'sks-codex-lb.env')));
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  }
});

test('codex-lb setup plan blocks dual-auth compatibility that would require a global GUI secret', () => {
  const plan = buildCodexLbSetupPlan({
    host_or_base_url: 'https://lb.fixture.internal',
    api_key_source: 'stdin',
    desktop_mode: 'desktop-dual-auth-compat',
    gateway_auth_transport: 'x-codex-lb-api-key',
    write_env_file: true,
    store_keychain: true,
    sync_launchctl: false,
    install_shell_profile: 'skip',
    run_health_check: false,
    allow_insecure_localhost: false
  });

  assert.ok(plan.blockers.includes('desktop_dual_auth_compat_requires_global_secret_environment'));
  assert.equal(
    plan.actions.find((action) => action.type === 'store_keychain')?.target,
    'macOS Keychain service com.sneakoscope.codex-lb.api-key.v2'
  );
});

test('status and launch preflight reject retired compatibility before proxy recovery can authorize launch', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-recovery-status-'));
  const oldFetch: typeof fetch = async () => new Response('{}', {
    status: 200,
    headers: { 'x-app-version': '1.20.1' }
  });
  try {
    await writeSelectedCodexLbFixture(home);
    const options = {
      home,
      processEnv: {},
      securityBin: '/definitely/not/a/security/bin',
      launchctlBin: '/definitely/not/a/launchctl/bin',
      probeToolOutputRecovery: true,
      toolOutputRecoveryFetch: oldFetch
    };
    const status = await codexLbStatus(options);
    assert.equal(status.provider_ready, false);
    assert.equal(status.provider_contract_ok, false);
    assert.equal(status.selected, true);
    assert.equal(status.ok, false);
    assert.ok(status.blockers.includes('desktop_dual_auth_compat_unavailable'));
    assert.equal(status.tool_output_recovery.status, 'not_checked');

    const launch = await inspectCodexLbToolOutputRecoveryForLaunch({
      ...options,
      codexLbToolOutputRecoveryFetch: oldFetch
    });
    assert.equal(launch.ok, false);
    assert.equal(launch.status, 'desktop_dual_auth_compat_unavailable');
    assert.deepEqual(launch.blockers, ['desktop_dual_auth_compat_unavailable']);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

async function writeSelectedCodexLbFixture(home: string) {
  const codexHome = path.join(home, '.codex');
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.writeFile(path.join(codexHome, 'config.toml'), [
    '# sks-codex-lb-managed-desktop-compat',
    'model_provider = "codex-lb"',
    '',
    '[model_providers.codex-lb]',
    'name = "OpenAI"',
    'base_url = "https://lb.fixture.internal/backend-api/codex"',
    'wire_api = "responses"',
    'supports_websockets = true',
    'requires_openai_auth = true',
    'env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }',
    ''
  ].join('\n'));
  await fsp.writeFile(path.join(codexHome, 'sks-codex-lb.env'), [
    'export CODEX_LB_BASE_URL=https://lb.fixture.internal/backend-api/codex',
    'export CODEX_LB_API_KEY=sk-clb-fixture',
    ''
  ].join('\n'), { mode: 0o600 });
  await fsp.writeFile(path.join(codexHome, 'auth.json'), `${JSON.stringify({
    auth_mode: 'chatgpt',
    account_id: 'acct-fixture',
    tokens: {
      access_token: 'oauth-access',
      refresh_token: 'oauth-refresh'
    }
  })}\n`, { mode: 0o600 });
}
