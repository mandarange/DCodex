/**
 * Public surface of the bounded tuning loop.
 *
 * Nothing exported here can write a source file. `runContextGraphOptimizerLoop`
 * measures in-memory parameter overrides against the locked benchmark and, at
 * most, writes a proposal into the workspace report directory for a human to
 * review.
 */
export * from './types.js';
export {
  CONTEXT_GRAPH_MEASUREMENT_FILES,
  CONTEXT_GRAPH_MEASUREMENT_PREFIXES,
  CONTEXT_GRAPH_TUNABLE_FILES,
  CONTEXT_GRAPH_TUNING_TARGET_FILES,
  classifyContextGraphPatchTarget,
  contextGraphGuardedFiles,
  contextGraphTuningTargetFile,
  contextGraphTuningTargetForFile,
  normalizeCandidatePath
} from './allowlist.js';
export {
  CONTEXT_GRAPH_MAX_EDGE_WEIGHT,
  CONTEXT_GRAPH_MAX_PROFILE_DEPTH,
  CONTEXT_GRAPH_MIN_PROFILE_DEPTH,
  CONTEXT_GRAPH_MIN_UNIT_INTERVAL,
  contextGraphParameterKey,
  contextGraphProfileEdgePointers,
  contextGraphTunableParameters,
  resolveContextGraphTunableParameter
} from './parameter-space.js';
export {
  baselineContextGraphTuning,
  readNumberAtPointer,
  resolveContextGraphTuning,
  type ContextGraphResolveTuningResult
} from './resolve.js';
export {
  CONTEXT_GRAPH_MAX_OVERRIDES_PER_CANDIDATE,
  validateContextGraphCandidate,
  type ValidateContextGraphCandidateOptions
} from './validate.js';
export {
  CONTEXT_GRAPH_GUARD_FILE_LIMIT,
  contextGraphGuardedPaths,
  contextGraphSurfaceDrift,
  contextGraphSurfaceUnchanged,
  fingerprintContextGraphTuningSurface
} from './guard.js';
export {
  CONTEXT_GRAPH_DEFAULT_MAX_CANDIDATES,
  CONTEXT_GRAPH_DEFAULT_MULTIPLIERS,
  CONTEXT_GRAPH_DEFAULT_SWEEP_POINTERS,
  contextGraphSweepablePointers,
  generateContextGraphCandidates,
  type ContextGraphCandidatePlan,
  type ContextGraphSweepPointer
} from './candidates.js';
export {
  CONTEXT_GRAPH_EXPERIMENT_LOG_MAX_BYTES,
  CONTEXT_GRAPH_OPTIMIZER_ENTRY_POINT,
  CONTEXT_GRAPH_OPTIMIZER_REPORT_SEGMENTS,
  appendContextGraphExperimentRecord,
  buildContextGraphPatchArtifact,
  contextGraphOptimizerReportDir,
  contextGraphPatchArtifactPath,
  workspaceRelativePosix,
  writeContextGraphPatchArtifact,
  type BuildContextGraphPatchArtifactInput,
  type WriteContextGraphArtifactResult
} from './artifact.js';
export {
  benchmarkOptionsFor,
  failedFloorIds,
  toContextGraphExperimentRecord,
  type BenchmarkBudgetInput,
  type ExperimentRecordInput
} from './record.js';
export {
  CONTEXT_GRAPH_DEFAULT_MAX_EXPERIMENT_MS,
  CONTEXT_GRAPH_MIN_COMPOSITE_GAIN,
  runContextGraphOptimizerLoop,
  type ContextGraphOptimizerOptions
} from './loop.js';
