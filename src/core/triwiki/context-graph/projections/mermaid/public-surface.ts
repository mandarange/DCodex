import type { ArchitectureMapPolicy } from '../../architecture/policy.js';
import type { ContextGraphSnapshot } from '../../contracts.js';
import type { MermaidProjectionV1 } from './contracts.js';
import { projectFilteredView, type ProjectionRequest } from './view-builder.js';

/** Global view: command/route/schema/config + exports/reexports when present. */
export function buildPublicSurfaceView(input: {
  snapshot: ContextGraphSnapshot;
  policy: ArchitectureMapPolicy;
  request?: ProjectionRequest;
}): MermaidProjectionV1 & { readonly text: string } {
  const edgeTypes = ['reexports', 'owns', 'routes_to'];
  if (input.snapshot.edges.some((edge) => (edge.type as string) === 'exports')) {
    edgeTypes.push('exports');
  }
  return projectFilteredView({
    viewId: 'public-surface',
    snapshot: input.snapshot,
    policy: input.policy,
    ...(input.request ? { request: input.request } : {}),
    filter: {
      kinds: ['command', 'route', 'schema', 'config'],
      edgeTypes
    }
  });
}
