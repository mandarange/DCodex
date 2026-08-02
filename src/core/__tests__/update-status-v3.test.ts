import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSksUpdateStatus } from '../update-check.js';
import {
  emptyUpdateStatus,
  readUpdateStatusCache,
  resetUpdateStatusCoordinatorForTests,
  resolveSksUpdateStatus,
  UpdateStatusRefreshError,
  type SksUpdateStatusV3
} from '../update/update-status.js';

test('update-status.v3 serves a fresh cache with deterministic TTL and jitter', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-status-fresh-'));
  const env = isolatedEnv(root);
  const at = new Date('2026-07-14T00:00:00.000Z');
  let fetches = 0;
  try {
    resetUpdateStatusCoordinatorForTests();
    const live = await resolveSksUpdateStatus({
      env,
      refresh: true,
      now: () => at,
      ttlMs: 6 * 60 * 60 * 1000,
      jitterMs: 3210,
      fallbackSnapshot: () => emptyUpdateStatus('6.2.0', at),
      fetchLive: async () => {
        fetches += 1;
        return snapshot('6.2.0', '6.3.0', at);
      }
    });
    assert.equal(live.source, 'live');
    assert.equal(Date.parse(live.expires_at) - Date.parse(live.generated_at), 6 * 60 * 60 * 1000 + 3210);

    const cached = await resolveSksUpdateStatus({
      env,
      refresh: false,
      now: () => new Date(at.getTime() + 1000),
      fallbackSnapshot: () => emptyUpdateStatus('0.0.0', at),
      fetchLive: async () => {
        fetches += 1;
        throw new Error('fresh cache must not refresh');
      }
    });
    assert.equal(cached.source, 'cache');
    assert.equal(cached.sks.latest, '6.3.0');
    assert.equal(fetches, 1);
  } finally {
    resetUpdateStatusCoordinatorForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('offline refresh preserves last-known versions and emits a redacted stale status', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-status-stale-'));
  const env = isolatedEnv(root);
  const at = new Date('2026-07-14T01:00:00.000Z');
  try {
    resetUpdateStatusCoordinatorForTests();
    await resolveSksUpdateStatus({
      env,
      refresh: true,
      now: () => at,
      ttlMs: 1000,
      jitterMs: 0,
      fallbackSnapshot: () => emptyUpdateStatus('6.2.0', at),
      fetchLive: async () => snapshot('6.2.0', '6.3.0', at)
    });
    const stale = await resolveSksUpdateStatus({
      env,
      refresh: false,
      now: () => new Date(at.getTime() + 2000),
      fallbackSnapshot: () => emptyUpdateStatus('0.0.0', at),
      fetchLive: async () => {
        throw new Error(`${root}/registry token=supersecret123456789 offline`);
      }
    });
    assert.equal(stale.source, 'stale');
    assert.equal(stale.sks.current, '6.2.0');
    assert.equal(stale.sks.latest, '6.3.0');
    assert.match(stale.public_error || '', /~\/registry/);
    assert.doesNotMatch(stale.public_error || '', /supersecret/);
    assert.match(stale.public_error || '', /\[redacted\]/);
    assert.ok(stale.warnings.includes('update_status_stale'));
  } finally {
    resetUpdateStatusCoordinatorForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('update status public_error reports the deepest redacted root cause', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-status-root-cause-'));
  const env = isolatedEnv(root);
  const at = new Date('2026-07-14T01:15:00.000Z');
  try {
    resetUpdateStatusCoordinatorForTests();
    const status = await resolveSksUpdateStatus({
      env,
      refresh: true,
      now: () => at,
      jitterMs: 0,
      fallbackSnapshot: () => emptyUpdateStatus('6.2.0', at),
      fetchLive: async () => {
        const rootCause = new Error(`${root}/config.toml token=deeply-secret-value is unreadable`);
        const middle = new Error('registry probe wrapper', { cause: rootCause });
        throw new Error('update refresh failed', { cause: middle });
      }
    });

    assert.equal(status.source, 'error');
    assert.match(status.public_error || '', /^~\/config\.toml/);
    assert.doesNotMatch(status.public_error || '', /update refresh failed|registry probe wrapper/);
    assert.doesNotMatch(status.public_error || '', /deeply-secret-value/);
    assert.match(status.public_error || '', /token=\[redacted\]/);
  } finally {
    resetUpdateStatusCoordinatorForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('offline refresh keeps fresh local observations while reusing only last-known remote versions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-status-local-refresh-'));
  const env = isolatedEnv(root);
  const cachedAt = new Date('2026-07-14T01:30:00.000Z');
  const refreshedAt = new Date('2026-07-14T02:00:00.000Z');
  try {
    resetUpdateStatusCoordinatorForTests();
    await resolveSksUpdateStatus({
      env,
      refresh: true,
      now: () => cachedAt,
      jitterMs: 0,
      fallbackSnapshot: () => emptyUpdateStatus('7.0.5', cachedAt),
      fetchLive: async () => snapshot('7.0.5', '7.2.0', cachedAt)
    });

    const observed = snapshot('7.1.0', '7.1.0', refreshedAt);
    observed.sks.latest = null;
    observed.codex_cli.current = '0.145.0';
    observed.codex_cli.latest = null;
    observed.menubar.expected_version = '7.1.0';
    observed.menubar.installed_version = '7.1.0';
    const stale = await resolveSksUpdateStatus({
      env,
      refresh: true,
      now: () => refreshedAt,
      jitterMs: 0,
      fallbackSnapshot: () => emptyUpdateStatus('7.1.0', refreshedAt),
      fetchLive: async () => {
        throw new UpdateStatusRefreshError('npm view failed', observed);
      }
    });

    assert.equal(stale.source, 'stale');
    assert.equal(stale.sks.current, '7.1.0');
    assert.equal(stale.sks.latest, '7.2.0');
    assert.equal(stale.sks.update_available, true);
    assert.equal(stale.codex_cli.current, '0.145.0');
    assert.equal(stale.codex_cli.latest, '0.144.0');
    assert.equal(stale.codex_cli.update_available, false);
    assert.equal(stale.menubar.installed_version, '7.1.0');
    assert.ok(stale.warnings.includes('update_status_refresh_observation_merged'));
    assert.equal((await readUpdateStatusCache(env))?.sks.current, '7.1.0');
  } finally {
    resetUpdateStatusCoordinatorForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('refresh is single-flight for the same status path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-status-flight-'));
  const env = isolatedEnv(root);
  const at = new Date('2026-07-14T02:00:00.000Z');
  const gate = deferred<void>();
  const started = deferred<void>();
  let fetches = 0;
  try {
    resetUpdateStatusCoordinatorForTests();
    const options = {
      env,
      refresh: true,
      now: () => at,
      jitterMs: 0,
      fallbackSnapshot: () => emptyUpdateStatus('6.2.0', at),
      fetchLive: async () => {
        fetches += 1;
        started.resolve();
        await gate.promise;
        return snapshot('6.2.0', '6.3.0', at);
      }
    };
    const first = resolveSksUpdateStatus(options);
    await started.promise;
    const second = resolveSksUpdateStatus(options);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(fetches, 1);
    assert.deepEqual(a, b);
  } finally {
    resetUpdateStatusCoordinatorForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a superseding refresh discards the older network response for every caller', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-status-race-'));
  const env = isolatedEnv(root);
  const at = new Date('2026-07-14T03:00:00.000Z');
  const requests = [deferred<SksUpdateStatusV3>(), deferred<SksUpdateStatusV3>()];
  let fetches = 0;
  const base = {
    env,
    refresh: true,
    now: () => at,
    jitterMs: 0,
    fallbackSnapshot: () => emptyUpdateStatus('6.2.0', at),
    fetchLive: async () => requests[fetches++]!.promise
  };
  try {
    resetUpdateStatusCoordinatorForTests();
    const first = resolveSksUpdateStatus(base);
    await waitFor(() => fetches === 1);
    const second = resolveSksUpdateStatus({ ...base, supersede: true });
    await waitFor(() => fetches === 2);
    requests[1]!.resolve(snapshot('6.2.0', '6.4.0', at));
    const newest = await second;
    requests[0]!.resolve(snapshot('6.2.0', '6.3.0', at));
    const superseded = await first;
    assert.equal(newest.sks.latest, '6.4.0');
    assert.equal(superseded.sks.latest, '6.4.0');
    assert.equal((await readUpdateStatusCache(env))?.sks.latest, '6.4.0');
  } finally {
    resetUpdateStatusCoordinatorForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('legacy notice and tmp caches migrate once into update-status.v3 and are removed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-status-migrate-'));
  const env = isolatedEnv(root);
  const legacyRoot = path.join(root, 'legacy-tmp');
  env.SKS_LEGACY_UPDATE_CHECK_CACHE_ROOT = legacyRoot;
  const noticePath = path.join(root, '.sneakoscope', 'cache', 'update-notice.json');
  const at = new Date('2026-07-14T04:00:00.000Z');
  try {
    await fs.mkdir(path.dirname(noticePath), { recursive: true });
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(noticePath, `${JSON.stringify({
      schema: 'sks.update-notice.v1',
      checked_at: '2026-07-13T20:00:00.000Z',
      current_version: '6.2.0',
      latest_version: '6.3.0'
    })}\n`);
    await fs.writeFile(path.join(legacyRoot, 'sneakoscope.json'), `${JSON.stringify({
      schema: 'sks.update-check-cache.v1',
      generated_at: '2026-07-13T23:00:00.000Z',
      latest: '6.4.0'
    })}\n`);
    resetUpdateStatusCoordinatorForTests();
    const migrated = await resolveSksUpdateStatus({
      env,
      refresh: false,
      now: () => at,
      fallbackSnapshot: () => emptyUpdateStatus('6.2.0', at),
      fetchLive: async () => { throw new Error('offline after migration'); }
    });
    assert.equal(migrated.schema, 'sks.update-status.v3');
    assert.equal(migrated.source, 'stale');
    assert.equal(migrated.sks.current, '6.2.0');
    assert.equal(migrated.sks.latest, '6.4.0');
    assert.ok(migrated.warnings.some((warning) => warning === 'legacy_update_cache_migrated:update-check-cache.v1'));
    await assert.rejects(fs.access(noticePath));
    await assert.rejects(fs.access(legacyRoot));
    assert.equal((await readUpdateStatusCache(env))?.schema, 'sks.update-status.v3');
  } finally {
    resetUpdateStatusCoordinatorForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SKS, Codex CLI, and Menu Bar update states remain independent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-status-domains-'));
  const env = isolatedEnv(root);
  env.SKS_INSTALLED_SKS_VERSION = '6.2.0';
  env.SKS_NPM_VIEW_SNEAKOSCOPE_VERSION = '6.3.0';
  try {
    resetUpdateStatusCoordinatorForTests();
    const result = await runSksUpdateStatus({
      currentVersion: '6.2.0',
      npmBin: null,
      env,
      refresh: true,
      jitterMs: 0,
      deps: {
        inspectCodexCliUpdateImpl: async () => ({
          schema: 'sks.codex-cli-update-status.v1',
          ok: true,
          status: 'update_available',
          installed: true,
          current_version: '0.144.0',
          latest_version: '0.145.0',
          update_available: true,
          update_method: 'npm',
          warnings: [],
          blockers: []
        } as any),
        inspectSksMenuBarStatusImpl: async () => ({
          installed: true,
          running: true,
          build_stamp: { package_version: '6.1.0' },
          signature: { checked: true, ok: true },
          resources: { checked: true, ok: false },
          warnings: [],
          blockers: []
        } as any)
      }
    });
    assert.equal(result.sks.update_available, true);
    assert.equal(result.codex_cli.update_available, true);
    assert.equal(result.menubar.signature_ok, true);
    assert.equal(result.menubar.resources_ok, false);
    assert.equal(result.menubar.rebuild_required, true);
    assert.equal(result.update_count, 3);
  } finally {
    resetUpdateStatusCoordinatorForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    SKS_UPDATE_STATUS_PATH: path.join(root, 'update-status.json')
  };
}

function snapshot(current: string, latest: string, at: Date): SksUpdateStatusV3 {
  return {
    schema: 'sks.update-status.v3',
    generated_at: at.toISOString(),
    expires_at: at.toISOString(),
    source: 'live',
    sks: {
      installed: true,
      current,
      latest,
      update_available: true,
      channel: 'stable',
      package_source: 'test'
    },
    codex_cli: {
      installed: true,
      current: '0.144.0',
      latest: '0.144.0',
      update_available: false,
      update_method: 'npm'
    },
    menubar: {
      installed: true,
      running: true,
      expected_version: current,
      installed_version: current,
      signature_ok: true,
      resources_ok: true,
      rebuild_required: false
    },
    update_count: 1,
    warnings: [],
    public_error: null
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not reached');
}
