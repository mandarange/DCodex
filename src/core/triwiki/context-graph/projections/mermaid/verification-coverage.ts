import type { ArchitectureMapPolicy } from '../../architecture/policy.js';
import type { ContextGraphSnapshot } from '../../contracts.js';
import type { MermaidProjectionV1 } from './contracts.js';
import { emptyProjection, projectFilteredView, type ProjectionRequest } from './view-builder.js';

/** Global view: test/gate/proof/module with tests/verified_by/gated_by. */
export function buildVerificationCoverageView(input: {
  snapshot: ContextGraphSnapshot;
  policy: ArchitectureMapPolicy;
  request?: ProjectionRequest;
}): MermaidProjectionV1 & { readonly text: string } {
  const hasVerification = input.snapshot.nodes.some(
    (node) => node.kind === 'test' || node.kind === 'gate' || node.kind === 'proof'
  );
  if (!hasVerification) {
    return emptyProjection(
      'verification-coverage',
      'Verification coverage',
      'LR',
      'insufficient_graph: no test/gate/proof nodes'
    );
  }
  return projectFilteredView({
    viewId: 'verification-coverage',
    snapshot: input.snapshot,
    policy: input.policy,
    ...(input.request ? { request: input.request } : {}),
    filter: {
      kinds: ['test', 'gate', 'proof', 'module'],
      edgeTypes: ['tests', 'verified_by', 'gated_by']
    }
  });
}
