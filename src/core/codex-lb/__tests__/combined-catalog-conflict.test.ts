import '../../__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  activateCombinedBridgeCatalog,
  buildCombinedBridgeCatalog,
  readActiveCombinedBridgeCatalog,
  stageCombinedBridgeCatalog
} from '../combined-catalog.js';
import { resolveAllProviderCredentials } from '../provider-credentials.js';
import { resolveBridgeProviderRegistry } from '../provider-registry.js';
import { buildBridgeRoutingPolicy } from '../provider-route-policy.js';
import { desktopBridgeCatalogStatusV3 } from '../desktop-controller-v3.js';

async function registryFixture() {
  const credentials = await resolveAllProviderCredentials({
    codexLb: {
      loadCodexLbEnvImpl: async () => ({
        schema: 'sks.codex-lb-env.v1', configured: true, missing: [], source: 'env-file', source_priority: ['env-file'],
        base_url: 'https://lb.example.test/backend-api/codex',
        api_key: { present: true, usable: true, source: 'env-file', redacted: true, fingerprint: 'aaaaaaaaaaaaaaaa' },
        secret_api_key: 'lb-catalog-secret',
        credential_binding: { checked: true, present: true, valid: true, status: 'matched', metadata_path: '/fixture', api_key_matches: true, base_url_matches: true, blockers: [] },
        env_paths: ['/fixture'], keychain: { checked: false, available: false, status: 'not_used' }
      }),
      validation: { state: 'ready', checked_at: '2026-08-05T00:00:00.000Z' }
    },
    openrouter: {
      resolveOpenRouterApiKeyImpl: async () => ({ key: 'or-catalog-secret', source: 'user-secret-store', key_preview: 'or-...', blockers: [], warnings: [] }),
      validation: { state: 'ready', checked_at: '2026-08-05T00:00:00.000Z' }
    }
  });
  return resolveBridgeProviderRegistry({ registryPath: '/missing/provider-registry.json', credentials });
}

function catalogs(shared = false, suffix = '') {
  return {
    'codex-lb': {
      provider_id: 'codex-lb' as const,
      state: 'verified' as const,
      generation: `lb-generation${suffix}`,
      models: { models: [{ slug: shared ? 'shared-model' : `lb-model${suffix}`, display_name: 'LB' }] }
    },
    openrouter: {
      provider_id: 'openrouter' as const,
      state: 'verified' as const,
      generation: `or-generation${suffix}`,
      models: [{ id: shared ? 'shared-model' : `or-model${suffix}`, name: 'OR' }]
    }
  };
}

test('R26: ambiguous public IDs are explicit conflicts with no silent provider priority', async () => {
  const registry = await registryFixture();
  const first = buildCombinedBridgeCatalog(registry, {
    catalogs: catalogs(true),
    created_at: '2026-08-05T00:00:00.000Z'
  });
  assert.equal(first.ok, false);
  assert.ok(first.blockers.includes('catalog_model_route_ambiguous'));
  assert.equal(first.route_index.routes['shared-model'], undefined);
  assert.equal(first.route_index.routes['codex-lb:shared-model']?.provider_id, 'codex-lb');
  assert.equal(first.route_index.routes['openrouter:shared-model']?.provider_id, 'openrouter');
  assert.deepEqual(first.route_index.conflicts, [{
    public_id: 'shared-model',
    providers: ['codex-lb', 'openrouter'],
    blocker: 'catalog_model_route_ambiguous'
  }]);
});

test('codex-lb models sort before openrouter rows and default to picker priority 100', async () => {
  const registry = await registryFixture();
  const result = buildCombinedBridgeCatalog(registry, {
    catalogs: {
      'codex-lb': {
        provider_id: 'codex-lb' as const,
        state: 'verified' as const,
        generation: 'lb-generation',
        models: { models: [
          { slug: 'zz-lb-model', display_name: 'LB Last Alphabetically' },
          { slug: 'aa-lb-pinned', display_name: 'LB Pinned Priority', priority: 7 }
        ] }
      },
      openrouter: {
        provider_id: 'openrouter' as const,
        state: 'verified' as const,
        generation: 'or-generation',
        models: [{ id: 'aa-or-model', name: 'OR First Alphabetically' }]
      }
    },
    created_at: '2026-08-08T00:00:00.000Z'
  });
  assert.equal(result.ok, true, JSON.stringify(result.blockers));
  // Ordering, not alphabet, decides provider precedence: every codex-lb row
  // precedes every openrouter row so gateway models survive picker truncation.
  assert.deepEqual(
    result.catalog.models.map((model) => `${model.provider_id}:${model.public_id}`),
    ['codex-lb:aa-lb-pinned', 'codex-lb:zz-lb-model', 'openrouter:aa-or-model']
  );
  const byId = new Map(result.catalog.models.map((model) => [model.public_id, model]));
  assert.equal(byId.get('zz-lb-model')?.priority, 100);
  assert.equal(byId.get('aa-lb-pinned')?.priority, 7);
  assert.equal(byId.get('aa-or-model')?.priority, 1);
});

test('deterministic catalog and route generations ignore observation time and contain no secrets', async () => {
  const registry = await registryFixture();
  const first = buildCombinedBridgeCatalog(registry, {
    catalogs: catalogs(false),
    created_at: '2026-08-05T00:00:00.000Z'
  });
  const second = buildCombinedBridgeCatalog(registry, {
    catalogs: catalogs(false),
    created_at: '2026-08-06T00:00:00.000Z'
  });
  assert.equal(first.catalog.generation, second.catalog.generation);
  assert.equal(first.catalog.digest, second.catalog.digest);
  assert.equal(first.route_index.generation, second.route_index.generation);
  const serialized = JSON.stringify({ catalog: first.catalog, route_index: first.route_index });
  assert.equal(serialized.includes('lb-catalog-secret'), false);
  assert.equal(serialized.includes('or-catalog-secret'), false);
});

test('R23: one provider catalog failure degrades the combined result while retaining the ready provider routes', async () => {
  const registry = await registryFixture();
  const input = catalogs(false);
  const result = buildCombinedBridgeCatalog(registry, {
    catalogs: {
      ...input,
      openrouter: {
        ...input.openrouter,
        state: 'failed',
        models: [],
        blockers: ['openrouter_catalog_fetch_failed']
      }
    },
    created_at: '2026-08-05T00:00:00.000Z'
  });
  assert.equal(result.ok, true);
  assert.equal(result.status.state, 'degraded');
  assert.equal(result.route_index.routes['lb-model']?.provider_id, 'codex-lb');
  assert.ok(result.status.blockers.includes('openrouter_catalog_fetch_failed'));
});

test('R32/R50: failed pair activation restores the previous verified generation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-combined-activation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, 'catalog.json');
  const routeIndexPath = path.join(root, 'route-index.json');
  const registry = await registryFixture();
  const first = buildCombinedBridgeCatalog(registry, {
    catalogs: catalogs(false),
    created_at: '2026-08-05T00:00:00.000Z'
  });
  const activated = await activateCombinedBridgeCatalog({ build: first, catalogPath, routeIndexPath });
  assert.equal(activated.activated, true, JSON.stringify(activated.blockers));
  assert.ok(activated.catalog_path);
  assert.ok(activated.route_index_path);
  await assert.rejects(fs.access(catalogPath));
  await assert.rejects(fs.access(routeIndexPath));
  assert.equal(await fs.access(activated.pointer_path).then(() => true, () => false), true);
  const beforeActive = await readActiveCombinedBridgeCatalog(catalogPath, routeIndexPath);
  assert.equal(beforeActive.ok, true, JSON.stringify(beforeActive.blockers));
  const beforeCatalog = await fs.readFile(beforeActive.catalog_path!);
  const beforeRoute = await fs.readFile(beforeActive.route_index_path!);
  const beforePointer = await fs.readFile(beforeActive.pointer_path);

  const second = buildCombinedBridgeCatalog(registry, {
    catalogs: catalogs(false, '-next'),
    created_at: '2026-08-05T00:01:00.000Z'
  });
  const failed = await activateCombinedBridgeCatalog({
    build: second,
    catalogPath,
    routeIndexPath,
    testHooks: {
      afterCatalogRename: () => {
        throw new Error('injected_activation_failure');
      }
    }
  });
  assert.equal(failed.activated, false);
  assert.deepEqual(await fs.readFile(beforeActive.catalog_path!), beforeCatalog);
  assert.deepEqual(await fs.readFile(beforeActive.route_index_path!), beforeRoute);
  assert.deepEqual(await fs.readFile(beforeActive.pointer_path), beforePointer);
  const restarted = await readActiveCombinedBridgeCatalog(catalogPath, routeIndexPath);
  assert.equal(restarted.ok, true, JSON.stringify(restarted.blockers));
  assert.equal(restarted.catalog.generation, first.catalog.generation);
  assert.equal(restarted.route_index.generation, first.route_index.generation);
});

test('R28/R50: provider catalog expiry survives activation and full reload', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-combined-freshness-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = await registryFixture();
  const inputs = catalogs(false);
  const build = buildCombinedBridgeCatalog(registry, {
    catalogs: {
      'codex-lb': { ...inputs['codex-lb'], checked_at: '2026-08-05T00:00:00.000Z', expires_at: '2026-08-05T00:15:00.000Z' },
      openrouter: { ...inputs.openrouter, checked_at: '2026-08-05T00:00:00.000Z', expires_at: '2026-08-05T00:15:00.000Z' }
    },
    created_at: '2026-08-05T00:00:00.000Z'
  });
  const catalogPath = path.join(root, 'catalog.json');
  const routeIndexPath = path.join(root, 'route-index.json');
  const activated = await activateCombinedBridgeCatalog({ build, catalogPath, routeIndexPath });
  assert.equal(activated.activated, true, JSON.stringify(activated.blockers));
  const restarted = await readActiveCombinedBridgeCatalog(catalogPath, routeIndexPath);
  assert.equal(restarted.ok, true, JSON.stringify(restarted.blockers));
  assert.equal(restarted.catalog.provider_statuses['codex-lb'].expires_at, '2026-08-05T00:15:00.000Z');
  assert.equal(restarted.catalog.provider_statuses.openrouter.expires_at, '2026-08-05T00:15:00.000Z');
  const policy = buildBridgeRoutingPolicy({
    route_index: restarted.route_index,
    catalog_generation: restarted.catalog.generation,
    changed_at: '2026-08-05T00:00:00.000Z'
  });
  const status = desktopBridgeCatalogStatusV3(
    restarted,
    registry,
    policy,
    [],
    '2026-08-05T00:16:00.000Z'
  );
  assert.equal(status.state, 'stale');
  assert.equal(status.providers['codex-lb'].state, 'stale');
  assert.ok(status.blockers.includes('codex_lb_catalog_stale'));
});

test('R32/R34: staging a verified generation does not change the active binding', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-combined-staging-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, 'catalog.json');
  const routeIndexPath = path.join(root, 'route-index.json');
  const registry = await registryFixture();
  const first = buildCombinedBridgeCatalog(registry, {
    catalogs: catalogs(false),
    created_at: '2026-08-05T00:00:00.000Z'
  });
  const activated = await activateCombinedBridgeCatalog({ build: first, catalogPath, routeIndexPath });
  assert.equal(activated.activated, true, JSON.stringify(activated.blockers));
  const pointerBefore = await fs.readFile(activated.pointer_path, 'utf8');

  const next = buildCombinedBridgeCatalog(registry, {
    catalogs: catalogs(false, '-staged'),
    created_at: '2026-08-05T00:02:00.000Z'
  });
  const staged = await stageCombinedBridgeCatalog({ build: next, catalogPath, routeIndexPath });
  assert.equal(staged.staged, true, JSON.stringify(staged.blockers));
  assert.ok(staged.pointer_text);
  assert.notEqual(staged.pointer_text, pointerBefore);
  assert.equal(await fs.readFile(staged.pointer_path, 'utf8'), pointerBefore);

  const active = await readActiveCombinedBridgeCatalog(catalogPath, routeIndexPath);
  assert.equal(active.ok, true, JSON.stringify(active.blockers));
  assert.equal(active.catalog.generation, first.catalog.generation);
  assert.equal(active.route_index.generation, first.route_index.generation);
  assert.equal(await fs.access(staged.catalog_path!).then(() => true, () => false), true);
  assert.equal(await fs.access(staged.route_index_path!).then(() => true, () => false), true);
});
