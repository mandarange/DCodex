import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BRIDGE_ACTIVE_GENERATION_FILENAME,
  BRIDGE_ACTIVE_GENERATION_SCHEMA,
  type ActiveCombinedBridgeCatalogRead,
  type BridgeActiveGenerationPointer,
  type CombinedCatalogBuildResult,
  type CombinedCatalogStagingResult
} from './contracts.js';
import { safeErrorCode, unique } from './shared.js';
import {
  assertPrivateDirectory,
  catalogObservationGeneration,
  emptyCatalog,
  emptyRouteIndex,
  fsyncDirectory,
  generationBundleLayout,
  isPrivateRegular,
  readVerifiedPair,
  restoreSnapshot,
  snapshot,
  stagePrivateFile,
  verifyStagedPair
} from './storage.js';
import { writeTextAtomic } from '../../fsx.js';

/**
 * Persist and verify an immutable catalog/route-index generation without
 * changing the active pointer. Callers can commit pointer_text transactionally.
 */
export async function stageCombinedBridgeCatalog(input: {
  readonly build: CombinedCatalogBuildResult;
  readonly catalogPath: string;
  readonly routeIndexPath: string;
}): Promise<CombinedCatalogStagingResult> {
  const previous = await readActiveCombinedBridgeCatalog(input.catalogPath, input.routeIndexPath);
  const layout = generationBundleLayout(input.catalogPath, input.routeIndexPath, input.build);
  if (!layout.ok) {
    return stagingFailure(layout.pointerPath, previous, layout.blockers);
  }
  // Degraded generations remain valid when one isolated provider is ready;
  // conflict/no-ready builds are not activated.
  if (!input.build.ok) {
    return stagingFailure(
      layout.pointerPath,
      previous,
      unique(input.build.blockers.length > 0
        ? input.build.blockers
        : ['combined_catalog_build_not_verified'])
    );
  }
  const catalogText = `${JSON.stringify(input.build.catalog, null, 2)}\n`;
  const routeText = `${JSON.stringify(input.build.route_index, null, 2)}\n`;
  const tempBundle = `${layout.bundleDirectory}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tempCatalog = path.join(tempBundle, layout.catalogFilename);
  const tempRouteIndex = path.join(tempBundle, layout.routeIndexFilename);
  try {
    await fs.mkdir(layout.generationsRoot, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(layout.generationsRoot);
    await fs.mkdir(tempBundle, { recursive: false, mode: 0o700 });
    await Promise.all([
      stagePrivateFile(tempCatalog, catalogText),
      stagePrivateFile(tempRouteIndex, routeText)
    ]);
    await verifyStagedPair(
      tempCatalog,
      tempRouteIndex,
      input.build.catalog.generation,
      input.build.route_index.generation
    );
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
    const pointer: BridgeActiveGenerationPointer = {
      schema: BRIDGE_ACTIVE_GENERATION_SCHEMA,
      catalog_generation: input.build.catalog.generation,
      route_index_generation: input.build.route_index.generation,
      observation_generation: catalogObservationGeneration(input.build.catalog),
      bundle_directory: path.relative(layout.parentDirectory, layout.bundleDirectory),
      catalog_filename: layout.catalogFilename,
      route_index_filename: layout.routeIndexFilename
    };
    return {
      schema: 'sks.bridge-combined-catalog-staging.v1',
      staged: true,
      generation: input.build.catalog.generation,
      previous_generation: previous.ok ? previous.catalog.generation : null,
      catalog_path: layout.catalogPath,
      route_index_path: layout.routeIndexPath,
      pointer_path: layout.pointerPath,
      pointer_text: `${JSON.stringify(pointer, null, 2)}\n`,
      blockers: []
    };
  } catch (error) {
    return stagingFailure(
      layout.pointerPath,
      previous,
      [safeErrorCode(error, 'combined_catalog_staging_failed')]
    );
  } finally {
    await fs.rm(tempBundle, { recursive: true, force: true }).catch(() => undefined);
  }
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
  const staged = await stageCombinedBridgeCatalog(input);
  if (!staged.staged || !staged.pointer_text) {
    return activationResult(staged, false, null, staged.catalog_path, staged.route_index_path, staged.blockers);
  }
  const priorPointer = await snapshot(staged.pointer_path);
  try {
    await input.testHooks?.afterCatalogRename?.();
    await input.testHooks?.beforeRouteIndexRename?.();
    await writeTextAtomic(staged.pointer_path, staged.pointer_text, { mode: 0o600 });
    await fsyncDirectory(path.dirname(staged.pointer_path));
    const activated = await readActiveCombinedBridgeCatalog(input.catalogPath, input.routeIndexPath);
    if (!activated.ok
      || activated.catalog.generation !== input.build.catalog.generation
      || activated.route_index.generation !== input.build.route_index.generation) {
      throw new Error('combined_catalog_activation_verification_failed');
    }
    return activationResult(staged, true, staged.generation, staged.catalog_path, staged.route_index_path, []);
  } catch (error) {
    const rollbackBlockers: string[] = [];
    try {
      await restoreSnapshot(staged.pointer_path, priorPointer);
    } catch {
      rollbackBlockers.push('combined_catalog_previous_generation_restore_failed');
    }
    const restored = rollbackBlockers.length === 0
      ? await readActiveCombinedBridgeCatalog(input.catalogPath, input.routeIndexPath)
      : null;
    return activationResult(
      staged,
      false,
      null,
      restored?.ok ? restored.catalog_path : null,
      restored?.ok ? restored.route_index_path : null,
      unique([safeErrorCode(error, 'combined_catalog_activation_failed'), ...rollbackBlockers])
    );
  }
}

export async function readActiveCombinedBridgeCatalog(
  catalogPath: string,
  routeIndexPath: string
): Promise<ActiveCombinedBridgeCatalogRead> {
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
    if (pointer.schema !== BRIDGE_ACTIVE_GENERATION_SCHEMA) {
      throw new Error('combined_catalog_active_pointer_schema_invalid');
    }
    const generationsRoot = path.join(parentDirectory, '.sks-bridge-generations');
    const bundleDirectory = path.resolve(parentDirectory, pointer.bundle_directory);
    const expectedBundleDirectory = path.join(
      generationsRoot,
      pointer.observation_generation
        ? `${pointer.catalog_generation}.${pointer.route_index_generation}.${pointer.observation_generation}`
        : `${pointer.catalog_generation}.${pointer.route_index_generation}`
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

function stagingFailure(
  pointerPath: string,
  previous: ActiveCombinedBridgeCatalogRead,
  blockers: readonly string[]
): CombinedCatalogStagingResult {
  return {
    schema: 'sks.bridge-combined-catalog-staging.v1',
    staged: false,
    generation: null,
    previous_generation: previous.ok ? previous.catalog.generation : null,
    catalog_path: previous.ok ? previous.catalog_path : null,
    route_index_path: previous.ok ? previous.route_index_path : null,
    pointer_path: pointerPath,
    pointer_text: null,
    blockers
  };
}

function activationResult(
  staged: CombinedCatalogStagingResult,
  activated: boolean,
  generation: string | null,
  catalogPath: string | null,
  routeIndexPath: string | null,
  blockers: readonly string[]
) {
  return {
    schema: 'sks.bridge-combined-catalog-activation.v1' as const,
    activated,
    generation,
    previous_generation: staged.previous_generation,
    catalog_path: catalogPath,
    route_index_path: routeIndexPath,
    pointer_path: staged.pointer_path,
    blockers
  };
}
