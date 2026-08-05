import os from 'node:os';
import path from 'node:path';

export {
  BRIDGE_ACTIVE_GENERATION_FILENAME,
  BRIDGE_ACTIVE_GENERATION_SCHEMA,
  BRIDGE_ROUTE_INDEX_FILENAME,
  COMBINED_BRIDGE_CATALOG_FILENAME,
  COMBINED_BRIDGE_CATALOG_SCHEMA,
  type CombinedBridgeCatalogArtifact,
  type CombinedCatalogBuildResult,
  type CombinedCatalogStagingResult,
  type ProviderCatalogBuildInput
} from './combined-catalog/contracts.js';
export { buildCombinedBridgeCatalog } from './combined-catalog/builder.js';
export {
  activateCombinedBridgeCatalog,
  readActiveCombinedBridgeCatalog,
  stageCombinedBridgeCatalog
} from './combined-catalog/persistence.js';

import {
  BRIDGE_ROUTE_INDEX_FILENAME,
  COMBINED_BRIDGE_CATALOG_FILENAME
} from './combined-catalog/contracts.js';

export function combinedBridgeCatalogPath(
  codexHome: string = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
): string {
  return path.join(path.resolve(codexHome), 'sks', COMBINED_BRIDGE_CATALOG_FILENAME);
}

export function bridgeRouteIndexPath(
  codexHome: string = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
): string {
  return path.join(path.resolve(codexHome), 'sks', BRIDGE_ROUTE_INDEX_FILENAME);
}
