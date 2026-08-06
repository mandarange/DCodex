import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeBridgeCommand,
  loadBridgeCommandFacade,
  type BridgeCommandFacade,
  type BridgeCommandIo,
  type BridgeCommandRequest
} from '../bridge.js';

test('bridge command default facade exports the current controller entrypoint', async () => {
  const facade = await loadBridgeCommandFacade();
  assert.equal(typeof facade.execute, 'function');
});

function fixture(
  response: unknown = { schema: 'sks.bridge-operation.v1', ok: true }
): {
  facade: BridgeCommandFacade;
  io: BridgeCommandIo;
  requests: BridgeCommandRequest[];
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  setStdin(value: string): void;
} {
  const requests: BridgeCommandRequest[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  let stdin = '';
  return {
    facade: {
      execute: async (request) => {
        requests.push(request);
        return typeof response === 'function'
          ? (response as (request: BridgeCommandRequest) => unknown)(request)
          : response;
      }
    },
    io: {
      readStdin: async () => stdin,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      setExitCode: (code) => exitCodes.push(code)
    },
    requests,
    stdout,
    stderr,
    exitCodes,
    setStdin: (value) => { stdin = value; }
  };
}

test('bridge command maps the complete non-secret CLI surface to one controller facade', async () => {
  const cases: Array<[string[], BridgeCommandRequest]> = [
    [['status'], { operation: 'status' }],
    [['ensure'], { operation: 'ensure' }],
    [['repair'], { operation: 'repair' }],
    [['provider', 'list'], { operation: 'provider.list' }],
    [['provider', 'validate', 'codex-lb'], { operation: 'provider.validate', provider_id: 'codex-lb' }],
    [['provider', 'enable', 'openrouter'], { operation: 'provider.enable', provider_id: 'openrouter' }],
    [['provider', 'disable', 'codex-lb'], { operation: 'provider.disable', provider_id: 'codex-lb' }],
    [['provider', 'remove-credential', 'codex-lb', '--confirm'], { operation: 'provider.remove-credential', provider_id: 'codex-lb', confirmed: true }],
    [['catalog', 'sync'], { operation: 'catalog.sync' }],
    [['catalog', 'status'], { operation: 'catalog.status' }],
    [['route', 'list'], { operation: 'route.list' }],
    [['route', 'set-default', 'openrouter'], { operation: 'route.set-default', provider_id: 'openrouter' }],
    [['route', 'explain', 'public-model'], { operation: 'route.explain', model: 'public-model' }],
    [['unmanage', '--confirm'], { operation: 'unmanage', confirmed: true }],
    [['rollback', 'receipt-123', '--confirm'], { operation: 'rollback', receipt_id: 'receipt-123', confirmed: true }]
  ];

  for (const [args, expected] of cases) {
    const setup = fixture();
    const result = await executeBridgeCommand(args, setup);
    assert.equal(result.exit_code, 0, args.join(' '));
    assert.deepEqual(setup.requests, [expected], args.join(' '));
    assert.equal(result.output.execution_ok, true, args.join(' '));
  }
});

test('hidden serve entry validates its settings path and bypasses the management facade', async () => {
  const setup = fixture();
  const settingsPath = '/tmp/desktop-bridge-settings.json';
  const calls: string[] = [];
  const result = await executeBridgeCommand([
    'serve', '--settings', settingsPath, '--json'
  ], {
    ...setup,
    serve: async (options) => {
      calls.push(String(options?.settingsPath));
      return {
        schema: 'sks.desktop-bridge-serve.v1',
        ok: true,
        status: 'stopped',
        state: null
      };
    }
  });
  assert.equal(result.exit_code, 0);
  assert.deepEqual(calls, [settingsPath]);
  assert.deepEqual(setup.requests, []);

  const relative = await executeBridgeCommand([
    'serve', '--settings', 'desktop-bridge-settings.json', '--json'
  ], setup);
  assert.equal(relative.exit_code, 1);
  assert.deepEqual(relative.output.blockers, ['desktop_bridge_settings_path_must_be_absolute']);
});

test('provider configuration accepts a secret only through stdin and redacts reflected values', async () => {
  const secret = 'sk-clb-super-secret-fixture-value';
  const setup = fixture({
    schema: 'sks.bridge-provider-configuration.v1',
    ok: true,
    provider_id: 'codex-lb',
    credential: { state: 'ready', fingerprint: 'sha256:fixture' },
    accidental_reflection: secret,
    api_key: secret
  });
  setup.setStdin(`${secret}\n`);

  const result = await executeBridgeCommand([
    'provider', 'configure', 'codex-lb', '--host', 'lb.example.test', '--api-key-stdin', '--json'
  ], setup);

  assert.equal(result.exit_code, 0);
  assert.deepEqual(setup.requests, [{
    operation: 'provider.configure',
    provider_id: 'codex-lb',
    api_key: secret,
    host: 'lb.example.test'
  }]);
  assert.equal((result.output.credential as Record<string, unknown>).state, 'ready');
  assert.doesNotMatch(JSON.stringify(result.output), new RegExp(secret));
  assert.equal(result.output.api_key, '[redacted]');
});

test('secret argv, missing stdin mode, destructive actions without confirmation, and invalid providers fail before core', async () => {
  const cases = [
    [['provider', 'configure', 'openrouter', '--api-key', 'secret'], 'bridge_secret_argv_forbidden'],
    [['provider', 'configure', 'openrouter'], 'bridge_provider_api_key_stdin_required'],
    [['provider', 'remove-credential', 'codex-lb'], 'bridge_explicit_confirmation_required'],
    [['unmanage'], 'bridge_explicit_confirmation_required'],
    [['rollback', 'receipt-1'], 'bridge_explicit_confirmation_required'],
    [['provider', 'enable', 'unknown'], 'bridge_provider_must_be_codex_lb_or_openrouter']
  ] as const;
  for (const [args, blocker] of cases) {
    const setup = fixture();
    const result = await executeBridgeCommand([...args, '--json'], setup);
    assert.equal(result.exit_code, 1, args.join(' '));
    assert.deepEqual(result.output.blockers, [blocker], args.join(' '));
    assert.deepEqual(setup.requests, [], args.join(' '));
  }
});

test('verify separates report execution from readiness and strict exit semantics', async () => {
  const report = capabilityReport({ transport: false, deep: false, full: false });
  const nonStrict = fixture(report);
  const ordinary = await executeBridgeCommand(['verify', '--level', 'transport', '--json'], nonStrict);
  assert.equal(ordinary.output.execution_ok, true);
  assert.equal(ordinary.output.report_generated, true);
  assert.equal(ordinary.output.requested_level, 'transport');
  assert.equal(ordinary.output.level_satisfied, false);
  assert.equal(ordinary.output.full_feature_verified, false);
  assert.equal(ordinary.output.ok, true);
  assert.equal(ordinary.exit_code, 0);

  const strict = fixture(report);
  const required = await executeBridgeCommand([
    'verify', '--level', 'transport', '--require-ready', '--json'
  ], strict);
  assert.equal(required.output.execution_ok, true);
  assert.equal(required.output.level_satisfied, false);
  assert.equal(required.output.ok, false);
  assert.equal(required.exit_code, 1);
});

test('verify treats malformed v3 catalog truth as operation failure', async () => {
  const setup = fixture({ ...capabilityReport({ transport: true, deep: false, full: false }), catalog_sync: undefined });
  const result = await executeBridgeCommand(['verify', '--level', 'transport', '--json'], setup);
  assert.equal(result.output.execution_ok, false);
  assert.deepEqual(result.output.blockers, ['capability_schema_invalid']);
  assert.equal(result.exit_code, 1);
});

function capabilityReport(options: { transport: boolean; deep: boolean; full: boolean }) {
  const scope = (name: string, state = 'verified') => ({
    schema: 'sks.scope-capability-summary.v1',
    scope: name,
    state,
    checked_at: '2026-08-05T00:00:00.000Z',
    capabilities: {},
    blockers: [],
    warnings: []
  });
  const catalog = {
    schema: 'sks.catalog-sync-state.v2',
    provider_id: 'codex-lb',
    state: 'verified',
    source: 'gateway',
    generation: 'generation',
    digest: 'digest',
    model_count: 1,
    checked_at: '2026-08-05T00:00:00.000Z',
    expires_at: null,
    blockers: [],
    warnings: [],
    recovery_action: null
  };
  return {
    schema: 'sks.desktop-capabilities.v3',
    report_id: 'report-1',
    correlation_id: 'correlation-1',
    session_id: 'session-1',
    requested_level: 'transport',
    checked_at: '2026-08-05T00:00:00.000Z',
    catalog_generation: 'generation',
    execution: { ok: true, status: 'completed', blockers: [] },
    bridge: scope('bridge'),
    native_identity: scope('native-identity'),
    providers: {
      'codex-lb': scope('provider:codex-lb'),
      openrouter: scope('provider:openrouter', 'not_attempted')
    },
    combined_catalog: scope('catalog:combined'),
    summary: {
      bridge_ready: true,
      active_routes_ready: true,
      level_satisfied: options.transport,
      transport_level_satisfied: options.transport,
      deep_level_satisfied: options.deep,
      full_feature_verified: options.full,
      inactive_provider_failures: [],
      blockers: [],
      warnings: []
    },
    catalog_sync: {
      schema: 'sks.combined-catalog-sync.v1',
      state: 'verified',
      generation: 'generation',
      digest: 'digest',
      model_count: 1,
      route_count: 1,
      conflict_count: 0,
      checked_at: '2026-08-05T00:00:00.000Z',
      providers: { 'codex-lb': catalog, openrouter: { ...catalog, provider_id: 'openrouter', source: 'openrouter' } },
      blockers: [],
      warnings: [],
      recovery_action: null
    }
  };
}
