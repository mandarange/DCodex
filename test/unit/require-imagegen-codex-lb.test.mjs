import test from 'node:test';
import assert from 'node:assert/strict';
import { detectImagegenCapability } from '../../dist/core/imagegen/imagegen-capability.js';

test('active ready codex-lb Desktop Bridge route satisfies imagegen provider preflight', async () => {
  const result = await detectImagegenCapability({
    codexBin: '/missing-codex',
    env: {},
    desktopBridgeStatus: {
      schema: 'sks.desktop-bridge-status.v3',
      checked_at: '2026-08-06T00:00:00.000Z',
      providers: {
        'codex-lb': {
          enabled: true,
          credential: { state: 'ready', source: 'provider-store', blockers: [], warnings: [] },
          endpoint: {
            configured: true,
            origin_redacted: 'https://gateway.example',
            auth_transport: 'authorization-bearer'
          },
          capabilities: {
            state: 'verified',
            blockers: [],
            warnings: [],
            capabilities: {
              image_generation: { state: 'verified', blockers: [], warnings: [] }
            }
          }
        }
      },
      routing: {
        policy: {
          default_provider_id: 'codex-lb',
          model_routes: {},
          fallback: 'none'
        }
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.core_ready, false);
  assert.equal(result.codex_lb.selected, true);
  assert.equal(result.codex_lb.available, true);
  assert.equal(result.codex_lb.routing_active, true);
  assert.equal(result.codex_lb.api_key.present, true);
  assert.equal(result.codex_lb.api_key.source, 'provider-store');
  assert.equal(result.codex_lb.capability_evidence.state, 'verified');
  assert.equal('routing_truth' in result.codex_lb, false);
});

test('codex-lb ImageGen readiness fails closed without provider-scoped capability evidence', async () => {
  const result = await detectImagegenCapability({
    codexBin: '/missing-codex',
    env: {},
    desktopBridgeStatus: {
      schema: 'sks.desktop-bridge-status.v3',
      checked_at: '2026-08-06T00:00:00.000Z',
      providers: {
        'codex-lb': {
          enabled: true,
          credential: { state: 'ready', source: 'provider-store', blockers: [], warnings: [] },
          endpoint: { configured: true, origin_redacted: 'https://gateway.example', auth_transport: 'authorization-bearer' },
          capabilities: { state: 'not_attempted', blockers: [], warnings: [], capabilities: {} }
        }
      },
      routing: { policy: { default_provider_id: 'codex-lb', model_routes: {}, fallback: 'none' } }
    }
  });

  assert.equal(result.codex_lb.available, false);
  assert.equal(result.codex_lb.blocker, 'codex_lb_imagegen_capability_unverified');
});
