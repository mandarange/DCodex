import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDesktopBridgeWebSocketRequest } from '../../dist/core/codex-lb/desktop-bridge/websocket-forward.js';

const THREAD = '019fd56f-d48f-7942-a560-48ad9ef47223';
const MODEL = 'gpt-5.6-sol';
const UPSTREAM = 'gpt-5.6-sol-upstream';
const CATALOG = 'catalog-generation-1';
const POLICY = 'policy-generation-1';

function config({ pins = [] } = {}) {
  const seen = [];
  return {
    seen,
    // Stubbed so the assertion is about WHICH model reaches routing — the thing
    // the upgrade never supplied — rather than about the resolver's internals.
    resolveRequestRoute: (request) => {
      const model = request.model ?? request.public_model;
      seen.push(model);
      // A WS upgrade always carries a thread id, so the route must come back
      // with the matching pin or the caller rejects it as an invalid pin.
      return {
        provider_id: 'codex-lb',
        public_model: model,
        upstream_model: UPSTREAM,
        catalog_generation: CATALOG,
        route_policy_generation: POLICY,
        session_pin: {
          thread_id: THREAD,
          provider_id: 'codex-lb',
          public_model: model,
          upstream_model: UPSTREAM,
          catalog_generation: CATALOG,
          route_policy_generation: POLICY,
          created_at: '2026-08-11T00:00:00.000Z',
        },
      };
    },
    routePolicy: {
      catalog_generation: CATALOG,
      policy_generation: POLICY,
      model_routes: { [MODEL]: { provider_id: 'codex-lb', upstream_model: UPSTREAM } },
    },
    providerSessionPins: pins,
    providers: {
      'codex-lb': {
        provider_id: 'codex-lb',
        enabled: true,
        credential_state: 'ready',
        credential_generation: 'cred-1',
        credential_fingerprint: null,
        source_catalog_generation: null,
        allowed_origins: ['https://upstream.invalid'],
        base_url: 'https://upstream.invalid/backend-api/codex',
        remote: { address: '127.0.0.1', port: 1, secure: false, origin: 'https://upstream.invalid' },
      },
    },
    resolveProviderCredential: async () => ({
      provider_id: 'codex-lb', generation: 'cred-1', fingerprint: null,
    }),
    persistProviderSessionPins: async () => undefined,
  };
}

function pin() {
  return {
    thread_id: THREAD,
    provider_id: 'codex-lb',
    public_model: MODEL,
    upstream_model: UPSTREAM,
    catalog_generation: CATALOG,
    route_policy_generation: POLICY,
    created_at: '2026-08-11T00:00:00.000Z',
  };
}

function upgrade(threadId = THREAD) {
  // What Codex actually sends: no request body, and no `x-sks-model` — that
  // header is SKS's own and only its probes emit it.
  return { headers: { 'thread-id': threadId, 'session-id': threadId }, url: '/backend-api/codex/responses', method: 'GET' };
}

test('a pinned thread routes its Responses WebSocket', async () => {
  // The upgrade carries no model, so this used to resolve `model_routes['']`
  // and fail — meaning no Codex Responses WebSocket ever succeeded through the
  // bridge. The thread's pin already holds the routing decision.
  const cfg = config({ pins: [pin()] });
  const prepared = await prepareDesktopBridgeWebSocketRequest(upgrade(), cfg);
  assert.deepEqual(cfg.seen, [MODEL], 'the pinned model must reach route resolution');
  assert.equal(prepared.route.provider_id, 'codex-lb');
  assert.equal(prepared.route.public_model, MODEL);
});

test('an unpinned thread is refused as unroutable, not as a broken upstream', async () => {
  // Nothing has bound this thread yet. That is a permanent property of the
  // request; reporting it as a flaky upstream is what made the client spend its
  // whole reconnect budget before falling back to HTTP.
  await assert.rejects(
    () => prepareDesktopBridgeWebSocketRequest(upgrade(), config()),
    (error) => {
      assert.equal(error.code, 'bridge_websocket_route_unresolvable');
      return true;
    },
  );
});

test('an explicit model header still wins over the pin', async () => {
  const request = upgrade();
  request.headers['x-sks-model'] = MODEL;
  const cfg = config();
  const prepared = await prepareDesktopBridgeWebSocketRequest(request, cfg);
  assert.deepEqual(cfg.seen, [MODEL]);
  assert.equal(prepared.route.public_model, MODEL);
});

test('a pin for a different thread does not leak into this upgrade', async () => {
  // Per-thread affinity is the whole point of the pin; borrowing another
  // thread's route would silently cross-wire two conversations.
  const other = { ...pin(), thread_id: '019fd570-9999-7942-a560-48ad9ef47000' };
  await assert.rejects(
    () => prepareDesktopBridgeWebSocketRequest(upgrade(), config({ pins: [other] })),
    (error) => error.code === 'bridge_websocket_route_unresolvable',
  );
});
