import '../../__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  desktopBridgeStatusV3,
  verifyDesktopBridgeV3
} from '../desktop-controller-v3.js';
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

test('shallow verification emits a correlation-bound v3 report with mandatory catalog truth', async (t) => {
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
