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
  validateDesktopBridgeStatusV3,
  validateDesktopCapabilityReportV3
} from '../bridge-runtime-validation.js';
import {
  CODEX_LB_DESKTOP_BRIDGE_SERVICE_SCHEMA,
  desktopBridgeServicePaths,
  type DesktopBridgeServiceStatus
} from '../desktop-service.js';

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
    schema: CODEX_LB_DESKTOP_BRIDGE_SERVICE_SCHEMA,
    ok: false,
    supported: true,
    installed: false,
    loaded: false,
    running: false,
    status: 'missing',
    service: 'gui/501/com.sneakoscope.codex-lb-desktop-bridge',
    paths: desktopBridgeServicePaths(home),
    state: null,
    settings: null,
    expected_config_generation: null,
    credential_source: null,
    blockers: ['desktop_bridge_state_missing']
  };
}

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
  assert.equal(validateDesktopBridgeStatusV3(status).ok, true);
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /"(?:api_key|secret|token|authorization|cookie)"\s*:/i);
  assert.doesNotMatch(serialized, /or-ambient-key|lb-secret-/i);
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
