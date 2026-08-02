import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../fsx.js';
import { compareSemVer, isSemVerUpdateAvailable } from './semver.js';
import { publicUpdateError } from './update-diagnostics.js';

export const SKS_UPDATE_STATUS_SCHEMA = 'sks.update-status.v3' as const;
export const DEFAULT_UPDATE_STATUS_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_UPDATE_STATUS_JITTER_MS = 15 * 60 * 1000;

export interface SksUpdateStatusV3 {
  schema: typeof SKS_UPDATE_STATUS_SCHEMA;
  generated_at: string;
  expires_at: string;
  source: 'live' | 'cache' | 'stale' | 'disabled' | 'error';
  sks: {
    installed: boolean;
    current: string | null;
    latest: string | null;
    update_available: boolean;
    channel: 'stable' | 'beta';
    package_source: string | null;
  };
  codex_cli: {
    installed: boolean;
    current: string | null;
    latest: string | null;
    update_available: boolean;
    update_method: string | null;
  };
  menubar: {
    installed: boolean;
    running: boolean;
    expected_version: string;
    installed_version: string | null;
    signature_ok: boolean | null;
    resources_ok: boolean | null;
    rebuild_required: boolean;
  };
  update_count: number;
  warnings: string[];
  public_error: string | null;
}

export interface ResolveUpdateStatusOptions {
  env?: NodeJS.ProcessEnv;
  refresh?: boolean;
  supersede?: boolean;
  now?: () => Date;
  ttlMs?: number;
  jitterMs?: number;
  fetchLive: () => Promise<SksUpdateStatusV3>;
  fallbackSnapshot: () => SksUpdateStatusV3;
}

interface RefreshState {
  generation: number;
  inFlight: Promise<SksUpdateStatusV3> | null;
}

const refreshStates = new Map<string, RefreshState>();

export class UpdateStatusRefreshError extends Error {
  constructor(message: string, readonly fallbackSnapshot?: SksUpdateStatusV3) {
    super(message);
  }
}

export function updateStatusCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.SKS_UPDATE_STATUS_PATH || '').trim();
  if (explicit) return path.resolve(explicit);
  const compatibilityRoot = String(env.SKS_UPDATE_CHECK_CACHE_ROOT || '').trim();
  if (compatibilityRoot) return path.join(path.resolve(compatibilityRoot), 'update-status.json');
  const globalRoot = String(env.SKS_GLOBAL_ROOT || '').trim();
  if (globalRoot) return path.join(path.resolve(globalRoot), 'cache', 'update-status.json');
  return path.join(env.HOME || os.homedir(), '.sneakoscope-global', 'cache', 'update-status.json');
}

export async function readUpdateStatusCache(env: NodeJS.ProcessEnv = process.env): Promise<SksUpdateStatusV3 | null> {
  const value = await readJson<SksUpdateStatusV3 | null>(updateStatusCachePath(env), null).catch(() => null);
  return isUpdateStatus(value) ? value : null;
}

export async function resolveSksUpdateStatus(options: ResolveUpdateStatusOptions): Promise<SksUpdateStatusV3> {
  const env = options.env || process.env;
  const cachePath = updateStatusCachePath(env);
  const now = options.now || (() => new Date());
  let cached = await readUpdateStatusCache(env);
  if (!cached) cached = await migrateLegacyUpdateCaches({ env, fallbackSnapshot: options.fallbackSnapshot, now }).catch(() => null);
  if (updateChecksDisabled(env)) {
    const disabled = withResponseSource(cached || options.fallbackSnapshot(), 'disabled', null, now());
    await writeJsonAtomic(cachePath, disabled).catch(() => undefined);
    return disabled;
  }
  if (cached && options.refresh !== true && isFresh(cached, now())) return withResponseSource(cached, 'cache');

  const state = refreshStates.get(cachePath) || { generation: 0, inFlight: null };
  refreshStates.set(cachePath, state);
  if (state.inFlight && options.supersede !== true) return state.inFlight;
  const generation = state.generation + 1;
  state.generation = generation;
  let work!: Promise<SksUpdateStatusV3>;
  work = (async () => {
    try {
      const live = await options.fetchLive();
      const completedAt = now();
      const snapshot = normalizeLiveSnapshot(live, completedAt, ttlMs(options, env), jitterMs(options, env));
      if (state.generation === generation) {
        await writeJsonAtomic(cachePath, snapshot);
        return snapshot;
      }
      return await authoritativeSupersedingResult(state, work, env, snapshot);
    } catch (error) {
      const refreshFallback = error instanceof UpdateStatusRefreshError ? error.fallbackSnapshot : null;
      const fallback = cached && refreshFallback
        ? mergeRefreshFailureSnapshot(cached, refreshFallback)
        : cached || refreshFallback || options.fallbackSnapshot();
      const failedAt = now();
      const source = cached ? 'stale' : 'error';
      const failed = cached
        ? withResponseSource(fallback, source, publicError(error, env))
        : withResponseSource(fallback, source, publicError(error, env), failedAt);
      if (state.generation === generation) {
        await writeJsonAtomic(cachePath, failed).catch(() => undefined);
        return failed;
      }
      return await authoritativeSupersedingResult(state, work, env, failed);
    } finally {
      if (state.inFlight === work) state.inFlight = null;
    }
  })();
  state.inFlight = work;
  return work;
}

export async function persistKnownUpdateStatus(input: {
  env?: NodeJS.ProcessEnv;
  currentVersion: string;
  latestVersion?: string | null;
  packageName?: string;
  error?: string | null;
  now?: () => Date;
}): Promise<SksUpdateStatusV3> {
  const env = input.env || process.env;
  const now = input.now ? input.now() : new Date();
  const existing = await readUpdateStatusCache(env);
  const base = existing || emptyUpdateStatus(input.currentVersion, now);
  const latest = input.latestVersion || null;
  const next: SksUpdateStatusV3 = {
    ...base,
    generated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + DEFAULT_UPDATE_STATUS_TTL_MS).toISOString(),
    source: input.error ? 'error' : 'cache',
    sks: {
      ...base.sks,
      installed: true,
      current: input.currentVersion,
      latest,
      update_available: isSemVerUpdateAvailable(latest, input.currentVersion),
      package_source: input.packageName || base.sks.package_source
    },
    warnings: unique([...base.warnings, ...(input.error ? ['update_status_persisted_with_error'] : [])]),
    public_error: input.error ? publicError(input.error, env) : null,
    update_count: 0
  };
  next.update_count = countUpdates(next);
  await writeJsonAtomic(updateStatusCachePath(env), next);
  return next;
}

export function emptyUpdateStatus(expectedVersion: string, now = new Date()): SksUpdateStatusV3 {
  return {
    schema: SKS_UPDATE_STATUS_SCHEMA,
    generated_at: now.toISOString(),
    expires_at: now.toISOString(),
    source: 'error',
    sks: {
      installed: Boolean(expectedVersion), current: expectedVersion || null, latest: null,
      update_available: false, channel: 'stable', package_source: null
    },
    codex_cli: {
      installed: false, current: null, latest: null, update_available: false, update_method: null
    },
    menubar: {
      installed: false, running: false, expected_version: expectedVersion,
      installed_version: null, signature_ok: null, resources_ok: null, rebuild_required: true
    },
    update_count: 1,
    warnings: [],
    public_error: null
  };
}

export function countUpdates(snapshot: Pick<SksUpdateStatusV3, 'sks' | 'codex_cli' | 'menubar'>): number {
  return Number(snapshot.sks.update_available)
    + Number(snapshot.codex_cli.update_available)
    + Number(snapshot.menubar.rebuild_required);
}

export function resetUpdateStatusCoordinatorForTests(): void {
  refreshStates.clear();
}

async function migrateLegacyUpdateCaches(input: {
  env: NodeJS.ProcessEnv;
  fallbackSnapshot: () => SksUpdateStatusV3;
  now: () => Date;
}): Promise<SksUpdateStatusV3 | null> {
  const home = input.env.HOME || os.homedir();
  const noticePath = path.join(home, '.sneakoscope', 'cache', 'update-notice.json');
  const configuredLegacyRoot = String(input.env.SKS_LEGACY_UPDATE_CHECK_CACHE_ROOT || '').trim();
  const compatibilityRoot = String(input.env.SKS_UPDATE_CHECK_CACHE_ROOT || '').trim();
  const legacyRoots = unique([
    configuredLegacyRoot ? path.resolve(configuredLegacyRoot) : '',
    compatibilityRoot ? path.resolve(compatibilityRoot) : '',
    path.join(os.tmpdir(), 'sks-update-check-cache')
  ]);
  const candidates: Array<{ at: number; current: string | null; latest: string | null; source: string }> = [];
  const migratedFiles: string[] = [];
  const notice = await readJson<any>(noticePath, null).catch(() => null);
  if (notice?.schema === 'sks.update-notice.v1') {
    candidates.push({
      at: parsedTime(notice.checked_at),
      current: validVersion(notice.current_version),
      latest: validVersion(notice.latest_version),
      source: 'update-notice.v1'
    });
    migratedFiles.push(noticePath);
  }
  for (const legacyRoot of legacyRoots) {
    const legacyFiles = await fs.readdir(legacyRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of legacyFiles) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(legacyRoot, entry.name);
      const value = await readJson<any>(file, null).catch(() => null);
      if (value?.schema !== 'sks.update-check-cache.v1') continue;
      candidates.push({
        at: parsedTime(value.generated_at),
        current: null,
        latest: validVersion(value.latest),
        source: 'update-check-cache.v1'
      });
      migratedFiles.push(file);
    }
  }
  if (!candidates.length) return null;
  const selected = candidates.sort((left, right) => right.at - left.at)[0]!;
  const base = input.fallbackSnapshot();
  const current = selected.current || base.sks.current;
  const generated = Number.isFinite(selected.at) && selected.at > 0 ? new Date(selected.at) : input.now();
  const migrated: SksUpdateStatusV3 = {
    ...base,
    generated_at: generated.toISOString(),
    expires_at: generated.toISOString(),
    source: 'stale',
    sks: {
      ...base.sks,
      current,
      latest: selected.latest,
      update_available: isSemVerUpdateAvailable(selected.latest, current)
    },
    warnings: unique([...base.warnings, `legacy_update_cache_migrated:${selected.source}`]),
    public_error: null,
    update_count: 0
  };
  migrated.update_count = countUpdates(migrated);
  await writeJsonAtomic(updateStatusCachePath(input.env), migrated);
  await Promise.all(migratedFiles.map((file) => fs.rm(file, { force: true }).catch(() => undefined)));
  await Promise.all(legacyRoots.map((root) => fs.rmdir(root).catch(() => undefined)));
  return migrated;
}

function normalizeLiveSnapshot(snapshot: SksUpdateStatusV3, now: Date, ttl: number, jitter: number): SksUpdateStatusV3 {
  const normalized: SksUpdateStatusV3 = {
    ...snapshot,
    schema: SKS_UPDATE_STATUS_SCHEMA,
    generated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl + jitter).toISOString(),
    source: 'live',
    warnings: unique(snapshot.warnings || []),
    public_error: null,
    update_count: 0
  };
  normalized.update_count = countUpdates(normalized);
  return normalized;
}

function mergeRefreshFailureSnapshot(cached: SksUpdateStatusV3, observed: SksUpdateStatusV3): SksUpdateStatusV3 {
  const sksLatest = observed.sks.latest || cached.sks.latest;
  const codexLatest = observed.codex_cli.latest || cached.codex_cli.latest;
  const merged: SksUpdateStatusV3 = {
    ...observed,
    sks: {
      ...observed.sks,
      latest: sksLatest,
      update_available: isSemVerUpdateAvailable(sksLatest, observed.sks.current),
      package_source: observed.sks.package_source || cached.sks.package_source
    },
    codex_cli: {
      ...observed.codex_cli,
      latest: codexLatest,
      update_available: isSemVerUpdateAvailable(codexLatest, observed.codex_cli.current),
      update_method: observed.codex_cli.update_method || cached.codex_cli.update_method
    },
    warnings: unique([
      ...cached.warnings,
      ...observed.warnings,
      'update_status_refresh_observation_merged'
    ]),
    update_count: 0
  };
  merged.update_count = countUpdates(merged);
  return merged;
}

function withResponseSource(
  snapshot: SksUpdateStatusV3,
  source: SksUpdateStatusV3['source'],
  error: string | null = snapshot.public_error,
  now?: Date
): SksUpdateStatusV3 {
  return {
    ...snapshot,
    ...(now ? { generated_at: now.toISOString(), expires_at: now.toISOString() } : {}),
    source,
    warnings: unique([...snapshot.warnings, ...(source === 'stale' ? ['update_status_stale'] : [])]),
    public_error: error
  };
}

function isFresh(snapshot: SksUpdateStatusV3, now: Date): boolean {
  const expires = Date.parse(snapshot.expires_at);
  return Number.isFinite(expires) && expires > now.getTime();
}

async function authoritativeSupersedingResult(
  state: RefreshState,
  staleWork: Promise<SksUpdateStatusV3>,
  env: NodeJS.ProcessEnv,
  fallback: SksUpdateStatusV3
): Promise<SksUpdateStatusV3> {
  const current = state.inFlight;
  if (current && current !== staleWork) return current;
  return await readUpdateStatusCache(env) || fallback;
}

function isUpdateStatus(value: unknown): value is SksUpdateStatusV3 {
  const row = value as Partial<SksUpdateStatusV3> | null;
  return row?.schema === SKS_UPDATE_STATUS_SCHEMA
    && typeof row.generated_at === 'string'
    && typeof row.expires_at === 'string'
    && Boolean(row.sks && row.codex_cli && row.menubar)
    && Array.isArray(row.warnings);
}

function ttlMs(options: ResolveUpdateStatusOptions, env: NodeJS.ProcessEnv): number {
  return positiveInt(options.ttlMs ?? env.SKS_UPDATE_STATUS_TTL_MS, DEFAULT_UPDATE_STATUS_TTL_MS);
}

function jitterMs(options: ResolveUpdateStatusOptions, env: NodeJS.ProcessEnv): number {
  const explicit = options.jitterMs ?? (env.SKS_UPDATE_STATUS_JITTER_MS === undefined ? null : env.SKS_UPDATE_STATUS_JITTER_MS);
  if (explicit !== null && explicit !== undefined) return boundedInt(explicit, 0, MAX_UPDATE_STATUS_JITTER_MS);
  return Math.floor(Math.random() * (MAX_UPDATE_STATUS_JITTER_MS + 1));
}

function updateChecksDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.SKS_DISABLE_UPDATE_CHECK === '1'
    || env.SKS_DISABLE_UPDATE_NOTICE === '1'
    || env.SKS_UPDATE_NOTICE_DISABLE === '1'
    || env.SKS_UPDATE_NOTICE === '0';
}

function publicError(error: unknown, env: NodeJS.ProcessEnv): string {
  return publicUpdateError(error, env);
}

function parsedTime(value: unknown): number {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function validVersion(value: unknown): string | null {
  const text = typeof value === 'string' ? value : '';
  return compareSemVer(text, text) === 0 ? text : null;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function boundedInt(value: unknown, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
