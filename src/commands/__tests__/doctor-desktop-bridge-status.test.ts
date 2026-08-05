import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDoctorDesktopBridgeStatus } from '../doctor.js';

function bridgeStatus(input: { managed?: boolean; ready?: boolean } = {}) {
  const managed = input.managed ?? true;
  const ready = input.ready ?? true;
  return {
    schema: 'sks.desktop-bridge-status.v3',
    checked_at: '2026-08-06T00:00:00.000Z',
    management: { managed },
    providers: {
      'codex-lb': {
        enabled: managed,
        credential: {
          state: managed ? 'ready' : 'absent',
          source: managed ? 'provider-store' : null,
          fingerprint: managed ? 'redacted-fingerprint' : null,
          blockers: [],
          warnings: []
        },
        endpoint: {
          configured: managed,
          origin_redacted: managed ? 'https://gateway.example' : null,
          auth_transport: managed ? 'authorization-bearer' : null
        }
      },
      openrouter: {
        enabled: false,
        credential: { state: 'absent', source: null, blockers: [], warnings: [] },
        endpoint: { configured: false, origin_redacted: null, auth_transport: null }
      }
    },
    readiness: {
      ready,
      state: ready ? 'ready' : managed ? 'blocked' : 'unmanaged',
      blockers: ready || !managed ? [] : ['codex_lb_credential_invalid'],
      warnings: []
    },
    recovery_actions: ready ? [] : ['Run `sks bridge provider validate codex-lb`.']
  };
}

test('Doctor reports current Desktop Bridge provider facts without mutating credentials', async () => {
  let calls = 0;
  const result: any = await inspectDoctorDesktopBridgeStatus(
    { home: '/tmp/doctor-desktop-bridge', processEnv: { HOME: '/tmp/doctor-desktop-bridge' } },
    { desktopBridgeStatusImpl: async () => { calls += 1; return bridgeStatus(); } }
  );

  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.read_only, true);
  assert.equal(result.credentials_mutated, false);
  assert.equal(result.providers['codex-lb'].credential.state, 'ready');
  assert.equal(result.providers['codex-lb'].credential.source, 'provider-store');
  assert.equal('legacy_keychain_migration' in result, false);
  assert.equal('secret_resolution' in result, false);
});

test('Doctor blocks on managed Desktop Bridge readiness blockers but not an unmanaged bridge', async () => {
  const blocked: any = await inspectDoctorDesktopBridgeStatus({}, {
    desktopBridgeStatusImpl: async () => bridgeStatus({ managed: true, ready: false })
  });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blockers, ['codex_lb_credential_invalid']);

  const unmanaged: any = await inspectDoctorDesktopBridgeStatus({}, {
    desktopBridgeStatusImpl: async () => bridgeStatus({ managed: false, ready: false })
  });
  assert.equal(unmanaged.ok, true);
  assert.deepEqual(unmanaged.blockers, []);
});

test('Doctor does not block a fresh managed runtime with no enabled provider profile', async () => {
  const status = bridgeStatus({ managed: true, ready: false });
  status.providers['codex-lb'].enabled = false;
  status.providers['codex-lb'].credential.state = 'absent';
  status.providers['codex-lb'].endpoint.configured = false;

  const result: any = await inspectDoctorDesktopBridgeStatus({}, {
    desktopBridgeStatusImpl: async () => status
  });

  assert.equal(result.managed, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test('Doctor fails closed when Desktop Bridge status is unavailable', async () => {
  const result: any = await inspectDoctorDesktopBridgeStatus({}, {
    desktopBridgeStatusImpl: async () => { throw new Error('bridge unavailable'); }
  });

  assert.equal(result.ok, false);
  assert.equal(result.read_only, true);
  assert.deepEqual(result.blockers, ['desktop_bridge_status_unavailable:bridge unavailable']);
});
