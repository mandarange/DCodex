import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ARCHITECTURE_HARDENING_CONTRACT_VERSION, type ArchitectureConfiguration } from '../../contracts/contracts.js';
import { ArchitectureStateService } from '../state-service.js';

function configuration(catalogVersion = 'catalog-v1'): ArchitectureConfiguration {
  return {
    schema: 'sks.architecture-configuration.v1',
    policy: {
      schema: 'sks.provider-policy-snapshot.v1',
      contract_version: ARCHITECTURE_HARDENING_CONTRACT_VERSION,
      mode: 'codex-lb',
      credential_class: 'codex-lb-api-key',
      allowed_models: ['gpt-5.6-codex'],
      child_policy_hash: 'a'.repeat(64),
      catalog_version: catalogVersion
    },
    credential: { status: 'ready', reason_code: null },
    catalog: {
      schema: 'sks.catalog-snapshot.v1',
      version: catalogVersion,
      models: ['gpt-5.6-codex'],
      checked_at: '2026-08-02T00:00:00.000Z'
    },
    features: []
  };
}

async function fixture(t: test.TestContext): Promise<ArchitectureStateService> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-architecture-state-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return new ArchitectureStateService(root);
}

const successfulPorts = {
  applyProxy: async () => undefined,
  refreshCatalog: async () => undefined,
  makeNewSessionReady: async () => undefined
};

test('atomic commit publishes four receipts and separates draft from last-known-good', async (t) => {
  const store = await fixture(t);
  await store.stage(configuration());
  const committed = await store.commit(successfulPorts, () => new Date('2026-08-02T00:00:00.000Z'));
  assert.equal(committed.ok, true);
  assert.deepEqual(committed.receipts.map((entry) => [entry.stage, entry.status]), [
    ['config_saved', 'succeeded'],
    ['proxy_applied', 'succeeded'],
    ['catalog_refreshed', 'succeeded'],
    ['new_session_ready', 'succeeded']
  ]);
  const state = await store.read();
  assert.equal(state.draft, null);
  assert.deepEqual(state.last_known_good, configuration());
  assert.deepEqual(state.new_session_default, state.last_known_good);
});

test('failed apply preserves byte-identical last-known-good and leaves the staged draft recoverable', async (t) => {
  const store = await fixture(t);
  await store.stage(configuration('catalog-v1'));
  assert.equal((await store.commit(successfulPorts)).ok, true);
  const before = await fsp.readFile(store.lastKnownGoodPath);
  await store.stage(configuration('catalog-v2'));
  const failed = await store.commit({
    ...successfulPorts,
    refreshCatalog: async () => { throw new Error('catalog_refresh_failed'); }
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.blocker, 'catalog_refresh_failed');
  assert.deepEqual(await fsp.readFile(store.lastKnownGoodPath), before);
  const state = await store.read();
  assert.equal(state.draft?.policy.catalog_version, 'catalog-v2');
  assert.equal(state.last_known_good?.policy.catalog_version, 'catalog-v1');
});

test('crash injection after a completed stage cannot publish the staged draft', async (t) => {
  const store = await fixture(t);
  await store.stage(configuration('catalog-v1'));
  await store.commit(successfulPorts);
  const before = await fsp.readFile(store.lastKnownGoodPath);
  await store.stage(configuration('catalog-v2'));
  const result = await store.commit({
    ...successfulPorts,
    afterStage: (stage) => {
      if (stage === 'catalog_refreshed') throw new Error('crash_injected');
    }
  });
  assert.equal(result.ok, false);
  assert.deepEqual(await fsp.readFile(store.lastKnownGoodPath), before);
});

test('concurrent readers see complete JSON generations only', async (t) => {
  const store = await fixture(t);
  await store.stage(configuration());
  await store.commit(successfulPorts);
  const states = await Promise.all(Array.from({ length: 32 }, () => store.read()));
  assert.equal(states.every((state) => state.last_known_good?.policy.catalog_version === 'catalog-v1'), true);
});
