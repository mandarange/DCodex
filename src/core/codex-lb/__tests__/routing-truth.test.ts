import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  codexLbRoutingTruthIsActive,
  measureAndWriteCodexLbRoutingTruth,
  measureCodexLbRoutingTruth,
  readFreshCodexLbRoutingTruthStamp,
  readCodexLbRoutingTruthReceipt
} from '../routing-truth.js';

const BASE_URL = 'https://lb.example.test/backend-api/codex';

test('measured routing truth records redacted host, auth outcome, time, and latency', async () => {
  const ticks = [10, 35];
  let authorization = '';
  const truth = await measureCodexLbRoutingTruth({
    selected: true,
    baseUrl: BASE_URL,
    apiKey: 'sk-clb-routing-truth-secret',
    now: () => ticks.shift() ?? 35,
    nowIso: () => '2026-08-01T00:00:00.000Z',
    fetchImpl: async (_url, init) => {
      authorization = String((init?.headers as Record<string, string>)?.Authorization || '');
      return new Response('{"data":[]}', { status: 200 });
    }
  });

  assert.equal(truth.ok, true);
  assert.equal(truth.status, 'verified');
  assert.equal(truth.mode, 'cli-provider');
  assert.equal(truth.configured_host, 'lb.example.test');
  assert.equal(truth.actual_host, 'lb.example.test');
  assert.equal(truth.auth_transport, 'authorization-bearer');
  assert.equal(truth.auth_outcome, 'accepted');
  assert.equal(truth.measured_at, '2026-08-01T00:00:00.000Z');
  assert.equal(truth.checked_at, '2026-08-01T00:00:00.000Z');
  assert.equal(truth.latency_ms, 25);
  assert.match(authorization, /^Bearer /);
  assert.doesNotMatch(JSON.stringify(truth), /routing-truth-secret/);
});

test('bridge truth measures the remote upstream with the active custom-header transport', async () => {
  let requestUrl = '';
  let customHeader = '';
  let authorization = '';
  const truth = await measureCodexLbRoutingTruth({
    mode: 'bridge',
    selected: true,
    baseUrl: BASE_URL,
    apiKey: 'sk-clb-bridge-secret',
    authTransport: 'x-codex-lb-api-key',
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      const headers = init?.headers as Record<string, string>;
      customHeader = String(headers?.['X-Codex-LB-API-Key'] || '');
      authorization = String(headers?.Authorization || '');
      return new Response('{"data":[]}', { status: 200 });
    }
  });

  assert.equal(truth.ok, true);
  assert.equal(truth.mode, 'bridge');
  assert.equal(truth.auth_transport, 'x-codex-lb-api-key');
  assert.equal(requestUrl, `${BASE_URL}/models`);
  assert.equal(customHeader, 'sk-clb-bridge-secret');
  assert.equal(authorization, '');
  assert.doesNotMatch(JSON.stringify(truth), /bridge-secret/);
});

test('selected routing fails closed when auth is rejected or the endpoint is unreachable', async () => {
  const rejected = await measureCodexLbRoutingTruth({
    selected: true,
    baseUrl: BASE_URL,
    apiKey: 'sk-clb-rejected',
    fetchImpl: async () => new Response('{}', { status: 401 })
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 'auth_rejected');
  assert.equal(rejected.auth_outcome, 'rejected');

  const unreachable = await measureCodexLbRoutingTruth({
    selected: true,
    baseUrl: BASE_URL,
    apiKey: 'sk-clb-unreachable',
    fetchImpl: async () => { throw new Error('offline'); }
  });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.status, 'endpoint_unreachable');
  assert.equal(unreachable.auth_outcome, 'indeterminate');
  assert.deepEqual(unreachable.blockers, ['codex_lb_endpoint_unreachable']);
});

test('config-only truth still blocks a selected route with a missing key', async () => {
  const truth = await measureCodexLbRoutingTruth({
    selected: true,
    baseUrl: BASE_URL,
    apiKey: null,
    measure: false
  });
  assert.equal(truth.ok, false);
  assert.equal(truth.measured, false);
  assert.equal(truth.status, 'missing_api_key');
});

test('routing truth receipt is atomic, owner-only, secret-free, and stale receipts fail closed', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-routing-truth-receipt-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const receiptPath = path.join(home, '.codex', 'sks-codex-lb-routing-truth.json');
  const secret = 'sk-clb-must-not-reach-receipt';
  const measuredAt = '2026-08-01T00:00:00.000Z';
  const truth = await measureAndWriteCodexLbRoutingTruth({
    mode: 'cli-provider',
    selected: true,
    baseUrl: BASE_URL,
    apiKey: secret,
    now: (() => {
      const ticks = [10, 24];
      return () => ticks.shift() ?? 24;
    })(),
    nowIso: () => measuredAt,
    fetchImpl: async () => new Response('{}', { status: 200 })
  }, { home });

  assert.equal(codexLbRoutingTruthIsActive(truth), true);
  const bytes = await fsp.readFile(receiptPath, 'utf8');
  assert.doesNotMatch(bytes, new RegExp(secret));
  assert.equal((await fsp.stat(receiptPath)).mode & 0o777, 0o600);
  const persisted = JSON.parse(bytes);
  assert.equal(persisted.measured_at, measuredAt);
  assert.equal(persisted.mode, 'cli-provider');
  assert.equal(persisted.latency_ms, 14);
  assert.equal(persisted.configured_host, 'lb.example.test');
  assert.equal(persisted.actual_host, 'lb.example.test');
  assert.equal(persisted.auth_transport, 'authorization-bearer');
  assert.equal(persisted.auth_outcome, 'accepted');
  assert.equal(persisted.http_status, 200);
  assert.deepEqual(persisted.blockers, []);

  const stale = await readCodexLbRoutingTruthReceipt({
    receiptPath,
    staleAfterMs: 1_000,
    now: () => Date.parse(measuredAt) + 1_001,
    expectedMode: 'cli-provider',
    expectedSelected: true,
    expectedConfiguredHost: 'lb.example.test',
    expectedAuthTransport: 'authorization-bearer'
  });
  assert.equal(stale?.status, 'stale');
  assert.equal(stale?.ok, false);
  assert.equal(stale?.fresh, false);
  assert.equal(codexLbRoutingTruthIsActive(stale), false);
  assert.ok(stale?.blockers.includes('codex_lb_routing_truth_stale'));

  const first = await readFreshCodexLbRoutingTruthStamp({
    receiptPath,
    now: () => Date.parse(measuredAt),
    expectedMode: 'cli-provider',
    expectedSelected: true,
    expectedConfiguredHost: 'lb.example.test',
    expectedAuthTransport: 'authorization-bearer'
  });
  const second = await readFreshCodexLbRoutingTruthStamp({
    receiptPath,
    now: () => Date.parse(measuredAt),
    expectedMode: 'cli-provider',
    expectedSelected: true,
    expectedConfiguredHost: 'lb.example.test',
    expectedAuthTransport: 'authorization-bearer'
  });
  assert.ok(first);
  assert.deepEqual(second, first);
  assert.equal(first.checked_at, measuredAt);
});

test('a receipt from a different selected state or host is not reused', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-routing-truth-context-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const receiptPath = path.join(home, 'truth.json');
  await measureAndWriteCodexLbRoutingTruth({
    selected: true,
    baseUrl: BASE_URL,
    apiKey: 'sk-clb-context-fixture',
    fetchImpl: async () => new Response('{}', { status: 200 })
  }, { receiptPath });

  assert.equal(await readCodexLbRoutingTruthReceipt({ receiptPath, expectedSelected: false }), null);
  assert.equal(await readCodexLbRoutingTruthReceipt({ receiptPath, expectedConfiguredHost: 'other.example.test' }), null);
  assert.equal(await readCodexLbRoutingTruthReceipt({ receiptPath, expectedMode: 'bridge' }), null);
});
