import type { ArchitectureMapPolicy } from '../../architecture/policy.js';
import type { ContextGraphSnapshot } from '../../contracts.js';
import type { MermaidProjectionV1 } from './contracts.js';
import { emptyProjection, projectFilteredView, type ProjectionRequest } from './view-builder.js';

/** Global view: source/wiki_claim/proof with cites/derived_from/verified_by. */
export function buildSsotProvenanceView(input: {
  snapshot: ContextGraphSnapshot;
  policy: ArchitectureMapPolicy;
  request?: ProjectionRequest;
}): MermaidProjectionV1 & { readonly text: string } {
  const hasSsotKinds = input.snapshot.nodes.some(
    (node) => node.kind === 'source' || node.kind === 'wiki_claim' || node.kind === 'proof'
  );
  if (!hasSsotKinds) {
    return emptyProjection(
      'ssot-provenance',
      'SSOT provenance',
      'TD',
      'insufficient_graph: no source/wiki_claim/proof nodes'
    );
  }
  return projectFilteredView({
    viewId: 'ssot-provenance',
    snapshot: input.snapshot,
    policy: input.policy,
    ...(input.request ? { request: input.request } : {}),
    filter: {
      kinds: ['source', 'wiki_claim', 'proof'],
      edgeTypes: ['cites', 'derived_from', 'verified_by']
    }
  });
}
