import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  BridgeCatalogModel,
  BridgeProviderId,
  BridgeRouteIndex,
  CatalogSyncState,
  CombinedCatalogSyncStatus
} from './bridge-contracts.js';
import type { BridgeProviderRegistry } from './provider-registry.js';
import { normalizeCodexLbBridgeCatalogModels } from './codex-lb-tool-catalog.js';
import {
  buildBridgeRouteIndex,
  canonicalizeBridgeModelId,
  normalizeBridgeUpstreamModelId,
  routeIndexMatchesGeneration,
  sha256Stable
} from './route-index.js';
import { writeTextAtomic } from '../fsx.js';

export const COMBINED_BRIDGE_CATALOG_SCHEMA = 'sks.bridge-combined-catalog.v1' as const;
export const COMBINED_BRIDGE_CATALOG_FILENAME = 'sks-bridge-catalog.json' as const;
export const BRIDGE_ROUTE_INDEX_FILENAME = 'sks-bridge-route-index.json' as const;
export const BRIDGE_ACTIVE_GENERATION_SCHEMA = 'sks.bridge-active-generation.v1' as const;
export const BRIDGE_ACTIVE_GENERATION_FILENAME = 'sks-bridge-active-generation.json' as const;

interface BridgeActiveGenerationPointer {
  readonly schema: typeof BRIDGE_ACTIVE_GENERATION_SCHEMA;
  readonly catalog_generation: string;
  readonly route_index_generation: string;
  readonly bundle_directory: string;
  readonly catalog_filename: string;
  readonly route_index_filename: string;
}

export interface ProviderCatalogBuildInput {
  readonly provider_id: BridgeProviderId;
  readonly state: CatalogSyncState['state'];
  readonly generation: string | null;
  readonly models: unknown;
  readonly checked_at?: string | null;
  readonly expires_at?: string | null;
  readonly blockers?: readonly string[];
  readonly warnings?: readonly string[];
}

export interface CombinedBridgeCatalogArtifact {
  readonly schema: typeof COMBINED_BRIDGE_CATALOG_SCHEMA;
  readonly generation: string;
  readonly created_at: string;
  readonly digest: string;
  readonly models: readonly BridgeCatalogModel[];
}

export interface CombinedCatalogBuildResult {
  readonly schema: 'sks.bridge-combined-catalog-build.v1';
  readonly ok: boolean;
  readonly catalog: CombinedBridgeCatalogArtifact;
  readonly route_index: BridgeRouteIndex;
  readonly status: CombinedCatalogSyncStatus;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export function combinedBridgeCatalogPath(codexHome: string = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): string {
  return path.join(path.resolve(codexHome), 'sks', COMBINED_BRIDGE_CATALOG_FILENAME);
}

export function bridgeRouteIndexPath(codexHome: string = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): string {
  return path.join(path.resolve(codexHome), 'sks', BRIDGE_ROUTE_INDEX_FILENAME);
}

export function buildCombinedBridgeCatalog(
  registry: BridgeProviderRegistry,
  options: {
    readonly catalogs: Record<BridgeProviderId, ProviderCatalogBuildInput>;
    readonly created_at?: string;
  }
): CombinedCatalogBuildResult {
  const createdAt = options.created_at || new Date().toISOString();
  const normalized = {
    'codex-lb': normalizeProviderCatalog(options.catalogs['codex-lb']),
    openrouter: normalizeProviderCatalog(options.catalogs.openrouter)
  };
  const models = [...normalized['codex-lb'].models, ...normalized.openrouter.models]
    .sort(compareModels);
  const routeBuild = buildBridgeRouteIndex({
    models,
    providers: {
      'codex-lb': {
        catalog_generation: options.catalogs['codex-lb'].generation,
        credential_fingerprint: registry.profiles['codex-lb'].credential.fingerprint,
        state: routeProviderState(registry, options.catalogs['codex-lb'])
      },
      openrouter: {
        catalog_generation: options.catalogs.openrouter.generation,
        credential_fingerprint: registry.profiles.openrouter.credential.fingerprint,
        state: routeProviderState(registry, options.catalogs.openrouter)
      }
    },
    created_at: createdAt
  });
  const semanticCatalog = { models };
  const digest = sha256Stable(semanticCatalog);
  const catalog: CombinedBridgeCatalogArtifact = {
    schema: COMBINED_BRIDGE_CATALOG_SCHEMA,
    generation: digest,
    created_at: createdAt,
    digest,
    models
  };
  const blockers = unique([
    ...normalized['codex-lb'].blockers,
    ...normalized.openrouter.blockers,
    ...routeBuild.blockers
  ]);
  const enabledProviders = (['codex-lb', 'openrouter'] as const)
    .filter((providerId) => registry.profiles[providerId].enabled);
  const enabledReadyCount = enabledProviders.filter((providerId) =>
    normalized[providerId].state === 'verified' && normalized[providerId].models.length > 0).length;
  const conflicts = routeBuild.conflict_count;
  const state: CombinedCatalogSyncStatus['state'] = conflicts > 0 || enabledReadyCount === 0
    ? 'failed'
    : blockers.length > 0 || enabledReadyCount < enabledProviders.length
      ? 'degraded'
      : 'verified';
  const providerStatuses = {
    'codex-lb': providerCatalogStatus(options.catalogs['codex-lb'], normalized['codex-lb']),
    openrouter: providerCatalogStatus(options.catalogs.openrouter, normalized.openrouter)
  };
  const status: CombinedCatalogSyncStatus = {
    schema: 'sks.combined-catalog-sync.v1',
    state,
    generation: state === 'failed' ? null : catalog.generation,
    digest: state === 'failed' ? null : catalog.digest,
    model_count: models.length,
    route_count: routeBuild.route_count,
    conflict_count: conflicts,
    checked_at: createdAt,
    providers: providerStatuses,
    blockers,
    warnings: unique([
      ...normalized['codex-lb'].warnings,
      ...normalized.openrouter.warnings
    ]),
    recovery_action: conflicts > 0
      ? 'resolve_catalog_route_conflict'
      : state === 'failed'
        ? 'retry_catalog_sync'
        : null
  };
  return {
    schema: 'sks.bridge-combined-catalog-build.v1',
    ok: state !== 'failed',
    catalog,
    route_index: routeBuild.route_index,
    status,
    blockers,
    warnings: status.warnings
  };
}

export async function activateCombinedBridgeCatalog(input: {
  readonly build: CombinedCatalogBuildResult;
  readonly catalogPath: string;
  readonly routeIndexPath: string;
  readonly testHooks?: {
    readonly afterCatalogRename?: () => void | Promise<void>;
    readonly beforeRouteIndexRename?: () => void | Promise<void>;
  };
}): Promise<{
  readonly schema: 'sks.bridge-combined-catalog-activation.v1';
  readonly activated: boolean;
  readonly generation: string | null;
  readonly previous_generation: string | null;
  readonly catalog_path: string | null;
  readonly route_index_path: string | null;
  readonly pointer_path: string;
  readonly blockers: readonly string[];
}> {
  const previous = await readActiveCombinedBridgeCatalog(input.catalogPath, input.routeIndexPath);
  const layout = generationBundleLayout(input.catalogPath, input.routeIndexPath, input.build);
  if (!layout.ok) {
    return {
      schema: 'sks.bridge-combined-catalog-activation.v1',
      activated: false,
      generation: null,
      previous_generation: previous.ok ? previous.catalog.generation : null,
      catalog_path: previous.ok ? previous.catalog_path : null,
      route_index_path: previous.ok ? previous.route_index_path : null,
      pointer_path: layout.pointerPath,
      blockers: layout.blockers
    };
  }
  // A degraded build can still be a valid atomic generation when at least one
  // enabled provider produced a verified catalog. Provider-local failures stay
  // visible in status and must not prevent an active provider from routing.
  // Conflicts/no-ready-provider builds use ok=false and remain fail-closed.
  if (!input.build.ok) {
    return {
      schema: 'sks.bridge-combined-catalog-activation.v1',
      activated: false,
      generation: null,
      previous_generation: previous.ok ? previous.catalog.generation : null,
      catalog_path: previous.ok ? previous.catalog_path : null,
      route_index_path: previous.ok ? previous.route_index_path : null,
      pointer_path: layout.pointerPath,
      blockers: unique(input.build.blockers.length > 0 ? input.build.blockers : ['combined_catalog_build_not_verified'])
    };
  }
  const catalogText = `${JSON.stringify(input.build.catalog, null, 2)}\n`;
  const routeText = `${JSON.stringify(input.build.route_index, null, 2)}\n`;
  const tempBundle = `${layout.bundleDirectory}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tempCatalog = path.join(tempBundle, layout.catalogFilename);
  const tempRouteIndex = path.join(tempBundle, layout.routeIndexFilename);
  const priorPointer = await snapshot(layout.pointerPath);
  try {
    await fs.mkdir(layout.generationsRoot, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(layout.generationsRoot);
    await fs.mkdir(tempBundle, { recursive: false, mode: 0o700 });
    await Promise.all([
      stagePrivateFile(tempCatalog, catalogText),
      stagePrivateFile(tempRouteIndex, routeText)
    ]);
    await verifyStagedPair(tempCatalog, tempRouteIndex, input.build.catalog.generation, input.build.route_index.generation);
    await fsyncDirectory(tempBundle);
    const existingBundle = await fs.lstat(layout.bundleDirectory).catch(() => null);
    if (existingBundle) {
      if (!existingBundle.isDirectory() || existingBundle.isSymbolicLink()) {
        throw new Error('combined_catalog_generation_bundle_invalid');
      }
      await assertPrivateDirectory(layout.bundleDirectory);
      const existing = await readVerifiedPair(layout.catalogPath, layout.routeIndexPath);
      if (existing.catalog.generation !== input.build.catalog.generation
        || existing.route_index.generation !== input.build.route_index.generation) {
        throw new Error('combined_catalog_generation_bundle_mismatch');
      }
    } else {
      await fs.rename(tempBundle, layout.bundleDirectory);
      await fsyncDirectory(layout.generationsRoot);
    }
    await input.testHooks?.afterCatalogRename?.();
    await input.testHooks?.beforeRouteIndexRename?.();
    const pointer: BridgeActiveGenerationPointer = {
      schema: BRIDGE_ACTIVE_GENERATION_SCHEMA,
      catalog_generation: input.build.catalog.generation,
      route_index_generation: input.build.route_index.generation,
      bundle_directory: path.relative(layout.parentDirectory, layout.bundleDirectory),
      catalog_filename: layout.catalogFilename,
      route_index_filename: layout.routeIndexFilename
    };
    await writeTextAtomic(layout.pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, { mode: 0o600 });
    await fsyncDirectory(layout.parentDirectory);
    const activated = await readActiveCombinedBridgeCatalog(input.catalogPath, input.routeIndexPath);
    if (!activated.ok
      || activated.catalog.generation !== input.build.catalog.generation
      || activated.route_index.generation !== input.build.route_index.generation) {
      throw new Error('combined_catalog_activation_verification_failed');
    }
    return {
      schema: 'sks.bridge-combined-catalog-activation.v1',
      activated: true,
      generation: input.build.catalog.generation,
      previous_generation: previous.ok ? previous.catalog.generation : null,
      catalog_path: layout.catalogPath,
      route_index_path: layout.routeIndexPath,
      pointer_path: layout.pointerPath,
      blockers: []
    };
  } catch (error) {
    const rollbackBlockers: string[] = [];
    try {
      await restoreSnapshot(layout.pointerPath, priorPointer);
    } catch {
      rollbackBlockers.push('combined_catalog_previous_generation_restore_failed');
    }
    return {
      schema: 'sks.bridge-combined-catalog-activation.v1',
      activated: false,
      generation: null,
      previous_generation: previous.ok ? previous.catalog.generation : null,
      catalog_path: previous.ok ? previous.catalog_path : null,
      route_index_path: previous.ok ? previous.route_index_path : null,
      pointer_path: layout.pointerPath,
      blockers: unique([
        safeErrorCode(error, 'combined_catalog_activation_failed'),
        ...rollbackBlockers
      ])
    };
  } finally {
    await fs.rm(tempBundle, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function readActiveCombinedBridgeCatalog(
  catalogPath: string,
  routeIndexPath: string
): Promise<{
  readonly ok: boolean;
  readonly catalog: CombinedBridgeCatalogArtifact;
  readonly route_index: BridgeRouteIndex;
  readonly catalog_path: string | null;
  readonly route_index_path: string | null;
  readonly pointer_path: string;
  readonly blockers: readonly string[];
}> {
  const parentDirectory = path.dirname(path.resolve(catalogPath));
  const pointerPath = path.join(parentDirectory, BRIDGE_ACTIVE_GENERATION_FILENAME);
  try {
    if (path.dirname(path.resolve(routeIndexPath)) !== parentDirectory) {
      throw new Error('combined_catalog_paths_must_share_directory');
    }
    const pointerStat = await fs.lstat(pointerPath).catch(() => null);
    if (!pointerStat) {
      const direct = await readVerifiedPair(path.resolve(catalogPath), path.resolve(routeIndexPath));
      return {
        ...direct,
        catalog_path: path.resolve(catalogPath),
        route_index_path: path.resolve(routeIndexPath),
        pointer_path: pointerPath
      };
    }
    if (!isPrivateRegular(pointerStat)) throw new Error('combined_catalog_active_pointer_insecure');
    const pointer = JSON.parse(await fs.readFile(pointerPath, 'utf8')) as BridgeActiveGenerationPointer;
    if (pointer.schema !== BRIDGE_ACTIVE_GENERATION_SCHEMA) throw new Error('combined_catalog_active_pointer_schema_invalid');
    const generationsRoot = path.join(parentDirectory, '.sks-bridge-generations');
    const bundleDirectory = path.resolve(parentDirectory, pointer.bundle_directory);
    const expectedBundleDirectory = path.join(
      generationsRoot,
      `${pointer.catalog_generation}.${pointer.route_index_generation}`
    );
    if (bundleDirectory !== expectedBundleDirectory
      || !bundleDirectory.startsWith(`${generationsRoot}${path.sep}`)
      || pointer.catalog_filename !== path.basename(catalogPath)
      || pointer.route_index_filename !== path.basename(routeIndexPath)
      || path.dirname(path.resolve(bundleDirectory, pointer.catalog_filename)) !== bundleDirectory
      || path.dirname(path.resolve(bundleDirectory, pointer.route_index_filename)) !== bundleDirectory) {
      throw new Error('combined_catalog_active_pointer_path_invalid');
    }
    await assertPrivateDirectory(generationsRoot);
    await assertPrivateDirectory(bundleDirectory);
    const activeCatalogPath = path.join(bundleDirectory, pointer.catalog_filename);
    const activeRouteIndexPath = path.join(bundleDirectory, pointer.route_index_filename);
    const pair = await readVerifiedPair(activeCatalogPath, activeRouteIndexPath);
    if (pair.catalog.generation !== pointer.catalog_generation
      || pair.route_index.generation !== pointer.route_index_generation) {
      throw new Error('combined_catalog_active_pointer_generation_mismatch');
    }
    return {
      ...pair,
      catalog_path: activeCatalogPath,
      route_index_path: activeRouteIndexPath,
      pointer_path: pointerPath
    };
  } catch (error) {
    return {
      ok: false,
      catalog: emptyCatalog(),
      route_index: emptyRouteIndex(),
      catalog_path: null,
      route_index_path: null,
      pointer_path: pointerPath,
      blockers: [safeErrorCode(error, 'combined_catalog_active_generation_missing')]
    };
  }
}

function normalizeProviderCatalog(input: ProviderCatalogBuildInput): {
  state: CatalogSyncState['state'];
  models: BridgeCatalogModel[];
  blockers: string[];
  warnings: string[];
} {
  if (input.state !== 'verified') {
    return {
      state: input.state,
      models: [],
      blockers: unique([
        ...(input.blockers || []),
        ...(input.state === 'not_started' ? [] : [`${providerCode(input.provider_id)}_catalog_not_verified`])
      ]),
      warnings: unique(input.warnings || [])
    };
  }
  if (input.provider_id === 'codex-lb') {
    const normalized = normalizeCodexLbBridgeCatalogModels(
      normalizeCodexLbCatalogRows(input.models),
      input.generation || 'unknown'
    );
    return {
      state: input.state,
      models: normalized.models.map(canonicalModel).filter(isModel),
      blockers: unique([...(input.blockers || []), ...normalized.blockers]),
      warnings: unique(input.warnings || [])
    };
  }
  const rows = Array.isArray(input.models)
    ? input.models
    : Array.isArray((input.models as any)?.models)
      ? (input.models as any).models
      : Array.isArray((input.models as any)?.data)
        ? (input.models as any).data
        : [];
  const blockers = [...(input.blockers || [])];
  const models = rows.map((row: any) => {
    const sourceId = row?.id || row?.model || row?.slug || row?.name;
    const publicId = canonicalizeBridgeModelId(sourceId);
    const upstreamModel = normalizeBridgeUpstreamModelId(sourceId);
    if (!publicId || !upstreamModel) return null;
    const features = row?.features && typeof row.features === 'object' ? row.features : {};
    const capabilities = [
      ...(features.tools === true ? ['tools'] : []),
      ...(features.reasoning === true ? ['reasoning'] : []),
      ...(features.vision === true ? ['vision'] : []),
      ...(features.audio === true ? ['audio'] : [])
    ];
    return canonicalModel({
      public_id: publicId,
      provider_id: 'openrouter',
      upstream_model: upstreamModel,
      display_name: String(row?.name || publicId).trim(),
      supported_in_api: row?.supported_in_api !== false,
      capabilities,
      source_catalog_generation: input.generation || 'unknown',
      route_key: `openrouter:${publicId}`
    });
  }).filter(isModel);
  if (models.length === 0) blockers.push('openrouter_model_catalog_empty');
  return {
    state: input.state,
    models,
    blockers: unique(blockers),
    warnings: unique(input.warnings || [])
  };
}

function normalizeCodexLbCatalogRows(value: unknown): unknown {
  const rows = Array.isArray(value)
    ? value
    : Array.isArray((value as any)?.models)
      ? (value as any).models
      : Array.isArray((value as any)?.data)
        ? (value as any).data
        : [];
  return {
    models: rows.map((row: unknown) => typeof row === 'string'
      ? { id: row, slug: row, display_name: row, supported_in_api: true }
      : row)
  };
}

function routeProviderState(
  registry: BridgeProviderRegistry,
  catalog: ProviderCatalogBuildInput
): string {
  const profile = registry.profiles[catalog.provider_id];
  return profile.state === 'ready' && catalog.state === 'verified' ? 'ready' : catalog.state;
}

function providerCode(providerId: BridgeProviderId): string {
  return providerId === 'codex-lb' ? 'codex_lb' : 'openrouter';
}

function providerCatalogStatus(
  input: ProviderCatalogBuildInput,
  normalized: ReturnType<typeof normalizeProviderCatalog>
): CatalogSyncState {
  const semantic = { provider_id: input.provider_id, models: normalized.models };
  return {
    schema: 'sks.catalog-sync-state.v2',
    provider_id: input.provider_id,
    state: input.state,
    source: input.provider_id === 'codex-lb' ? 'gateway' : 'openrouter',
    generation: input.generation,
    digest: normalized.models.length > 0 ? sha256Stable(semantic) : null,
    model_count: normalized.models.length,
    checked_at: input.checked_at || null,
    expires_at: input.expires_at || null,
    blockers: normalized.blockers,
    warnings: normalized.warnings,
    recovery_action: normalized.blockers.length > 0 ? 'retry_catalog_sync' : null
  };
}

function canonicalModel(model: BridgeCatalogModel): BridgeCatalogModel | null {
  const publicId = canonicalizeBridgeModelId(model.public_id);
  const upstream = normalizeBridgeUpstreamModelId(model.upstream_model);
  if (!publicId || !upstream) return null;
  return {
    public_id: publicId,
    provider_id: model.provider_id,
    upstream_model: upstream,
    display_name: String(model.display_name || publicId).trim().slice(0, 240),
    supported_in_api: model.supported_in_api !== false,
    capabilities: unique(model.capabilities).sort(),
    source_catalog_generation: String(model.source_catalog_generation || 'unknown'),
    route_key: `${model.provider_id}:${publicId}`
  };
}

function isModel(value: BridgeCatalogModel | null): value is BridgeCatalogModel {
  return value !== null;
}

function generationBundleLayout(
  catalogPath: string,
  routeIndexPath: string,
  build: CombinedCatalogBuildResult
): {
  ok: boolean;
  parentDirectory: string;
  generationsRoot: string;
  bundleDirectory: string;
  catalogFilename: string;
  routeIndexFilename: string;
  catalogPath: string;
  routeIndexPath: string;
  pointerPath: string;
  blockers: string[];
} {
  const resolvedCatalog = path.resolve(catalogPath);
  const resolvedRoute = path.resolve(routeIndexPath);
  const parentDirectory = path.dirname(resolvedCatalog);
  const generationsRoot = path.join(parentDirectory, '.sks-bridge-generations');
  const generationName = `${build.catalog.generation}.${build.route_index.generation}`;
  const bundleDirectory = path.join(generationsRoot, generationName);
  const catalogFilename = path.basename(resolvedCatalog);
  const routeIndexFilename = path.basename(resolvedRoute);
  const blockers = unique([
    ...(path.dirname(resolvedRoute) === parentDirectory ? [] : ['combined_catalog_paths_must_share_directory']),
    ...(catalogFilename !== routeIndexFilename ? [] : ['combined_catalog_paths_must_be_distinct']),
    ...(/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(generationName) ? [] : ['combined_catalog_generation_invalid'])
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

async function readVerifiedPair(catalogPath: string, routeIndexPath: string): Promise<{
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
    && sha256Stable({ models: catalog.models }) === catalog.digest;
  const validRoute = routeIndexMatchesGeneration(routeIndex, routeIndex.generation);
  if (!validCatalog || !validRoute) throw new Error('combined_catalog_active_generation_invalid');
  return { ok: true, catalog, route_index: routeIndex, blockers: [] };
}

async function stagePrivateFile(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyStagedPair(
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
  if (sha256Stable({ models: catalog.models }) !== catalog.digest || !routeIndexMatchesGeneration(route, routeGeneration)) {
    throw new Error('combined_catalog_staged_digest_mismatch');
  }
}

async function snapshot(file: string): Promise<{ exists: boolean; text: string }> {
  try {
    return { exists: true, text: await fs.readFile(file, 'utf8') };
  } catch {
    return { exists: false, text: '' };
  }
}

async function restoreSnapshot(file: string, prior: { exists: boolean; text: string }): Promise<void> {
  if (prior.exists) await writeTextAtomic(file, prior.text, { mode: 0o600 });
  else await fs.rm(file, { force: true });
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || (expectedUid !== null && Number(stat.uid) !== expectedUid)
    || (process.platform !== 'win32' && (Number(stat.mode) & 0o777) !== 0o700)) {
    throw new Error('combined_catalog_generation_directory_insecure');
  }
}

function isPrivateRegular(stat: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && (typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid())
    && (process.platform === 'win32' || (Number(stat.mode) & 0o777) === 0o600);
}

function emptyCatalog(): CombinedBridgeCatalogArtifact {
  const digest = sha256Stable({ models: [] });
  return {
    schema: COMBINED_BRIDGE_CATALOG_SCHEMA,
    generation: digest,
    created_at: new Date(0).toISOString(),
    digest,
    models: []
  };
}

function emptyRouteIndex(): BridgeRouteIndex {
  return buildBridgeRouteIndex({
    models: [],
    providers: {
      'codex-lb': { catalog_generation: null, credential_fingerprint: null, state: 'unknown' },
      openrouter: { catalog_generation: null, credential_fingerprint: null, state: 'unknown' }
    },
    created_at: new Date(0).toISOString()
  }).route_index;
}

function safeErrorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || '');
  return /^[a-z0-9_:-]{1,160}$/i.test(message) ? message : fallback;
}

function compareModels(left: BridgeCatalogModel, right: BridgeCatalogModel): number {
  return left.public_id.localeCompare(right.public_id)
    || left.provider_id.localeCompare(right.provider_id)
    || left.upstream_model.localeCompare(right.upstream_model);
}

function unique(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}
