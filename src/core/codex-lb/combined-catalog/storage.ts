import fs from 'node:fs/promises';
import path from 'node:path';
import type { BridgeProviderId, BridgeRouteIndex, CatalogSyncState } from '../bridge-contracts.js';
import { buildBridgeRouteIndex, routeIndexMatchesGeneration, sha256Stable } from '../route-index.js';
import { writeTextAtomic } from '../../fsx.js';
import {
  BRIDGE_ACTIVE_GENERATION_FILENAME,
  COMBINED_BRIDGE_CATALOG_SCHEMA,
  type CombinedBridgeCatalogArtifact,
  type CombinedCatalogBuildResult,
  type GenerationBundleLayout
} from './contracts.js';
import { unique } from './shared.js';

export function generationBundleLayout(
  catalogPath: string,
  routeIndexPath: string,
  build: CombinedCatalogBuildResult
): GenerationBundleLayout {
  const resolvedCatalog = path.resolve(catalogPath);
  const resolvedRoute = path.resolve(routeIndexPath);
  const parentDirectory = path.dirname(resolvedCatalog);
  const generationsRoot = path.join(parentDirectory, '.sks-bridge-generations');
  const generationName = `${build.catalog.generation}.${build.route_index.generation}.${catalogObservationGeneration(build.catalog)}`;
  const bundleDirectory = path.join(generationsRoot, generationName);
  const catalogFilename = path.basename(resolvedCatalog);
  const routeIndexFilename = path.basename(resolvedRoute);
  const blockers = unique([
    ...(path.dirname(resolvedRoute) === parentDirectory ? [] : ['combined_catalog_paths_must_share_directory']),
    ...(catalogFilename !== routeIndexFilename ? [] : ['combined_catalog_paths_must_be_distinct']),
    ...(/^[a-f0-9]{64}\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(generationName) ? [] : ['combined_catalog_generation_invalid'])
  ]);
  return {
    ok: blockers.length === 0,
    parentDirectory,
    generationsRoot,
    bundleDirectory,
    catalogFilename,
    routeIndexFilename,
    catalogPath: path.join(bundleDirectory, catalogFilename),
    routeIndexPath: path.join(bundleDirectory, routeIndexFilename),
    pointerPath: path.join(parentDirectory, BRIDGE_ACTIVE_GENERATION_FILENAME),
    blockers
  };
}

export async function readVerifiedPair(catalogPath: string, routeIndexPath: string): Promise<{
  ok: true;
  catalog: CombinedBridgeCatalogArtifact;
  route_index: BridgeRouteIndex;
  blockers: readonly string[];
}> {
  const [catalogStat, routeStat] = await Promise.all([fs.lstat(catalogPath), fs.lstat(routeIndexPath)]);
  if (!isPrivateRegular(catalogStat) || !isPrivateRegular(routeStat)) {
    throw new Error('combined_catalog_active_file_insecure');
  }
  const [catalog, routeIndex] = await Promise.all([
    fs.readFile(catalogPath, 'utf8').then((text) => JSON.parse(text) as CombinedBridgeCatalogArtifact),
    fs.readFile(routeIndexPath, 'utf8').then((text) => JSON.parse(text) as BridgeRouteIndex)
  ]);
  const validCatalog = catalog.schema === COMBINED_BRIDGE_CATALOG_SCHEMA
    && catalog.digest === catalog.generation
    && sha256Stable({ models: catalog.models }) === catalog.digest
    && validProviderStatuses(catalog.provider_statuses);
  const validRoute = routeIndexMatchesGeneration(routeIndex, routeIndex.generation);
  const providerBindingsValid = validCatalog && (['codex-lb', 'openrouter'] as const).every((providerId) =>
    catalog.provider_statuses[providerId].generation === routeIndex.providers[providerId].catalog_generation);
  if (!validCatalog || !validRoute || !providerBindingsValid) {
    throw new Error('combined_catalog_active_generation_invalid');
  }
  return { ok: true, catalog, route_index: routeIndex, blockers: [] };
}

export async function stagePrivateFile(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function verifyStagedPair(
  catalogPath: string,
  routePath: string,
  catalogGeneration: string,
  routeGeneration: string
): Promise<void> {
  const [catalog, route] = await Promise.all([
    fs.readFile(catalogPath, 'utf8').then((text) => JSON.parse(text) as CombinedBridgeCatalogArtifact),
    fs.readFile(routePath, 'utf8').then((text) => JSON.parse(text) as BridgeRouteIndex)
  ]);
  if (catalog.generation !== catalogGeneration || route.generation !== routeGeneration) {
    throw new Error('combined_catalog_staged_generation_mismatch');
  }
  if (sha256Stable({ models: catalog.models }) !== catalog.digest
    || !routeIndexMatchesGeneration(route, routeGeneration)) {
    throw new Error('combined_catalog_staged_digest_mismatch');
  }
}

export async function snapshot(file: string): Promise<{ exists: boolean; text: string }> {
  try {
    return { exists: true, text: await fs.readFile(file, 'utf8') };
  } catch {
    return { exists: false, text: '' };
  }
}

export async function restoreSnapshot(
  file: string,
  prior: { exists: boolean; text: string }
): Promise<void> {
  if (prior.exists) await writeTextAtomic(file, prior.text, { mode: 0o600 });
  else await fs.rm(file, { force: true });
}

export async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function assertPrivateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || (expectedUid !== null && Number(stat.uid) !== expectedUid)
    || (process.platform !== 'win32' && (Number(stat.mode) & 0o777) !== 0o700)) {
    throw new Error('combined_catalog_generation_directory_insecure');
  }
}

export function isPrivateRegular(stat: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && (typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid())
    && (process.platform === 'win32' || (Number(stat.mode) & 0o777) === 0o600);
}

export function emptyCatalog(): CombinedBridgeCatalogArtifact {
  const digest = sha256Stable({ models: [] });
  return {
    schema: COMBINED_BRIDGE_CATALOG_SCHEMA,
    generation: digest,
    created_at: new Date(0).toISOString(),
    digest,
    models: [],
    provider_statuses: {
      'codex-lb': emptyProviderStatus('codex-lb'),
      openrouter: emptyProviderStatus('openrouter')
    }
  };
}

export function emptyRouteIndex(): BridgeRouteIndex {
  return buildBridgeRouteIndex({
    models: [],
    providers: {
      'codex-lb': { catalog_generation: null, credential_fingerprint: null, state: 'unknown' },
      openrouter: { catalog_generation: null, credential_fingerprint: null, state: 'unknown' }
    },
    created_at: new Date(0).toISOString()
  }).route_index;
}

export function catalogObservationGeneration(catalog: CombinedBridgeCatalogArtifact): string {
  return sha256Stable(catalog.provider_statuses);
}

function validProviderStatuses(value: unknown): value is Record<BridgeProviderId, CatalogSyncState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rows = value as Record<string, CatalogSyncState | undefined>;
  return (['codex-lb', 'openrouter'] as const).every((providerId) => {
    const row = rows[providerId];
    return Boolean(row
      && row.schema === 'sks.catalog-sync-state.v2'
      && row.provider_id === providerId
      && (row.expires_at === null || Number.isFinite(Date.parse(row.expires_at))));
  });
}

function emptyProviderStatus(providerId: BridgeProviderId): CatalogSyncState {
  return {
    schema: 'sks.catalog-sync-state.v2',
    provider_id: providerId,
    state: 'not_started',
    source: providerId === 'codex-lb' ? 'gateway' : 'openrouter',
    generation: null,
    digest: null,
    model_count: 0,
    checked_at: null,
    expires_at: null,
    blockers: [],
    warnings: [],
    recovery_action: null
  };
}
