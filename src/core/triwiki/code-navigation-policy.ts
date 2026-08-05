import type { ContextGraphExtractionLimits, ContextGraphSkip } from './context-graph/contracts.js';
import {
  computeSourceOnlyContextGraphCacheKey,
  type ExtractorIdentity
} from './context-graph/compiler/cache-key.js';
import {
  walkCodeInventory
} from './context-graph/extractors/code/inventory.js';

export const CODE_NAVIGATION_LIMITS: ContextGraphExtractionLimits = Object.freeze({
  maxFiles: 100_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxNodes: 250_000,
  maxEdges: 1_000_000,
  timeoutMs: 5 * 60_000,
  maxEntries: 400_000,
  maxDepth: 256
});

export const CODE_NAVIGATION_FATAL_SKIP_REASONS = new Set<ContextGraphSkip['reason']>([
  'binary',
  'oversized',
  'unsupported_language',
  'symlink_escape',
  'unreadable',
  'cap_reached'
]);

export function codeInventoryInputHashes(
  inventory: ReturnType<typeof walkCodeInventory>
): Record<string, string> {
  return Object.fromEntries(inventory.files.map((file) => [file.rel, file.hash]));
}

export async function inspectCodeNavigationSources(
  root: string,
  extractors: readonly ExtractorIdentity[],
  limits: ContextGraphExtractionLimits = CODE_NAVIGATION_LIMITS
) {
  const inventory = walkCodeInventory(root, limits);
  const inputHashes = codeInventoryInputHashes(inventory);
  const cacheKey = await computeSourceOnlyContextGraphCacheKey({ root, extractors, inputHashes });
  const fatalSkips = inventory.skipped.filter((skip) => CODE_NAVIGATION_FATAL_SKIP_REASONS.has(skip.reason));
  return {
    inventory,
    inputHashes,
    inventoryDigest: cacheKey.parts.sourceInventoryHash || '',
    cacheKey,
    fatalSkips
  };
}
