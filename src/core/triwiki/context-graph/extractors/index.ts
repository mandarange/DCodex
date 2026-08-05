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
import { createTopologyGraphExtractor } from './topology/index.js';

export function contextGraphExtractors(): ContextGraphExtractor[] {
  return [createCodeGraphExtractor(), createTopologyGraphExtractor(), createEvidenceGraphExtractor()];
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

export { createCodeGraphExtractor, createEvidenceGraphExtractor, createTopologyGraphExtractor };
