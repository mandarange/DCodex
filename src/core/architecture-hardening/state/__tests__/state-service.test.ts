import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ArchitectureStateService,
  type StateApplyPorts
} from '../state-service.js';

interface DesktopBridgeArchitectureState {
  readonly schema: 'sks.desktop-bridge-architecture-state.v1';
  readonly desktop_bridge: {
    readonly process_generation: string;
    readonly provider_registry_generation: string;
    readonly route_policy_generation: string;
  };
  readonly provider_route: {
    readonly provider_id: 'codex-lb' | 'openrouter';
    readonly model: string;
    readonly catalog_generation: string;
  };
}

function configuration(generation = 'generation-v1'): DesktopBridgeArchitectureState {
  return {
    schema: 'sks.desktop-bridge-architecture-state.v1',
    desktop_bridge: {
      process_generation: `process-${generation}`,
      provider_registry_generation: `registry-${generation}`,
      route_policy_generation: `policy-${generation}`
    },
    provider_route: {
      provider_id: 'codex-lb',
      model: 'gpt-5.6-codex',
      catalog_generation: `catalog-${generation}`
    }
  };
}

async function fixture(t: test.TestContext): Promise<ArchitectureStateService<DesktopBridgeArchitectureState>> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-architecture-state-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return new ArchitectureStateService<DesktopBridgeArchitectureState>(root);
}

const successfulPorts: StateApplyPorts<DesktopBridgeArchitectureState> = {
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
  assert.equal(Object.hasOwn(state, 'existing_session'), false);
});

test('failed apply preserves byte-identical last-known-good and leaves the staged draft recoverable', async (t) => {
  const store = await fixture(t);
  await store.stage(configuration('generation-v1'));
  assert.equal((await store.commit(successfulPorts)).ok, true);
  const before = await fsp.readFile(store.lastKnownGoodPath);

  await store.stage(configuration('generation-v2'));
  const failed = await store.commit({
    ...successfulPorts,
    refreshCatalog: async () => { throw new Error('catalog_refresh_failed'); }
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.blocker, 'catalog_refresh_failed');
  assert.deepEqual(await fsp.readFile(store.lastKnownGoodPath), before);
  const state = await store.read();
  assert.equal(state.draft?.provider_route.catalog_generation, 'catalog-generation-v2');
  assert.equal(state.last_known_good?.provider_route.catalog_generation, 'catalog-generation-v1');
});

test('draft rollback is idempotent and leaves the last-known-good generation untouched', async (t) => {
  const store = await fixture(t);
  await store.stage(configuration('generation-v1'));
  assert.equal((await store.commit(successfulPorts)).ok, true);
  const before = await fsp.readFile(store.lastKnownGoodPath);

  await store.stage(configuration('generation-v2'));
  assert.equal(await store.rollbackDraft(), true);
  assert.equal(await store.rollbackDraft(), false);

  const state = await store.read();
  assert.equal(state.draft, null);
  assert.equal(state.last_known_good?.provider_route.catalog_generation, 'catalog-generation-v1');
  assert.deepEqual(await fsp.readFile(store.lastKnownGoodPath), before);
});

test('crash injection cannot publish the draft and a retry recovers it', async (t) => {
  const store = await fixture(t);
  await store.stage(configuration('generation-v1'));
  await store.commit(successfulPorts);
  const before = await fsp.readFile(store.lastKnownGoodPath);

  await store.stage(configuration('generation-v2'));
  const result = await store.commit({
    ...successfulPorts,
    afterStage: (stage) => {
      if (stage === 'catalog_refreshed') throw new Error('crash_injected');
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocker, 'crash_injected');
  assert.deepEqual(await fsp.readFile(store.lastKnownGoodPath), before);
  assert.equal((await store.read()).draft?.provider_route.catalog_generation, 'catalog-generation-v2');

  const recovered = await store.commit(successfulPorts);
  assert.equal(recovered.ok, true);
  assert.equal((await store.read()).last_known_good?.provider_route.catalog_generation, 'catalog-generation-v2');
});

test('concurrent readers observe only complete last-known-good generations', async (t) => {
  const store = await fixture(t);
  await store.stage(configuration('generation-v0'));
  await store.commit(successfulPorts);
  const expected = new Set(Array.from({ length: 9 }, (_, index) => `catalog-generation-v${index}`));

  const writer = async (): Promise<void> => {
    for (let index = 1; index <= 8; index += 1) {
      await store.stage(configuration(`generation-v${index}`));
      assert.equal((await store.commit(successfulPorts)).ok, true);
    }
  };
  const reader = async (): Promise<void> => {
    for (let index = 0; index < 24; index += 1) {
      const state = await store.read();
      const catalogGeneration = state.last_known_good?.provider_route.catalog_generation;
      assert.equal(typeof catalogGeneration, 'string');
      assert.equal(expected.has(catalogGeneration as string), true);
    }
  };

  await Promise.all([writer(), ...Array.from({ length: 16 }, () => reader())]);
});

test('staging rejects values that cannot be represented safely as JSON', async (t) => {
  const store = await fixture(t);
  const invalid = {
    ...configuration(),
    desktop_bridge: {
      ...configuration().desktop_bridge,
      process_generation: Number.NaN
    }
  } as unknown as DesktopBridgeArchitectureState;

  await assert.rejects(store.stage(invalid), /state_configuration_not_json_safe/);
  assert.equal((await store.read()).draft, null);
});
