import type { ArchitectureMapPolicy } from '../../architecture/policy.js';
import type { ContextGraphSnapshot } from '../../contracts.js';
import type { MermaidProjectionV1 } from './contracts.js';
import { projectFilteredView, type ProjectionRequest } from './view-builder.js';

/** Global view: risk_domain/module with affected_by/owns. */
export function buildRiskDomainsView(input: {
  snapshot: ContextGraphSnapshot;
  policy: ArchitectureMapPolicy;
  request?: ProjectionRequest;
}): MermaidProjectionV1 & { readonly text: string } {
  const highRiskIds = input.snapshot.nodes
    .filter((node) => node.kind === 'module' && (node.risk === 'high' || node.risk === 'protected'))
    .map((node) => node.id);
  const findingSubjectIds = [...(input.request?.findingSubjectIds ?? []), ...highRiskIds];
  const request: ProjectionRequest = {
    ...(input.request?.profile ? { profile: input.request.profile } : {}),
    ...(input.request?.seedNodeIds ? { seedNodeIds: input.request.seedNodeIds } : {}),
    ...(input.request?.seedPaths ? { seedPaths: input.request.seedPaths } : {}),
    ...(findingSubjectIds.length ? { findingSubjectIds } : {})
  };
  return projectFilteredView({
    viewId: 'risk-domains',
    snapshot: input.snapshot,
    policy: input.policy,
    request,
    filter: {
      kinds: ['risk_domain', 'module'],
      edgeTypes: ['affected_by', 'owns']
    }
  });
}
