import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKTOP_BRIDGE_IMAGEGEN_RECOVERY_GUIDANCE,
  resolveDesktopBridgeImagegenTarget
} from '../../dist/core/imagegen/desktop-bridge-imagegen-target.js';

test('Desktop Bridge ImageGen requires one explicit model and never chooses the first route', async () => {
  const target = await resolveDesktopBridgeImagegenTarget({
    env: {},
    desktopBridgeStatus: bridgeStatus()
  });

  assert.equal(target.selected, true);
  assert.equal(target.model, null);
  assert.equal(target.route, null);
  assert.equal(target.endpoint, null);
  assert.equal(target.blocker, 'desktop_bridge_imagegen_model_missing');
  assert.equal(target.setup_guidance, DESKTOP_BRIDGE_IMAGEGEN_RECOVERY_GUIDANCE);
});

test('Desktop Bridge ImageGen resolves an exact current route to loopback without a provider secret', async () => {
  const target = await resolveDesktopBridgeImagegenTarget({
    explicitModel: 'public-image-model',
    env: { CODEX_LB_API_KEY: 'must-never-be-read' },
    desktopBridgeStatus: bridgeStatus()
  });

  assert.equal(target.bridge_verified, true);
  assert.equal(target.endpoint, 'http://127.0.0.1:18765/backend-api/codex/responses');
  assert.equal(target.model, 'public-image-model');
  assert.equal(target.model_source, 'explicit');
  assert.equal(target.provider_id, 'codex-lb');
  assert.deepEqual(target.route, { provider_id: 'codex-lb', upstream_model: 'upstream-image-model' });
  assert.equal(target.status_source, 'injected_fixture');
  assert.equal(target.live_evidence_allowed, false);
  assert.doesNotMatch(JSON.stringify(target), /must-never-be-read|api_key|authorization/i);
});

test('a slash in an explicit model never infers a provider', async () => {
  const target = await resolveDesktopBridgeImagegenTarget({
    explicitModel: 'openrouter/public-image-model',
    env: {},
    desktopBridgeStatus: bridgeStatus()
  });

  assert.equal(target.route, null);
  assert.equal(target.provider_id, null);
  assert.equal(target.blocker, 'catalog_model_route_missing');
});

test('a model absent from the current route index fails closed', async () => {
  const target = await resolveDesktopBridgeImagegenTarget({
    explicitModel: 'unknown-image-model',
    env: {},
    desktopBridgeStatus: bridgeStatus()
  });

  assert.equal(target.endpoint, null);
  assert.equal(target.blocker, 'catalog_model_route_missing');
});

test('non-loopback and unverified bridge state never produce an endpoint', async () => {
  const remote = await resolveDesktopBridgeImagegenTarget({
    explicitModel: 'public-image-model',
    env: {},
    desktopBridgeStatus: bridgeStatus({ loopbackOrigin: 'https://gateway.example.test' })
  });
  assert.equal(remote.endpoint, null);
  assert.equal(remote.blocker, 'desktop_bridge_loopback_unverified');

  const unverified = await resolveDesktopBridgeImagegenTarget({
    explicitModel: 'public-image-model',
    env: {},
    desktopBridgeStatus: bridgeStatus({ bridgeReady: false })
  });
  assert.equal(unverified.endpoint, null);
  assert.equal(unverified.blocker, 'desktop_bridge_state_unverified');
});

function bridgeStatus(input = {}) {
  const loopbackOrigin = input.loopbackOrigin || 'http://127.0.0.1:18765';
  const bridgeReady = input.bridgeReady !== false;
  const capability = {
    state: 'verified',
    blockers: [],
    warnings: []
  };
  return {
    schema: 'sks.desktop-bridge-status.v3',
    checked_at: '2026-08-06T00:00:00.000Z',
    management: { managed: true, runtime: 'desktop-bridge', state: 'ready', reason: null },
    service: {
      state: 'ready',
      running: true,
      loopback_origin: loopbackOrigin,
      blockers: [],
      warnings: []
    },
    routing: {
      policy: {
        fallback: 'none',
        model_routes: {
          'public-image-model': { provider_id: 'codex-lb', upstream_model: 'upstream-image-model' },
          'another-model': { provider_id: 'openrouter', upstream_model: 'another-upstream' }
        }
      }
    },
    providers: {
      'codex-lb': {
        enabled: true,
        credential: { state: 'ready', blockers: [], warnings: [] },
        capabilities: { capabilities: { image_generation: capability } }
      },
      openrouter: {
        enabled: true,
        credential: { state: 'ready', blockers: [], warnings: [] },
        capabilities: { capabilities: { image_generation: capability } }
      }
    },
    catalog_sync: { state: 'verified', blockers: [], warnings: [] },
    readiness: { bridge_ready: bridgeReady, blockers: [], warnings: [] },
    recovery_actions: []
  };
}
