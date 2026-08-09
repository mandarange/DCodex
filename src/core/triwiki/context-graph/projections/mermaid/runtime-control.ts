import type { ArchitectureMapPolicy } from '../../architecture/policy.js';
import type { ContextGraphSnapshot } from '../../contracts.js';
import type { MermaidProjectionV1 } from './contracts.js';
import { emptyProjection, projectFilteredView, type ProjectionRequest } from './view-builder.js';

/** Global view: route/pipeline/gate/command with routes_to/gated_by/owns. */
export function buildRuntimeControlView(input: {
  snapshot: ContextGraphSnapshot;
  policy: ArchitectureMapPolicy;
  request?: ProjectionRequest;
}): MermaidProjectionV1 & { readonly text: string } {
  const hasControl = input.snapshot.nodes.some(
    (node) =>
      node.kind === 'route' ||
      node.kind === 'pipeline' ||
      node.kind === 'gate' ||
      node.kind === 'command'
  );
  if (!hasControl) {
    return emptyProjection(
      'runtime-control',
      'Runtime control',
      'TD',
      'insufficient_graph: no route/pipeline/gate/command nodes'
    );
  }
  return projectFilteredView({
    viewId: 'runtime-control',
    snapshot: input.snapshot,
    policy: input.policy,
    ...(input.request ? { request: input.request } : {}),
    filter: {
      kinds: ['route', 'pipeline', 'gate', 'command'],
      edgeTypes: ['routes_to', 'gated_by', 'owns']
    }
  });
}
