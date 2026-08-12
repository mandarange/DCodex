/**
 * The unit of incremental work: one extractor's output for one source file.
 *
 * v1 extractors return a single fragment per extractor covering the whole
 * workspace, which makes "reuse what did not change" impossible — the smallest
 * thing you can keep is everything. CG2 narrows the unit to
 * `(extractor, sourcePath)`, and that narrowing is what the manifest indexes.
 *
 * Three rules travel with the type:
 *
 * - **Every requested source gets a fragment, including an empty one.** An
 *   extractor that has nothing to say about `README.md` still says so, otherwise
 *   that file looks new on every run and no build is ever a no-op.
 * - **`dependencyKeys` is the declared read set**, not a guess at relevance.
 *   Anything whose bytes the extraction consulted belongs in it; anything else
 *   does not. Under-declaring keeps stale fragments alive, over-declaring just
 *   costs work.
 * - **The fragment hash excludes `observedAt`.** It is a wall clock, and a
 *   content address that moved with the clock would make every rebuild look like
 *   a change and defeat the whole mechanism.
 */
import { sha256 } from '../../../fsx.js';
import { compareContextGraphIds } from '../ids.js';
import type { ContextGraphEdge, ContextGraphNode } from '../contracts.js';
import { orderedEdge, orderedNode, sortContextGraphEdges, sortContextGraphNodes } from './serialize.js';
import {
  CONTEXT_FRAGMENT_MANIFEST_FIELD,
  buildFragmentManifestEntry,
  requireDependencyKeys,
  requireExtractorId,
  requireManifestHash,
  requireManifestRevision,
  requireSourcePath,
  type FragmentManifestEntry,
} from './fragment-manifest-schema.js';

export const CONTEXT_SOURCE_FRAGMENT_SCHEMA = 'sks.context-graph-source-fragment.v1' as const;

export interface ContextGraphSourceFragment {
  readonly schema: typeof CONTEXT_SOURCE_FRAGMENT_SCHEMA;
  readonly extractor: string;
  readonly extractorRevision: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  /** Sorted, unique, workspace-relative: every other file this extraction read. */
  readonly dependencyKeys: readonly string[];
  readonly nodes: readonly ContextGraphNode[];
  readonly edges: readonly ContextGraphEdge[];
}

export interface ContextGraphSourceFragmentInput {
  readonly extractor: string;
  readonly extractorRevision: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly dependencyKeys?: readonly string[] | undefined;
  readonly nodes?: readonly ContextGraphNode[] | undefined;
  readonly edges?: readonly ContextGraphEdge[] | undefined;
}

export interface ContextGraphSourceExtractionRequest {
  readonly root: string;
  /** Exactly the sources the planner decided are not reusable, sorted. */
  readonly sourcePaths: readonly string[];
  readonly observedAt: string;
}

/**
 * Injected, never imported by the compiler: the compiler must not know which
 * extractors exist, and must never load workspace code to find out.
 */
export interface ContextGraphSourceExtractor {
  readonly id: string;
  readonly revision: string;
  extractSources(request: ContextGraphSourceExtractionRequest): Promise<readonly ContextGraphSourceFragment[]>;
}

/** Normalizing constructor: ordering is forced here so the content hash cannot depend on emit order. */
export function buildSourceFragment(input: ContextGraphSourceFragmentInput): ContextGraphSourceFragment {
  return Object.freeze({
    schema: CONTEXT_SOURCE_FRAGMENT_SCHEMA,
    extractor: requireExtractorId(input.extractor),
    extractorRevision: requireManifestRevision(input.extractorRevision, CONTEXT_FRAGMENT_MANIFEST_FIELD.extractorRevision),
    sourcePath: requireSourcePath(input.sourcePath, CONTEXT_FRAGMENT_MANIFEST_FIELD.sourcePath),
    sourceHash: requireManifestHash(input.sourceHash, CONTEXT_FRAGMENT_MANIFEST_FIELD.sourceHash),
    dependencyKeys: requireDependencyKeys(input.dependencyKeys, false),
    nodes: Object.freeze(sortContextGraphNodes(input.nodes ?? []).map(orderedNode)),
    edges: Object.freeze(sortContextGraphEdges(input.edges ?? []).map((edge) => orderedEdge(edge))),
  });
}

export function emptySourceFragment(
  extractor: string,
  revision: string,
  sourcePath: string,
  sourceHash: string,
): ContextGraphSourceFragment {
  return buildSourceFragment({ extractor, extractorRevision: revision, sourcePath, sourceHash });
}

/**
 * Content address of a fragment. Identity fields are included so a payload
 * cannot be silently reused under a different extractor or a different source,
 * and `observedAt` is stripped so the address stays clock-independent.
 */
export function sourceFragmentContentHash(fragment: ContextGraphSourceFragment): string {
  return sha256(
    JSON.stringify({
      schema: CONTEXT_SOURCE_FRAGMENT_SCHEMA,
      extractor: fragment.extractor,
      extractorRevision: fragment.extractorRevision,
      sourcePath: fragment.sourcePath,
      sourceHash: fragment.sourceHash,
      dependencyKeys: [...fragment.dependencyKeys],
      nodes: sortContextGraphNodes(fragment.nodes).map(orderedNode),
      edges: sortContextGraphEdges(fragment.edges).map((edge) => orderedEdge(edge, false)),
    }),
  );
}

export function manifestEntryFromSourceFragment(fragment: ContextGraphSourceFragment): FragmentManifestEntry {
  return buildFragmentManifestEntry({
    extractor: fragment.extractor,
    extractorRevision: fragment.extractorRevision,
    sourcePath: fragment.sourcePath,
    sourceHash: fragment.sourceHash,
    fragmentHash: sourceFragmentContentHash(fragment),
    dependencyKeys: fragment.dependencyKeys,
    nodeCount: fragment.nodes.length,
    edgeCount: fragment.edges.length,
  });
}

/** Fragments in a total, stable order: the k-way merge's source order comes from here. */
export function compareSourceFragments(
  left: ContextGraphSourceFragment,
  right: ContextGraphSourceFragment,
): number {
  const byExtractor = compareContextGraphIds(left.extractor, right.extractor);
  return byExtractor !== 0 ? byExtractor : compareContextGraphIds(left.sourcePath, right.sourcePath);
}

export function sortSourceFragments(
  fragments: readonly ContextGraphSourceFragment[],
): ContextGraphSourceFragment[] {
  return [...fragments].sort(compareSourceFragments);
}

/**
 * Strict decode of a persisted payload. A cached fragment is the one input that
 * skips extraction entirely, so it is re-validated and re-addressed before it is
 * allowed to stand in for work that did not run.
 */
export function parseSourceFragment(raw: unknown): ContextGraphSourceFragment | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.schema !== CONTEXT_SOURCE_FRAGMENT_SCHEMA) return null;
  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) return null;
  try {
    return buildSourceFragment({
      extractor: record.extractor as string,
      extractorRevision: record.extractorRevision as string,
      sourcePath: record.sourcePath as string,
      sourceHash: record.sourceHash as string,
      dependencyKeys: record.dependencyKeys as readonly string[] | undefined,
      nodes: record.nodes as readonly ContextGraphNode[],
      edges: record.edges as readonly ContextGraphEdge[],
    });
  } catch {
    return null;
  }
}
