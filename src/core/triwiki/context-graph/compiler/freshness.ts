/**
 * Freshness computation and propagation.
 *
 * A node is only `fresh` when the bytes it was derived from still hash to the
 * same value on disk. When a file node goes stale, everything derived from it —
 * wiki claims, proofs, cited sources — goes stale with it, so a query can never
 * present a confident answer that rests on a file that has since changed.
 */
import fsp from 'node:fs/promises';
import { sha256 } from '../../../fsx.js';
import type {
  ContextGraphEdge,
  ContextGraphEdgeType,
  ContextGraphNode,
  ContextGraphNodeKind
} from '../contracts.js';
import { resolveInsideWorkspace } from '../paths.js';
import { compareContextGraphIds } from '../ids.js';

/** Sentinel recorded when the source of a node is gone or unreadable. */
export const CONTEXT_GRAPH_MISSING_SOURCE_HASH = 'missing';

const DERIVATION_EDGE_TYPES: ReadonlySet<ContextGraphEdgeType> = new Set<ContextGraphEdgeType>([
  'cites',
  'derived_from',
  'supports',
  'verified_by'
]);

const DERIVED_KINDS: ReadonlySet<ContextGraphNodeKind> = new Set<ContextGraphNodeKind>([
  'wiki_claim',
  'proof',
  'source',
  'risk_domain'
]);

export interface ContextGraphFreshnessResult {
  nodes: ContextGraphNode[];
  /** workspace-relative path -> current sha256, or `missing` */
  sourceHashes: Record<string, string>;
  staleNodeIds: string[];
  missingPaths: string[];
}

/** Hash the current bytes of every requested workspace-relative path. Symlink escapes count as missing. */
export async function readSourceHashes(
  root: string,
  paths: readonly string[]
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const relative of [...new Set(paths)].sort()) {
    let absolute: string | null = null;
    try {
      absolute = resolveInsideWorkspace(root, relative);
    } catch {
      out[relative] = CONTEXT_GRAPH_MISSING_SOURCE_HASH;
      continue;
    }
    if (!absolute) {
      out[relative] = CONTEXT_GRAPH_MISSING_SOURCE_HASH;
      continue;
    }
    try {
      out[relative] = sha256(await fsp.readFile(absolute));
    } catch {
      out[relative] = CONTEXT_GRAPH_MISSING_SOURCE_HASH;
    }
  }
  return out;
}

function withFreshness(node: ContextGraphNode, freshness: ContextGraphNode['freshness']): ContextGraphNode {
  return node.freshness === freshness ? node : { ...node, freshness };
}

export interface ApplyFreshnessInput {
  root: string;
  nodes: readonly ContextGraphNode[];
  edges: readonly ContextGraphEdge[];
  /** Pre-computed hashes; anything absent is read from disk. */
  sourceHashes?: Record<string, string> | undefined;
}

export async function applyContextGraphFreshness(
  input: ApplyFreshnessInput
): Promise<ContextGraphFreshnessResult> {
  const wanted: string[] = [];
  for (const node of input.nodes) {
    if (node.path !== undefined && node.path !== '') wanted.push(node.path);
  }
  const provided = input.sourceHashes ?? {};
  const missingFromCache = wanted.filter((relative) => provided[relative] === undefined);
  const sourceHashes: Record<string, string> = {
    ...provided,
    ...(await readSourceHashes(input.root, missingFromCache))
  };

  const byId = new Map<string, ContextGraphNode>();
  const stale = new Set<string>();
  const missingPaths = new Set<string>();
  for (const node of input.nodes) {
    let resolved = node;
    if (node.path !== undefined && node.path !== '') {
      const current = sourceHashes[node.path];
      if (current === undefined || current === CONTEXT_GRAPH_MISSING_SOURCE_HASH) {
        missingPaths.add(node.path);
        resolved = withFreshness(node, 'stale');
      } else if (node.contentHash !== undefined && node.contentHash !== '') {
        resolved = withFreshness(node, current === node.contentHash ? 'fresh' : 'stale');
      }
    }
    if (resolved.freshness === 'stale') stale.add(resolved.id);
    byId.set(resolved.id, resolved);
  }

  const incoming = new Map<string, ContextGraphEdge[]>();
  for (const edge of input.edges) {
    if (!DERIVATION_EDGE_TYPES.has(edge.type)) continue;
    const bucket = incoming.get(edge.to);
    if (bucket) bucket.push(edge);
    else incoming.set(edge.to, [edge]);
  }

  const queue = [...stale];
  while (queue.length) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const edge of incoming.get(current) ?? []) {
      if (stale.has(edge.from)) continue;
      const source = byId.get(edge.from);
      if (!source || !DERIVED_KINDS.has(source.kind)) continue;
      stale.add(edge.from);
      byId.set(edge.from, withFreshness(source, 'stale'));
      queue.push(edge.from);
    }
  }

  return {
    nodes: [...byId.values()],
    sourceHashes,
    staleNodeIds: [...stale].sort(compareContextGraphIds),
    missingPaths: [...missingPaths].sort()
  };
}
