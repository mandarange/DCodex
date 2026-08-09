import { byCodePoint } from '../../architecture/contracts.js';
import type { ArchitectureMapPolicy } from '../../architecture/policy.js';
import { buildArchitectureScope, sliceArchitectureGraph } from '../../architecture/slice.js';
import type { ContextGraphSnapshot } from '../../contracts.js';
import type { MermaidProjectionV1 } from './contracts.js';
import { emptyProjection, projectFilteredView, type ProjectionRequest } from './view-builder.js';

/**
 * Mission helper: seed-path neighborhood (slice) projected as change-impact.
 */
export function buildChangeImpactView(input: {
  snapshot: ContextGraphSnapshot;
  policy: ArchitectureMapPolicy;
  request?: ProjectionRequest;
}): MermaidProjectionV1 & { readonly text: string } {
  const seedPaths = input.request?.seedPaths ?? [];
  const seedNodeIds = input.request?.seedNodeIds ?? [];
  if (!seedPaths.length && !seedNodeIds.length) {
    return emptyProjection(
      'change-impact',
      'Change impact',
      'LR',
      'mission_helper: seed paths/node ids required'
    );
  }
  const scope = buildArchitectureScope({
    profile: input.request?.profile ?? 'implementation',
    seedNodeIds,
    seedPaths
  });
  const slice = sliceArchitectureGraph(input.snapshot, input.policy, scope);
  const nodeIdSet = new Set(slice.nodeIds);
  const edgeIdSet = new Set(slice.edgeIds);
  const sliced: ContextGraphSnapshot = {
    ...input.snapshot,
    nodes: input.snapshot.nodes
      .filter((node) => nodeIdSet.has(node.id))
      .sort((left, right) => byCodePoint(left.id, right.id)),
    edges: input.snapshot.edges
      .filter((edge) => edgeIdSet.has(edge.id))
      .sort((left, right) => byCodePoint(left.id, right.id)),
    nodeCount: nodeIdSet.size,
    edgeCount: edgeIdSet.size
  };
  return projectFilteredView({
    viewId: 'change-impact',
    snapshot: sliced,
    policy: input.policy,
    request: {
      ...(input.request?.profile ? { profile: input.request.profile } : { profile: 'implementation' }),
      seedNodeIds: slice.protectedNodeIds,
      ...(seedPaths.length ? { seedPaths } : {})
    },
    filter: {
      kinds: ['module', 'file', 'symbol', 'test', 'gate', 'command', 'route'],
      edgeTypes: ['imports', 'calls', 'tests', 'gated_by', 'routes_to', 'depends_on', 'contains']
    }
  });
}
