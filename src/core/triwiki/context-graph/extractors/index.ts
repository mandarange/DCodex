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
import { createEvidenceGraphExtractor } from './evidence/index.js';
import { createTopologyGraphExtractor } from './topology/index.js';

export function contextGraphExtractors(): ContextGraphExtractor[] {
  return [createCodeGraphExtractor(), createTopologyGraphExtractor(), createEvidenceGraphExtractor()];
}

export { createCodeGraphExtractor, createEvidenceGraphExtractor, createTopologyGraphExtractor };
