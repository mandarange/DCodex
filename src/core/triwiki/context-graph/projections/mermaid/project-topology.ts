import type { ArchitectureMapPolicy } from '../../architecture/policy.js';
import type { ContextGraphSnapshot } from '../../contracts.js';
import type { MermaidProjectionV1 } from './contracts.js';
import { projectFilteredView, type ProjectionRequest } from './view-builder.js';

/** Global view: module + file + command + route with contains/depends_on/routes_to. */
export function buildProjectTopologyView(input: {
  snapshot: ContextGraphSnapshot;
  policy: ArchitectureMapPolicy;
  request?: ProjectionRequest;
}): MermaidProjectionV1 & { readonly text: string } {
  return projectFilteredView({
    viewId: 'project-topology',
    snapshot: input.snapshot,
    policy: input.policy,
    ...(input.request ? { request: input.request } : {}),
    filter: {
      kinds: ['module', 'file', 'command', 'route'],
      edgeTypes: ['contains', 'depends_on', 'routes_to']
    }
  });
}
