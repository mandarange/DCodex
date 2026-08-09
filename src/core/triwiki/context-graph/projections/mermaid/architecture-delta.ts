import { byCodePoint } from '../../architecture/contracts.js';
import type { ArchitectureMapPolicy } from '../../architecture/policy.js';
import type { ContextGraphSnapshot } from '../../contracts.js';
import * as ast from './ast.js';
import type { MermaidProjectionV1 } from './contracts.js';
import { assertInjective, mermaidSubgraphId } from './ids.js';
import { emptyAccounting, toMermaidProjection } from './serializer.js';
import { emptyProjection } from './view-builder.js';

export interface ArchitectureDeltaSets {
  readonly beforeNodeIds: readonly string[];
  readonly afterNodeIds: readonly string[];
  readonly beforeEdgeIds?: readonly string[];
  readonly afterEdgeIds?: readonly string[];
}

/**
 * Mission helper: simple before/after node (and optional edge) id-set delta diagram.
 */
export function buildArchitectureDeltaView(input: {
  snapshot: ContextGraphSnapshot;
  policy: ArchitectureMapPolicy;
  delta: ArchitectureDeltaSets;
}): MermaidProjectionV1 & { readonly text: string } {
  void input.policy;
  const beforeNodes = new Set(input.delta.beforeNodeIds);
  const afterNodes = new Set(input.delta.afterNodeIds);
  const added = [...afterNodes].filter((id) => !beforeNodes.has(id)).sort(byCodePoint);
  const removed = [...beforeNodes].filter((id) => !afterNodes.has(id)).sort(byCodePoint);
  const retained = [...afterNodes].filter((id) => beforeNodes.has(id)).sort(byCodePoint);

  if (!added.length && !removed.length && !retained.length) {
    return emptyProjection(
      'architecture-delta',
      'Architecture delta',
      'TD',
      'empty_delta: no before/after node ids'
    );
  }

  const labels = new Map(input.snapshot.nodes.map((node) => [node.id, node.label || node.path || node.id]));
  const allIds = [...added, ...removed, ...retained];
  const idMap = assertInjective(allIds);
  const statements: ast.MermaidStatement[] = [
    ast.comment('atlas-view: architecture-delta'),
    ast.subgraph({
      id: mermaidSubgraphId('delta:added'),
      label: 'added',
      canonicalId: 'delta:added',
      statements: added.map((id) =>
        ast.node({
          id: idMap.get(id)!,
          label: `+ ${labels.get(id) ?? id}`,
          canonicalNodeIds: [id]
        })
      )
    }),
    ast.subgraph({
      id: mermaidSubgraphId('delta:removed'),
      label: 'removed',
      canonicalId: 'delta:removed',
      statements: removed.map((id) =>
        ast.node({
          id: idMap.get(id)!,
          label: `- ${labels.get(id) ?? id}`,
          canonicalNodeIds: [id]
        })
      )
    }),
    ast.subgraph({
      id: mermaidSubgraphId('delta:retained'),
      label: 'retained',
      canonicalId: 'delta:retained',
      statements: retained.map((id) =>
        ast.node({
          id: idMap.get(id)!,
          label: labels.get(id) ?? id,
          canonicalNodeIds: [id]
        })
      )
    })
  ];

  const beforeEdges = new Set(input.delta.beforeEdgeIds ?? []);
  const afterEdges = new Set(input.delta.afterEdgeIds ?? []);
  if (beforeEdges.size || afterEdges.size) {
    const addedEdges = [...afterEdges].filter((id) => !beforeEdges.has(id)).sort(byCodePoint);
    const removedEdges = [...beforeEdges].filter((id) => !afterEdges.has(id)).sort(byCodePoint);
    statements.push(ast.comment(`edges +${addedEdges.length}/-${removedEdges.length}`));
  }

  return toMermaidProjection({
    viewId: 'architecture-delta',
    doc: ast.document({
      direction: 'TD',
      title: 'Architecture delta',
      statements
    }),
    accounting: emptyAccounting()
  });
}
