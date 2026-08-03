import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CatalogCompatibilityService, computeFeatureCompatibility, scheduleCatalogBackgroundRefresh } from '../catalog-service.js';

async function service(t: test.TestContext): Promise<CatalogCompatibilityService> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-catalog-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return new CatalogCompatibilityService(path.join(root, 'catalog.json'));
}

test('catalog refresh filters by mode and key validation, records change, and preserves last-good on failure', async (t) => {
  const catalog = await service(t);
  let validationCalls = 0;
  const port = {
    readNativeCatalog: async () => ['gpt-5.6-codex', 'anthropic/claude-sonnet-4'],
    validateModels: async (_mode: string, models: readonly string[]) => {
      validationCalls += 1;
      return models.filter((model) => model === 'gpt-5.6-codex');
    }
  };
  const first = await catalog.refresh({ trigger: 'startup', mode: 'codex-lb', credential: { status: 'ready', reason_code: null }, port, now: new Date('2026-08-02T00:00:00Z') });
  assert.deepEqual(first.last_good?.models, ['gpt-5.6-codex']);
  assert.equal(first.changed, true);
  assert.equal(validationCalls, 1);
  const failed = await catalog.refresh({
    trigger: 'manual', mode: 'codex-lb', credential: { status: 'ready', reason_code: null },
    port: { ...port, readNativeCatalog: async () => { throw new Error('catalog_offline'); } }
  });
  assert.equal(failed.failure_reason, 'catalog_offline');
  assert.deepEqual(failed.last_good, first.last_good);
});

test('credential withdrawal exposes no newly unverified catalog and pinned sessions remain unchanged', async (t) => {
  const catalog = await service(t);
  const port = { readNativeCatalog: async () => ['gpt-5.6-codex'], validateModels: async (_mode: string, models: readonly string[]) => models };
  const first = await catalog.refresh({ trigger: 'settings-applied', mode: 'codex-lb', credential: { status: 'ready', reason_code: null }, port });
  const revoked = await catalog.refresh({ trigger: 'background', mode: 'codex-lb', credential: { status: 'not_found', reason_code: 'key_revoked' }, port });
  assert.deepEqual(revoked.last_good, first.last_good);
  assert.equal(revoked.failure_reason, 'catalog_credential_not_found');
});

test('catalog validation rejects models that were not present in the native candidate set', async (t) => {
  const catalog = await service(t);
  const result = await catalog.refresh({
    trigger: 'manual', mode: 'codex-lb', credential: { status: 'ready', reason_code: null },
    port: {
      readNativeCatalog: async () => ['gpt-5.6-codex'],
      validateModels: async () => ['injected-model']
    }
  });
  assert.equal(result.last_good, null);
  assert.equal(result.failure_reason, 'catalog_validation_returned_unknown_model');
});

test('feature routing switches explicitly between direct, OAuth auxiliary, and unavailable', () => {
  assert.equal(computeFeatureCompatibility({ feature: 'image', directProxySupported: true, protocolVerified: true, oauthConnected: false, oauthAllowed: false }).route, 'direct-proxy');
  assert.equal(computeFeatureCompatibility({ feature: 'image', directProxySupported: false, protocolVerified: true, oauthConnected: true, oauthAllowed: true }).route, 'oauth-auxiliary');
  assert.equal(computeFeatureCompatibility({ feature: 'image', directProxySupported: false, protocolVerified: true, oauthConnected: false, oauthAllowed: true }).reason_code, 'feature_oauth_connection_required');
});

test('background refresh is low-frequency, stoppable, and makes failures observable', async () => {
  assert.throws(() => scheduleCatalogBackgroundRefresh(async () => undefined, 1000), /interval_too_short/);
  let tick: (() => void) | undefined;
  let observed: string | null = null;
  const schedule = ((callback: () => void) => {
    tick = callback;
    return { unref() {} };
  }) as unknown as typeof setInterval;
  const handle = scheduleCatalogBackgroundRefresh(
    async () => { throw new Error('catalog_offline'); },
    60_000,
    schedule,
    (reason) => { observed = reason; }
  );
  tick?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(handle.lastFailure(), 'catalog_offline');
  assert.equal(observed, 'catalog_offline');
  handle.stop();
});
