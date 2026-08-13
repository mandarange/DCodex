/**
 * Shared source-inventory membership for one extractor registry.
 *
 * File-coverage contract: a `kind: 'file'` node may exist in a compiled
 * fragment only for a path present in the code source inventory
 * (`walkCodeInventory(root).files[].rel`) of the same compile — Align enforces
 * exactly that set equality before publishing. Extractors that discover paths
 * anywhere else (gate manifests, proof cards, context-pack citations, their own
 * filesystem walks) must consult this membership before minting a `file:` id,
 * and represent everything else with their own node kinds instead.
 *
 * One registry construction shares one lazily-computed inventory so a compile
 * whose code fragment was served from cache still walks at most once for the
 * remaining extractors.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ContextGraphExtractionLimits } from '../contracts.js';
import { walkCodeInventory } from './code/inventory.js';
import type { CodeInventory } from './code/types.js';

export interface SharedSourceInventory {
  /** Full inventory for the code extractor. Computed at most once per compile root. */
  inventory(root: string, limits: ContextGraphExtractionLimits): CodeInventory;
  /** Membership set for extractors that only gate `file` node minting. */
  sourcePaths(root: string, limits: ContextGraphExtractionLimits): ReadonlySet<string>;
}

/** Same normalization the code extractor uses, so all extractors share one walk. */
function canonicalRoot(root: string): string {
  const absolute = path.resolve(root);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * `prepared` is the caller-supplied inventory of the compile root (Align walks
 * it up front and hands it in); when present it is authoritative for every
 * root, exactly like the code extractor's existing `preparedInventory` option.
 */
export function createSharedSourceInventory(prepared: CodeInventory | null = null): SharedSourceInventory {
  let cachedRoot: string | null = null;
  let cachedInventory: CodeInventory | null = prepared;
  let cachedSet: { inventory: CodeInventory; set: ReadonlySet<string> } | null = null;

  const inventory = (root: string, limits: ContextGraphExtractionLimits): CodeInventory => {
    if (prepared) return prepared;
    const canonical = canonicalRoot(root);
    if (!cachedInventory || cachedRoot !== canonical) {
      cachedInventory = walkCodeInventory(canonical, limits);
      cachedRoot = canonical;
    }
    return cachedInventory;
  };

  const sourcePaths = (root: string, limits: ContextGraphExtractionLimits): ReadonlySet<string> => {
    const current = inventory(root, limits);
    if (!cachedSet || cachedSet.inventory !== current) {
      cachedSet = { inventory: current, set: new Set(current.files.map((file) => file.rel)) };
    }
    return cachedSet.set;
  };

  return { inventory, sourcePaths };
}
