import type { ArchitectureMapPolicy } from '../../architecture/policy.js';
import { layerForModule } from '../../architecture/policy.js';
import type { ContextGraphSnapshot } from '../../contracts.js';
import type { MermaidProjectionV1 } from './contracts.js';
import { projectFilteredView, type ProjectionRequest } from './view-builder.js';

function modulePath(nodeId: string, path: string | undefined): string {
  if (path) return path;
  return nodeId.startsWith('module:') ? nodeId.slice('module:'.length) : nodeId;
}

/** Mission helper: module ownership layers as Mermaid subgraphs. */
export function buildOwnershipWorkstreamView(input: {
  snapshot: ContextGraphSnapshot;
  policy: ArchitectureMapPolicy;
  request?: ProjectionRequest;
}): MermaidProjectionV1 & { readonly text: string } {
  return projectFilteredView({
    viewId: 'ownership-workstream',
    snapshot: input.snapshot,
    policy: input.policy,
    ...(input.request ? { request: input.request } : {}),
    filter: {
      kinds: ['module'],
      edgeTypes: ['owns', 'depends_on', 'imports']
    },
    groupByLayer: true,
    layerOf: (node, policy) => layerForModule(policy, modulePath(node.id, node.path))
  });
}
