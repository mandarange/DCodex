import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRIDGE_UNREACHABLE_EVIDENCE_WINDOW_MS,
  detectUnreachableUpstreamEvidence,
  restartStaleDesktopBridgeRuntime,
  type StaleBridgeRestartDeps
} from '../desktop-bridge-catalog-repair.js';
import { PACKAGE_VERSION } from '../../version.js';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const STARTED_AT = '2026-09-01T11:00:00.000Z';

function rejectionLine(input: { at: string; code: string; event?: string }): string {
  return JSON.stringify({
    schema: 'sks.desktop-bridge-log.v2',
    sks_version: PACKAGE_VERSION,
    at: input.at,
    secret_fields_redacted: true,
    event: input.event || 'sks.desktop_bridge.rejected',
    code: input.code,
    transport: 'http',
    method: 'POST',
    pathname: '/backend-api/codex/responses'
  });
}

test('recent upstream-unavailable rejections from the current process count as evidence', () => {
  const tail = [
    rejectionLine({ at: '2026-09-01T11:55:00.000Z', code: 'bridge_upstream_unavailable:EHOSTUNREACH' }),
    rejectionLine({ at: '2026-09-01T11:58:00.000Z', code: 'bridge_upstream_unavailable', event: 'sks.desktop_bridge.rejected_summary' }),
  ].join('\n');
  assert.equal(detectUnreachableUpstreamEvidence(tail, STARTED_AT, NOW), 'bridge_upstream_unavailable');
  // WebSocket-side rejections are the same dead pin seen from the other transport.
  const wsTail = rejectionLine({ at: '2026-09-01T11:59:00.000Z', code: 'bridge_websocket_upstream_unavailable' });
  assert.equal(detectUnreachableUpstreamEvidence(wsTail, STARTED_AT, NOW), 'bridge_websocket_upstream_unavailable');
});

test('stale, pre-restart, unrelated, and malformed log entries are not evidence', () => {
  const beforeWindow = new Date(NOW - BRIDGE_UNREACHABLE_EVIDENCE_WINDOW_MS - 60_000).toISOString();
  const tail = [
    // Older than the evidence window: a blip the network may have outlived.
    rejectionLine({ at: beforeWindow, code: 'bridge_upstream_unavailable:EHOSTUNREACH' }),
    // Emitted BEFORE the current process started: a prior process's failure.
    rejectionLine({ at: '2026-09-01T10:59:00.000Z', code: 'bridge_upstream_unavailable:EHOSTUNREACH' }),
    // Unrelated rejection codes never trigger a restart.
    rejectionLine({ at: '2026-09-01T11:59:00.000Z', code: 'bridge_client_capability_required' }),
    rejectionLine({ at: '2026-09-01T11:59:00.000Z', code: 'bridge_upstream_status_401' }),
    // Torn tail line from a partial write.
    '{"schema":"sks.desktop-bridge-log.v2","event":"sks.desktop_bridge.rejected","code":"bridge_upstream_unav',
  ].join('\n');
  assert.equal(detectUnreachableUpstreamEvidence(tail, STARTED_AT, NOW), null);
  // Records inside the window but before a LATER process start stay excluded.
  const recent = rejectionLine({ at: '2026-09-01T11:56:00.000Z', code: 'bridge_upstream_unavailable:EHOSTUNREACH' });
  assert.equal(detectUnreachableUpstreamEvidence(recent, '2026-09-01T11:57:00.000Z', NOW), null);
});

function serviceStatus(input: { running?: boolean; version?: string } = {}): any {
  return {
    running: input.running ?? true,
    state: {
      pid: 1234,
      started_at: STARTED_AT,
      sks_version: input.version ?? PACKAGE_VERSION
    },
    paths: { stdout_log_path: '/dev/null/desktop-bridge.out.log' }
  };
}

function depsWith(input: {
  tail: string;
  bootstrapCalls?: string[];
  bootstrapResult?: any;
}): StaleBridgeRestartDeps {
  return {
    serviceStatusImpl: (async () => serviceStatus()) as any,
    readLogTailImpl: async () => input.tail,
    bootstrapImpl: (async () => {
      input.bootstrapCalls?.push('bootstrap');
      return input.bootstrapResult ?? serviceStatus();
    }) as any,
    nowMs: () => NOW
  };
}

test('a current-version bridge with recent unreachable evidence is reported without fix and restarted with fix', async () => {
  const tail = rejectionLine({ at: '2026-09-01T11:59:00.000Z', code: 'bridge_upstream_unavailable:EHOSTUNREACH' });

  const reported = await restartStaleDesktopBridgeRuntime({ home: '/tmp/home', fix: false }, depsWith({ tail }));
  assert.deepEqual(reported, {
    restarted: false,
    warnings: [],
    blockers: ['desktop_bridge_upstream_unreachable:bridge_upstream_unavailable:EHOSTUNREACH']
  });

  const bootstrapCalls: string[] = [];
  const fixed = await restartStaleDesktopBridgeRuntime({ home: '/tmp/home', fix: true }, depsWith({ tail, bootstrapCalls }));
  assert.deepEqual(bootstrapCalls, ['bootstrap']);
  assert.equal(fixed.restarted, true);
  assert.deepEqual(fixed.blockers, []);
  assert.deepEqual(fixed.warnings, ['desktop_bridge_upstream_unreachable_restarted:bridge_upstream_unavailable:EHOSTUNREACH']);
});

test('a healthy current-version bridge is left alone; a failed restart keeps the blocker', async () => {
  const bootstrapCalls: string[] = [];
  const healthy = await restartStaleDesktopBridgeRuntime({ home: '/tmp/home', fix: true }, depsWith({
    tail: rejectionLine({ at: '2026-09-01T11:59:00.000Z', code: 'bridge_upstream_status_502' }),
    bootstrapCalls
  }));
  assert.deepEqual(healthy, { restarted: false, warnings: [], blockers: [] });
  assert.deepEqual(bootstrapCalls, [], 'no evidence must mean no restart');

  const tail = rejectionLine({ at: '2026-09-01T11:59:00.000Z', code: 'bridge_upstream_unavailable:EHOSTUNREACH' });
  const failed = await restartStaleDesktopBridgeRuntime({ home: '/tmp/home', fix: true }, depsWith({
    tail,
    bootstrapResult: { running: false, state: null, paths: {} }
  }));
  assert.equal(failed.restarted, false);
  assert.deepEqual(failed.blockers, ['desktop_bridge_upstream_unreachable:bridge_upstream_unavailable:EHOSTUNREACH']);
});

test('version-stale restart precedence is unchanged by the unreachable check', async () => {
  const deps: StaleBridgeRestartDeps = {
    serviceStatusImpl: (async () => serviceStatus({ version: '9.0.0' })) as any,
    readLogTailImpl: async () => { throw new Error('log must not be read on the version-stale path'); },
    bootstrapImpl: (async () => serviceStatus()) as any,
    nowMs: () => NOW
  };
  const result = await restartStaleDesktopBridgeRuntime({ home: '/tmp/home', fix: true }, deps);
  assert.equal(result.restarted, true);
  assert.deepEqual(result.warnings, [`desktop_bridge_runtime_restarted:9.0.0:${PACKAGE_VERSION}`]);
});

test('a reroute newer than the last failure means the bridge healed itself: no evidence, no restart', () => {
  const healed = [
    rejectionLine({ at: '2026-09-01T11:58:00.000Z', code: 'bridge_upstream_unavailable:EHOSTUNREACH' }),
    rejectionLine({ at: '2026-09-01T11:59:00.000Z', code: 'bridge_upstream_unreachable_rerouted:EHOSTUNREACH' }),
  ].join('\n');
  assert.equal(detectUnreachableUpstreamEvidence(healed, STARTED_AT, NOW), null);
  // A failure AFTER the reroute means the fresh address was dead too: evidence stands.
  const stillDead = [
    healed,
    rejectionLine({ at: '2026-09-01T11:59:30.000Z', code: 'bridge_upstream_unavailable:EHOSTUNREACH' }),
  ].join('\n');
  assert.equal(detectUnreachableUpstreamEvidence(stillDead, STARTED_AT, NOW), 'bridge_upstream_unavailable:EHOSTUNREACH');
});

test('the read-only evidence reader binds the log to the serving process recorded in the state file', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { writeDesktopBridgeState } = await import('../../codex-lb/desktop-bridge/state.js');
  const { desktopBridgeServicePaths } = await import('../../codex-lb/desktop-service.js');
  const { readDesktopBridgeUnreachableUpstreamEvidence } = await import('../desktop-bridge-catalog-repair.js');
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-bridge-evidence-'));
  try {
    const paths = desktopBridgeServicePaths(home);
    // No state file: nothing is serving, so there is nothing to restart.
    assert.equal(await readDesktopBridgeUnreachableUpstreamEvidence(home, { nowMs: () => NOW }), null);
    const generation = 'a'.repeat(64);
    await writeDesktopBridgeState(paths.state_path, {
      schema: 'sks.desktop-bridge-state.v2', runtime: 'desktop-bridge', pid: 4242,
      started_at: STARTED_AT, updated_at: STARTED_AT, stale_after: '2026-09-01T13:00:00.000Z',
      listen_origin: 'http://127.0.0.1:53451', codex_base_url: 'http://127.0.0.1:53451/backend-api/codex',
      process_generation: 'process-generation', provider_registry_generation: 'registry-generation',
      route_policy_generation: 'policy-generation', catalog_generation: 'catalog-generation',
      enabled_providers: ['codex-lb'], provider_credential_generations: { 'codex-lb': 'cred', openrouter: 'cred' },
      last_verified_probe_ids: [], config_generation: generation, sks_version: PACKAGE_VERSION
    } as any);
    await fsp.mkdir(path.dirname(paths.stdout_log_path), { recursive: true });
    await fsp.writeFile(paths.stdout_log_path, [
      // Written by a PREVIOUS process: excluded by the state file's started_at.
      rejectionLine({ at: '2026-09-01T10:30:00.000Z', code: 'bridge_upstream_unavailable:EHOSTUNREACH' }),
      rejectionLine({ at: '2026-09-01T11:57:00.000Z', code: 'bridge_client_capability_required' }),
    ].join('\n') + '\n');
    assert.equal(await readDesktopBridgeUnreachableUpstreamEvidence(home, { nowMs: () => NOW }), null);
    await fsp.appendFile(paths.stdout_log_path, rejectionLine({ at: '2026-09-01T11:59:00.000Z', code: 'bridge_upstream_unavailable:EHOSTUNREACH' }) + '\n');
    assert.deepEqual(await readDesktopBridgeUnreachableUpstreamEvidence(home, { nowMs: () => NOW }), {
      code: 'bridge_upstream_unavailable:EHOSTUNREACH', started_at: STARTED_AT
    });
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('--fix re-verifies transport after the repair so a serving bridge leaves `degraded`; read-only never probes', async () => {
  const { repairDoctorDesktopBridgeCatalog } = await import('../desktop-bridge-catalog-repair.js');
  const managedStatus = (state: 'degraded' | 'ready') => ({
    management: { managed: true },
    service: { state: 'ready', running: true },
    readiness: { state, ready: state === 'ready', blockers: [] }
  });
  const operations: string[] = [];
  const statuses: string[] = [];
  let readinessState: 'degraded' | 'ready' = 'degraded';
  const deps = {
    restartStaleDesktopBridgeRuntimeImpl: (async () => ({ restarted: false, warnings: [], blockers: [] })) as any,
    desktopBridgeStatusImpl: (async () => { statuses.push(readinessState); return managedStatus(readinessState); }) as any,
    executeDesktopBridgeCommandImpl: (async (request: any) => {
      operations.push(`${request.operation}:${request.level || ''}`);
      if (request.operation === 'verify') readinessState = 'ready';
      return { ok: true };
    }) as any
  };

  const fixed = await repairDoctorDesktopBridgeCatalog({ fix: true }, deps);
  assert.deepEqual(operations, ['verify:transport'], 'exactly one transport verify, no catalog sync for a fresh catalog');
  assert.equal(fixed.ok, true);
  assert.equal(fixed.repaired, true, 'degraded -> ready counts as a repair');
  assert.deepEqual(fixed.warnings, ['desktop_bridge_transport_reverified']);
  assert.deepEqual(fixed.blockers, []);

  // Already ready: nothing to re-verify, no probe fired.
  operations.length = 0; readinessState = 'ready';
  const ready = await repairDoctorDesktopBridgeCatalog({ fix: true }, deps);
  assert.deepEqual(operations, []);
  assert.deepEqual(ready.warnings, []);

  // Read-only doctor must never fire live probes, degraded or not.
  operations.length = 0; readinessState = 'degraded';
  const readOnly = await repairDoctorDesktopBridgeCatalog({ fix: false }, deps);
  assert.deepEqual(operations, []);
  assert.deepEqual(readOnly.warnings, []);
});
