/**
 * The extractor registry.
 *
 * The compiler takes extractors as an input rather than importing them, so this
 * is the one place that decides which deterministic extractors make up a
 * snapshot. Order does not matter — the compiler sorts by extractor id — but the
 * set does: adding one here changes the schema revision surface and therefore
 * the cache key, which is exactly the invalidation we want.
 */
import type { ContextGraphExtractor } from '../contracts.js';
import { createCodeGraphExtractor } from './code/index.js';
import type { CodeInventory } from './code/types.js';
import { createEvidenceGraphExtractor } from './evidence/index.js';
import { createSharedSourceInventory } from './source-inventory.js';
import { createTopologyGraphExtractor } from './topology/index.js';

export function contextGraphExtractors(): ContextGraphExtractor[] {
  const sourceInventory = createSharedSourceInventory();
  return [
    createCodeGraphExtractor({ sourceInventory }),
    createTopologyGraphExtractor({ sourceInventory }),
    createEvidenceGraphExtractor({ sourceInventory })
  ];
}

/**
 * Active TriWiki navigation registry.
 *
 * Align and code refresh must be reproducible from repository code bytes alone,
 * so they never load manifests, prior claims, proof cards, mission history, or
 * any other generated SKS state. The broader registry above remains available
 * to explicit benchmark/audit callers that evaluate topology and evidence.
 */
export function codeNavigationGraphExtractors(options: { preparedInventory?: CodeInventory } = {}): ContextGraphExtractor[] {
  return [createCodeGraphExtractor(options)];
}

/**
 * Architecture Map / Align publication registry.
 *
 * Extends code navigation with topology (commands/routes/gates/pipelines) and
 * evidence (claims/proofs) so Mermaid views that need those kinds are falsifiable.
 * Callers that still require a portable code-only index must keep using
 * `codeNavigationGraphExtractors()`.
 */
export function architectureMapGraphExtractors(options: { preparedInventory?: CodeInventory } = {}): ContextGraphExtractor[] {
  // One shared inventory: the code extractor emits file nodes from it, and
  // topology/evidence consult the same membership before referencing a `file:`
  // id, so every file node in the merged snapshot stays inside the inventory
  // that Align's exact-file-coverage invariant is keyed to.
  const sourceInventory = createSharedSourceInventory(options.preparedInventory ?? null);
  return [
    createCodeGraphExtractor({ sourceInventory }),
    createTopologyGraphExtractor({ sourceInventory }),
    createEvidenceGraphExtractor({ sourceInventory })
  ];
}

/**
 * Align publication registry. It keeps code, topology, and proof evidence, but
 * never reads the generated context pack that Align replaces from the graph.
 * Including that pack would make every successful publication stale against
 * the bytes it had just generated.
 */
export function alignGraphExtractors(options: { preparedInventory?: CodeInventory } = {}): ContextGraphExtractor[] {
  const sourceInventory = createSharedSourceInventory(options.preparedInventory ?? null);
  return [
    createCodeGraphExtractor({ sourceInventory }),
    createTopologyGraphExtractor({ sourceInventory }),
    createEvidenceGraphExtractor({ sourceInventory, includeContextPack: false })
  ];
}

/** Sorted extractor ids as persisted on Align ledgers / snapshot.extractors. */
export const ARCHITECTURE_MAP_EXTRACTOR_IDS = Object.freeze(['code', 'topology', 'triwiki-evidence'] as const);

export { createCodeGraphExtractor, createEvidenceGraphExtractor, createTopologyGraphExtractor };
