import '../../__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  desktopBridgeDiagnosticBindingCurrentV3,
  desktopBridgeReportReadinessV3,
  desktopBridgeStatusV3,
  executeDesktopBridgeCommandV3,
  runDesktopBridgeDeepProviderProbesV3,
  verifyDesktopBridgeV3
} from '../desktop-controller-v3.js';
import {
  capabilityDeepEvidenceContentSha256V2,
  type CapabilityTrustedDeepEvidenceEnvelopeV2
} from '../trusted-deep-evidence.js';
import { sha256 } from '../../fsx.js';
import {
  assertDesktopBridgeStatusV3,
  validateDesktopBridgeStatusV3,
  validateDesktopCapabilityReportV3
} from '../bridge-runtime-validation.js';
import { applyOfficialModelPassthrough } from '../provider-route-policy.js';
import {
  DESKTOP_BRIDGE_SERVICE_SCHEMA,
  defaultDesktopBridgeServiceSettings,
  desktopBridgeServicePaths,
  type DesktopBridgeServiceStatus
} from '../desktop-service.js';
import { activeProviderIds } from '../desktop-controller-v3/shared.js';
import {
  desktopBridgeServiceCommandOutcome,
  unmanageDesktopBridge
} from '../desktop-controller-v3/lifecycle-commands.js';

async function fixture(t: test.TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-desktop-controller-v3-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  const env = {
    HOME: home,
    SKS_HOME: path.join(home, '.sneakoscope'),
    CODEX_LB_API_KEY: '',
    CODEX_LB_BASE_URL: '',
    OPENROUTER_API_KEY: '',
    SKS_OPENROUTER_API_KEY: ''
  } as NodeJS.ProcessEnv;
  return { home, env };
}

function stoppedService(home: string): DesktopBridgeServiceStatus {
  return {
    schema: DESKTOP_BRIDGE_SERVICE_SCHEMA,
    ok: false,
    supported: true,
    installed: false,
    loaded: false,
    running: false,
    status: 'missing',
    service: 'gui/501/com.sneakoscope.desktop-bridge',
    paths: desktopBridgeServicePaths(home),
    state: null,
    settings: null,
    expected_config_generation: null,
    credential_source: null,
    blockers: ['desktop_bridge_state_missing']
  };
}

function lifecycleService(
  home: string,
  state: { installed: boolean; running: boolean; settingsPresent: boolean }
): DesktopBridgeServiceStatus {
  return {
    ...stoppedService(home),
    ok: state.running,
    installed: state.installed,
    loaded: state.running,
    running: state.running,
    status: state.running ? 'running' : 'missing',
    settings: state.settingsPresent ? defaultDesktopBridgeServiceSettings() : null,
    blockers: []
  };
}

function managedDesktopConfig(home: string): string {
  return [
    '# sks-desktop-bridge-managed',
    'model_provider = "openai"',
    '# sks-desktop-bridge-managed-base-url',
    'openai_base_url = "http://127.0.0.1:49152/backend-api/codex"',
    '# sks-desktop-bridge-managed-model-catalog',
    `model_catalog_json = "${path.join(home, '.codex', 'sks-bridge-catalog.json')}"`,
    ''
  ].join('\n');
}

async function lifecycleArtifacts(home: string) {
  const servicePaths = desktopBridgeServicePaths(home);
  const configPath = path.join(home, '.codex', 'config.toml');
  await fs.mkdir(path.dirname(servicePaths.settings_path), { recursive: true });
  await fs.mkdir(path.dirname(servicePaths.launch_agent_path), { recursive: true });
  await fs.writeFile(configPath, managedDesktopConfig(home));
  await fs.writeFile(servicePaths.settings_path, '{}\n');
  await fs.writeFile(servicePaths.launch_agent_path, '<plist/>\n');
  return { configPath, servicePaths };
}

test('two ready explicitly routed providers stay active regardless of the UI default', () => {
  const policy = {
    schema: 'sks.bridge-routing-policy.v1',
    default_provider_id: null,
    fallback: 'none',
    model_routes: {
      'lb-model': { provider_id: 'codex-lb', upstream_model: 'lb-model' },
      'or-model': { provider_id: 'openrouter', upstream_model: 'or-model' }
    },
    catalog_generation: 'catalog-both-ready',
    policy_generation: 'policy-both-ready',
    changed_at: '2026-08-05T00:00:00.000Z'
  } as const;
  const readyProfile = { enabled: true, state: 'ready' } as const;
  const core = {
    policy,
    registry: {
      profiles: {
        'codex-lb': readyProfile,
        openrouter: readyProfile
      }
    }
  };

  assert.deepEqual(activeProviderIds(core as never), ['codex-lb', 'openrouter']);
  assert.deepEqual(activeProviderIds({
    ...core,
    policy: { ...policy, default_provider_id: 'openrouter' }
  } as never), ['codex-lb', 'openrouter']);
});

test('status is a strict, secret-free observation and never starts network probes', async (t) => {
  const setup = await fixture(t);
  let fetchCalls = 0;
  const status = await desktopBridgeStatusV3({
    home: setup.home,
    env: setup.env,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('status_must_not_fetch');
    },
    serviceStatusImpl: async () => stoppedService(setup.home),
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    id: () => 'fixture'
  });

  assert.equal(fetchCalls, 0);
  assert.equal(status.schema, 'sks.desktop-bridge-status.v3');
  assert.equal(status.http_probe, null);
  assert.equal(status.websocket_probe, null);
  assert.equal(status.native_identity.semantic_identity_preserved, null);
  assert.equal(status.readiness.ready, false);
  assert.equal(status.readiness.state, 'unmanaged');
  assert.equal(status.providers['codex-lb'].credential.state, 'not_configured');
  assert.equal(status.providers.openrouter.credential.state, 'not_configured');
  assert.deepEqual(status.recovery_actions.slice(0, 2), [
    'configure_codex_lb_credential',
    'configure_openrouter_credential'
  ]);
  assert.equal(validateDesktopBridgeStatusV3(status).ok, true);
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /"(?:api_key|secret|token|authorization|cookie)"\s*:/i);
  assert.doesNotMatch(serialized, /or-ambient-key|lb-secret-/i);
});

test('status v3 accepts official passthrough routes such as gpt-5.6-luna -> openai', async (t) => {
  const setup = await fixture(t);
  const status = await desktopBridgeStatusV3({
    home: setup.home,
    env: setup.env,
    serviceStatusImpl: async () => stoppedService(setup.home),
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    id: () => 'official-route-status'
  });
  const flipped = applyOfficialModelPassthrough({
    schema: 'sks.bridge-routing-policy.v1',
    default_provider_id: 'codex-lb',
    fallback: 'none',
    model_routes: {
      'gpt-5.6-luna': { provider_id: 'codex-lb', upstream_model: 'gpt-5.6-luna' },
      'gpt-5.6-sol': { provider_id: 'codex-lb', upstream_model: 'gpt-5.6-sol' },
      'anthropic/claude-sonnet-4.5': { provider_id: 'openrouter', upstream_model: 'anthropic/claude-sonnet-4.5' }
    },
    catalog_generation: 'catalog-official-status',
    policy_generation: 'policy-official-status',
    changed_at: '2026-08-05T00:00:00.000Z'
  }, { mode: 'passthrough', changedAt: '2026-08-05T00:00:00.000Z' });
  const withOfficial = {
    ...status,
    routing: {
      ...status.routing,
      policy: flipped,
      selected_model: 'gpt-5.6-luna',
      selected_route: flipped.model_routes['gpt-5.6-luna']
    }
  };
  const validation = validateDesktopBridgeStatusV3(withOfficial);
  assert.equal(validation.ok, true, validation.issues.join(','));
  assert.doesNotMatch(validation.issues.join(','), /gpt-5\.6-luna.*provider_id:enum/);
  assertDesktopBridgeStatusV3(withOfficial);
});

test('dormant settings alone do not claim live Desktop Bridge ownership', async (t) => {
  const setup = await fixture(t);
  const status = await desktopBridgeStatusV3({
    home: setup.home,
    env: setup.env,
    serviceStatusImpl: async () => lifecycleService(setup.home, {
      installed: false,
      running: false,
      settingsPresent: true
    }),
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    id: () => 'dormant-settings'
  });

  assert.equal(status.management.managed, false);
  assert.equal(status.management.reason, 'never_configured');
  assert.equal(status.readiness.state, 'unmanaged');
});

test('unmanage preserves service artifacts and restarts the prior running service on guarded-write conflict', async (t) => {
  const setup = await fixture(t);
  const artifacts = await lifecycleArtifacts(setup.home);
  const events: string[] = [];
  const state = { installed: true, running: true, settingsPresent: true };
  const result = await executeDesktopBridgeCommandV3({ operation: 'unmanage', confirmed: true }, {
    home: setup.home,
    env: setup.env,
    serviceStatusImpl: async () => lifecycleService(setup.home, state),
    stopServiceImpl: async (input) => {
      assert.equal(input?.removePlist, undefined);
      assert.equal(input?.removeSettings, undefined);
      events.push('stop:preserve');
      state.running = false;
      return lifecycleService(setup.home, state);
    },
    safeWriteConfigImpl: async (configPath, _current, _next, _tag, writeOptions) => {
      events.push('config:conflict');
      assert.equal(configPath, artifacts.configPath);
      assert.equal(writeOptions?.verifyUnchangedBeforeWrite, true);
      return {
        ok: false,
        status: 'concurrent_change_detected',
        config_path: configPath,
        backup_path: null,
        changed: false
      };
    },
    bootstrapServiceImpl: async () => {
      events.push('service:restart');
      state.running = true;
      return lifecycleService(setup.home, state);
    }
  });

  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(result.execution.ok, false);
  assert.deepEqual(result.execution.blockers, ['desktop_bridge_unmanage_config_concurrent_change_detected']);
  assert.deepEqual(events, ['stop:preserve', 'config:conflict', 'service:restart']);
  assert.equal(state.running, true);
  assert.equal(await fs.readFile(artifacts.configPath, 'utf8'), managedDesktopConfig(setup.home));
  await fs.access(artifacts.servicePaths.settings_path);
  await fs.access(artifacts.servicePaths.launch_agent_path);
});

test('unmanage removes plist/settings only after a successful guarded config write', async (t) => {
  const setup = await fixture(t);
  const artifacts = await lifecycleArtifacts(setup.home);
  const events: string[] = [];
  const state = { installed: true, running: true, settingsPresent: true };
  const result = await executeDesktopBridgeCommandV3({ operation: 'unmanage', confirmed: true }, {
    home: setup.home,
    env: setup.env,
    serviceStatusImpl: async () => lifecycleService(setup.home, state),
    stopServiceImpl: async (input) => {
      if (!input?.removePlist && !input?.removeSettings) {
        events.push('stop:preserve');
        state.running = false;
        return lifecycleService(setup.home, state);
      }
      events.push('service:cleanup');
      assert.equal(input?.removePlist, true);
      assert.equal(input?.removeSettings, true);
      await fs.unlink(artifacts.servicePaths.launch_agent_path);
      await fs.unlink(artifacts.servicePaths.settings_path);
      state.installed = false;
      state.settingsPresent = false;
      return lifecycleService(setup.home, state);
    },
    safeWriteConfigImpl: async (configPath, _current, next, _tag, writeOptions) => {
      events.push('config:write');
      assert.equal(writeOptions?.verifyUnchangedBeforeWrite, true);
      await fs.writeFile(configPath, next);
      return {
        ok: true,
        status: 'written',
        config_path: configPath,
        backup_path: null,
        changed: true
      };
    },
    bootstrapServiceImpl: async () => {
      throw new Error('successful_unmanage_must_not_restart');
    }
  });

  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(result.execution.ok, true);
  assert.equal(result.status?.management.managed, false);
  assert.deepEqual(events, ['stop:preserve', 'config:write', 'service:cleanup']);
  await assert.rejects(fs.access(artifacts.servicePaths.settings_path));
  await assert.rejects(fs.access(artifacts.servicePaths.launch_agent_path));
  assert.doesNotMatch(await fs.readFile(artifacts.configPath, 'utf8'), /sks-desktop-bridge-managed/);
});

test('rollback preserves service artifacts and restarts the prior running service when receipt rollback fails', async (t) => {
  const setup = await fixture(t);
  const artifacts = await lifecycleArtifacts(setup.home);
  const events: string[] = [];
  const state = { installed: true, running: true, settingsPresent: true };
  const result = await executeDesktopBridgeCommandV3({ operation: 'rollback', receipt_id: 'receipt-failure', confirmed: true }, {
    home: setup.home,
    env: setup.env,
    serviceStatusImpl: async () => lifecycleService(setup.home, state),
    stopServiceImpl: async (input) => {
      assert.equal(input?.removePlist, undefined);
      assert.equal(input?.removeSettings, undefined);
      events.push('stop:preserve');
      state.running = false;
      return lifecycleService(setup.home, state);
    },
    rollbackReceiptImpl: async () => {
      events.push('receipt:rollback-failed');
      return {
        schema: 'sks.desktop-bridge-unification-rollback.v1',
        ok: false,
        status: 'rollback_conflict',
        receipt_id: 'receipt-failure',
        restored_files: [],
        credentials_overwritten: false,
        auth_overwritten: false,
        conflicts: [{
          path: artifacts.configPath,
          expected_after_sha256: 'expected',
          current_sha256: 'changed',
          reason: 'current_file_changed_after_migration'
        }]
      };
    },
    bootstrapServiceImpl: async () => {
      events.push('service:restart');
      state.running = true;
      return lifecycleService(setup.home, state);
    }
  });

  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(result.execution.ok, false);
  assert.deepEqual(result.execution.blockers, ['rollback_conflict']);
  assert.deepEqual(events, ['stop:preserve', 'receipt:rollback-failed', 'service:restart']);
  assert.equal(state.running, true);
  await fs.access(artifacts.servicePaths.settings_path);
  await fs.access(artifacts.servicePaths.launch_agent_path);
});

test('successful rollback cleans service artifacts after receipt restoration and reports rollback_complete', async (t) => {
  const setup = await fixture(t);
  const artifacts = await lifecycleArtifacts(setup.home);
  const events: string[] = [];
  const state = { installed: true, running: true, settingsPresent: true };
  const result = await executeDesktopBridgeCommandV3({ operation: 'rollback', receipt_id: 'receipt-success', confirmed: true }, {
    home: setup.home,
    env: setup.env,
    serviceStatusImpl: async () => lifecycleService(setup.home, state),
    stopServiceImpl: async (input) => {
      if (!input?.removePlist && !input?.removeSettings) {
        events.push('stop:preserve');
        state.running = false;
        return lifecycleService(setup.home, state);
      }
      events.push('service:cleanup');
      await fs.unlink(artifacts.servicePaths.launch_agent_path);
      await fs.unlink(artifacts.servicePaths.settings_path);
      state.installed = false;
      state.settingsPresent = false;
      return lifecycleService(setup.home, state);
    },
    rollbackReceiptImpl: async () => {
      events.push('receipt:rollback');
      await fs.writeFile(artifacts.configPath, 'service_tier = "fast"\n');
      return {
        schema: 'sks.desktop-bridge-unification-rollback.v1',
        ok: true,
        status: 'rolled_back',
        receipt_id: 'receipt-success',
        restored_files: [artifacts.configPath],
        credentials_overwritten: false,
        auth_overwritten: false,
        conflicts: []
      };
    },
    bootstrapServiceImpl: async () => {
      throw new Error('successful_rollback_must_not_restart');
    }
  });

  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(result.execution.ok, true);
  assert.equal(result.status?.management.managed, false);
  assert.equal(result.status?.management.reason, 'rollback_complete');
  assert.equal(result.status?.readiness.state, 'unmanaged');
  assert.deepEqual(events, ['stop:preserve', 'receipt:rollback', 'service:cleanup']);
  await assert.rejects(fs.access(artifacts.servicePaths.settings_path));
  await assert.rejects(fs.access(artifacts.servicePaths.launch_agent_path));
});

test('lifecycle recovery failure preserves the original transaction error as the command blocker', async (t) => {
  const setup = await fixture(t);
  await lifecycleArtifacts(setup.home);
  const state = { installed: true, running: true, settingsPresent: true };
  await assert.rejects(
    unmanageDesktopBridge({
      home: setup.home,
      env: setup.env,
      serviceStatusImpl: async () => lifecycleService(setup.home, state),
      stopServiceImpl: async () => {
        state.running = false;
        return lifecycleService(setup.home, state);
      },
      safeWriteConfigImpl: async (configPath) => ({
        ok: false,
        status: 'concurrent_change_detected',
        config_path: configPath,
        backup_path: null,
        changed: false
      }),
      bootstrapServiceImpl: async () => {
        throw new Error('desktop_bridge_recovery_launch_failed');
      }
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.message, 'desktop_bridge_unmanage_config_concurrent_change_detected');
      assert.equal(error instanceof Error && error.cause instanceof Error && error.cause.message, 'desktop_bridge_recovery_launch_failed');
      return true;
    }
  );
});

test('R04/R05: OAuth-only ensure stays honest, gives setup guidance, and never auto-prompts or installs', async (t) => {
  const setup = await fixture(t);
  await fs.writeFile(path.join(setup.home, '.codex', 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    account_id: 'account-fixture',
    tokens: { access_token: 'oauth-fixture-access' }
  }), { mode: 0o600 });
  let fetchCalls = 0;
  let installCalls = 0;
  const result = await executeDesktopBridgeCommandV3({ operation: 'ensure' }, {
    home: setup.home,
    env: setup.env,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('oauth_only_ensure_must_not_fetch');
    },
    installServiceImpl: async () => {
      installCalls += 1;
      throw new Error('oauth_only_ensure_must_not_install');
    },
    serviceStatusImpl: async () => stoppedService(setup.home),
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    id: () => 'oauth-only'
  });

  assert.equal(fetchCalls, 0);
  assert.equal(installCalls, 0);
  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.status, 'partial');
  assert.equal(result.readiness.ready, false);
  assert.equal(result.status?.readiness.state, 'unmanaged');
  assert.equal(result.status?.native_identity.configured, true);
  assert.equal(result.status?.providers['codex-lb'].credential.state, 'not_configured');
  assert.equal(result.status?.providers.openrouter.credential.state, 'not_configured');
  assert.deepEqual(result.status?.recovery_actions.slice(0, 2), [
    'configure_codex_lb_credential',
    'configure_openrouter_credential'
  ]);
});

test('R24/R37: status readiness requires active-route transport truth, not bridge process/config alone', async (t) => {
  const setup = await fixture(t);
  const report = await verifyDesktopBridgeV3('shallow', {
    home: setup.home,
    env: setup.env,
    serviceStatusImpl: async () => stoppedService(setup.home),
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    id: () => 'fixture'
  });

  assert.equal(report.schema, 'sks.desktop-capabilities.v3');
  assert.equal(report.requested_level, 'shallow');
  assert.equal(report.catalog_sync.schema, 'sks.combined-catalog-sync.v1');
  assert.equal(validateDesktopCapabilityReportV3(report).ok, true);
  for (const scope of [report.bridge, report.native_identity, report.providers['codex-lb'], report.providers.openrouter, report.combined_catalog]) {
    for (const probe of Object.values(scope.capabilities)) {
      assert.equal(probe.report_id, report.report_id);
      assert.equal(probe.correlation_id, report.correlation_id);
      assert.equal(probe.session_id, report.session_id);
    }
  }

  const missingCatalog = { ...report } as Record<string, unknown>;
  delete missingCatalog.catalog_sync;
  assert.equal(validateDesktopCapabilityReportV3(missingCatalog).ok, false);
  const stale = structuredClone(report);
  stale.bridge.capabilities.runtime!.correlation_id = 'stale-correlation';
  assert.equal(validateDesktopCapabilityReportV3(stale).ok, false);

  const providerFailed = structuredClone(report);
  providerFailed.requested_level = 'transport';
  providerFailed.summary.bridge_ready = true;
  providerFailed.summary.active_routes_ready = false;
  providerFailed.summary.transport_level_satisfied = true;
  assert.deepEqual(desktopBridgeReportReadinessV3(providerFailed), {
    bridge_ready: true,
    active_routes_ready: false
  });
});

test('R37/R50: persisted diagnostics are bound to the current process generation and verified probe ID', async (t) => {
  const setup = await fixture(t);
  const report = await verifyDesktopBridgeV3('shallow', {
    home: setup.home,
    env: setup.env,
    serviceStatusImpl: async () => stoppedService(setup.home),
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    id: () => 'process-binding'
  });
  const transportReport = structuredClone(report);
  transportReport.requested_level = 'transport';
  transportReport.summary.transport_level_satisfied = true;
  const diagnostic = {
    catalog_generation: transportReport.catalog_generation,
    process_generation: 'process-generation-old',
    report: transportReport
  };
  assert.equal(desktopBridgeDiagnosticBindingCurrentV3(
    diagnostic,
    transportReport.catalog_generation,
    'process-generation-old',
    [`${transportReport.report_id}:bridge:http_health`]
  ), true);
  assert.equal(desktopBridgeDiagnosticBindingCurrentV3(
    diagnostic,
    transportReport.catalog_generation,
    'process-generation-restarted',
    [`${transportReport.report_id}:bridge:http_health`]
  ), false);
  assert.equal(desktopBridgeDiagnosticBindingCurrentV3(
    diagnostic,
    transportReport.catalog_generation,
    'process-generation-old',
    []
  ), false);
});

test('transport verification without a running bridge records one stage-owned failure and does not invent a generic WebSocket blocker', async (t) => {
  const setup = await fixture(t);
  const report = await verifyDesktopBridgeV3('transport', {
    home: setup.home,
    env: setup.env,
    serviceStatusImpl: async () => stoppedService(setup.home),
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    id: () => 'fixture'
  });
  const websocket = report.bridge.capabilities.websocket_transport!;
  assert.equal(websocket.root_cause, 'desktop_bridge_tcp_connect_failed');
  assert.deepEqual(websocket.blockers, ['desktop_bridge_tcp_connect_failed']);
  assert.equal(report.summary.blockers.includes('desktop_bridge_websocket_transport_failed'), false);
  assert.equal(validateDesktopCapabilityReportV3(report).ok, true);
});

test('ensure reports catalog readiness blockers instead of returning an empty-success receipt', async (t) => {
  const setup = await fixture(t);
  const result = await executeDesktopBridgeCommandV3({ operation: 'ensure' }, {
    home: setup.home,
    env: setup.env,
    serviceStatusImpl: async () => stoppedService(setup.home),
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    id: () => 'fixture'
  });

  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.status, 'partial');
  assert.ok(result.execution.blockers.length > 0);
  assert.equal(result.readiness.ready, false);
});

test('service lifecycle failure cannot be classified as a completed repair', () => {
  const service = stoppedService('/tmp/sks-service-outcome');
  const outcome = desktopBridgeServiceCommandOutcome(service);
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.blockers, ['desktop_bridge_state_missing']);

  const missingBlocker = desktopBridgeServiceCommandOutcome({ ...service, blockers: [] });
  assert.equal(missingBlocker.ok, false);
  assert.deepEqual(missingBlocker.blockers, ['desktop_bridge_service_not_running']);
});

test('R39/R40/R49: deep controller path runs active-provider probes and validates trusted evidence', async (t) => {
  const setup = await fixture(t);
  const artifactPath = path.join(setup.home, 'image.png');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  await fs.writeFile(artifactPath, png);
  const context = {
    requestedLevel: 'deep' as const,
    checkedAt: '2026-08-05T00:00:00.000Z',
    reportId: 'report-deep-controller',
    correlationId: 'correlation-deep-controller',
    sessionId: 'session-deep-controller',
    attemptId: 1
  };
  const target = {
    provider_id: 'codex-lb' as const,
    scope: 'provider:codex-lb' as const,
    capability: 'fast_mode',
    report_id: context.reportId,
    catalog_generation: 'combined-catalog-generation',
    endpoint: 'https://lb.example.test/backend-api/codex'
  };
  const content = {
    schema: 'sks.capability-trusted-deep-evidence.v2' as const,
    producer: { id: 'desktop-probe', version: '8.1.3', run_id: 'deep-run-001' },
    created_at: context.checkedAt,
    target,
    payload: { service_tier: 'priority' }
  };
  const digest = capabilityDeepEvidenceContentSha256V2(content);
  const envelope: CapabilityTrustedDeepEvidenceEnvelopeV2 = {
    ...content,
    integrity: { algorithm: 'sha256', content_sha256: digest, trust_anchor_id: 'deep-anchor-001' }
  };
  const results = await runDesktopBridgeDeepProviderProbesV3(
    'codex-lb',
    context,
    target.endpoint,
    target.catalog_generation,
    async (request) => {
      assert.equal(request.provider_id, 'codex-lb');
      assert.equal(request.report_id, context.reportId);
      return {
        image_generation: { attempted: true, outputEventSeen: true, artifactPath, artifactSha256: sha256(png) },
        computer_use: { attempted: true, callEventSeen: true, localExecutorCompleted: true, outputSubmitted: true, followUpCompleted: true, sessionAffinityPreserved: true },
        voice_mode: { attempted: true, createRouteVerified: true, locationReceived: true, locationRewritten: true, websocketUpgraded: true, serverEventSeen: true, cleanClose: true, ownerBindingVerified: true },
        auxiliary_surfaces: { attempted: true, eventPayloadsPreserved: true, requestBodyHashPreserved: true, ownerAffinityPreserved: true },
        trusted: {
          fast_mode: {
            envelope,
            trust_anchors: [{
              schema: 'sks.capability-deep-evidence-trust-anchor.v2',
              anchor_id: 'deep-anchor-001',
              producer: content.producer,
              target,
              content_sha256: digest
            }]
          }
        }
      };
    }
  );
  for (const capability of ['image_generation', 'computer_use', 'voice_mode', 'auxiliary_surfaces', 'fast_mode']) {
    assert.equal(results.find((result) => result.capability === capability)?.state, 'verified');
  }
  const missing = await runDesktopBridgeDeepProviderProbesV3(
    'openrouter',
    context,
    'https://openrouter.ai/api/v1',
    target.catalog_generation
  );
  assert.deepEqual(missing.map((result) => result.state), [
    'not_attempted',
    'not_attempted',
    'not_attempted',
    'not_attempted'
  ]);
  assert.ok(missing.every((result) => result.blockers.length === 0));
});


test('authentication priority may be saved without a credential and reports unavailable without installation', async (t) => {
  const setup = await fixture(t);
  let installs = 0;
  const options = {
    home: setup.home, env: setup.env,
    serviceStatusImpl: async () => stoppedService(setup.home),
    installServiceImpl: async () => { installs += 1; return stoppedService(setup.home); },
  };
  for (const enabled of [true, false]) {
    const result = await executeDesktopBridgeCommandV3({ operation: 'auth-priority.set', enabled }, options);
    assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
    if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
    assert.equal(result.ok, true, JSON.stringify(result));
    const status = await desktopBridgeStatusV3(options);
    assert.equal(status.auth_priority?.enabled, enabled);
    assert.equal(status.auth_priority?.state, enabled ? 'unavailable' : 'off');
    assert.equal(installs, 0);
  }
});
