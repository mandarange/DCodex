/**
 * Projections of the Context Graph into the artifact shapes SKS already ships:
 * the `sks.code-pack.v1` document and bounded TriWiki attention anchors.
 *
 * Nothing in this package owns facts. Every field it emits is either copied from
 * a snapshot node/edge or computed from one, and every entry it emits is grounded
 * in provenance that points back at a workspace-relative repository path.
 */
export {
  CODE_PACK_SCHEMA,
  DEFAULT_CODE_PACK_TOKEN_BUDGET,
  normalizeCodePackTokenBudget,
  type CodePack,
  type CodePackCitation,
  type CodePackEntry
} from './pack-contract.js';
export {
  buildCodePackFromGraph,
  computeCodePackIndexDigest,
  projectCodePackFromGraph,
  type BuildCodePackFromGraphOptions,
  type CodePackProjection
} from './code-pack.js';
export {
  buildWorkspaceCodePack,
  type WorkspaceCodePackOptions,
  type WorkspaceCodePackResult
} from './code-pack-workspace.js';
export {
  codePackFreshnessSources,
  isCodePackProjectionBoundToSnapshot
} from './code-pack-entry.js';
export {
  rankModuleCandidates,
  sortCandidates,
  type ProjectionCandidate
} from './module-view.js';
export {
  rankFileCandidates
} from './projection-candidate.js';
export {
  codePackEntryId,
  describeContextGraphNode,
  estimateEntryTokenCost,
  projectedFreshness,
  projectedTrustScore,
  type NodeSummaryExtras
} from './node-summary.js';
export {
  ATTENTION_FACT_TRUST_FLOOR,
  attentionHydrateHint,
  isFactGradeAnchor,
  projectContextGraphAnchors,
  projectContextPackAnchors,
  resolveContextGraphAnchorNode,
  type ContextPackAnchorInput,
  type ProjectedAttentionAnchor
} from './anchors.js';
export {
  CONTEXT_GRAPH_ATTENTION_TOKEN_BUDGET,
  readContextGraphAttention,
  type ContextGraphAttentionOptions,
  type ContextGraphAttentionReason,
  type ContextGraphAttentionRequest,
  type ContextGraphAttentionResult
} from './attention.js';
export {
  contextCountOfKind,
  contextNodeCount,
  contextNodeText,
  contextNodesOfKind,
  contextOneHopNeighbours,
  projectionFailureCode,
  type ProjectionFailureCode,
  type ProjectionNeighbour,
  type ProjectionOneHop
} from './graph-facts.js';
export * as mermaid from './mermaid/index.js';
export {
  buildArchitectureMapViews,
  buildArchitectureMapManifest,
  buildMermaidView,
  buildModuleDependencyView,
  serializeMermaidDocument,
  GENERATED_HEADER,
  type ArchitectureMapViewsResult,
  type ArchitectureMapManifestV1,
  type MermaidProjectionV1
} from './mermaid/index.js';
