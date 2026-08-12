/**
 * Public surface of the locked Context Graph benchmark.
 *
 * Consumers inject a baseline adapter and a candidate adapter and call
 * `runContextGraphBenchmark`; nothing here imports the query engine or an
 * extractor, so the harness stays measurable independently of what it measures.
 */
export * from './types.js';
export {
  ContextGraphBenchmarkCorpusError,
  CONTEXT_GRAPH_BENCHMARK_CORPUS_HASH_FIELD,
  canonicalJson,
  computeCorpusHash,
  defaultCorpusPath,
  loadContextGraphBenchmarkCorpus,
  parseContextGraphBenchmarkCorpus,
  type ParsedContextGraphBenchmarkCorpus
} from './corpus.js';
export {
  EMPTY_LATENCY,
  conflictKey,
  conflictRecall,
  evaluateCase,
  intersectionCount,
  latencyOf,
  mean,
  percentile,
  precisionAtK,
  recallAtK,
  runSignature,
  setRecall,
  summarizeAdapter,
  uniqueOrdered
} from './metrics.js';
export { benchmarkFloorSpecIds, evaluateBenchmarkFloors, scanForLeaks, type BenchmarkFloorInput } from './floors.js';
export { computeBenchmarkScore, headlineLatencyP95, relativeImprovement, round6 } from './score.js';
export {
  captureEnvironment,
  computeScoringCodeHash,
  machineProfile,
  reportLeakRules,
  serializeReport,
  writeBenchmarkReport,
  type WriteBenchmarkReportResult
} from './report.js';
export {
  DEFAULT_COLD_ITERATIONS,
  DEFAULT_WARM_ITERATIONS,
  runContextGraphBenchmark,
  type ContextGraphBenchmarkOptions
} from './runner.js';
export * from './crk2-types.js';
export {
  CRK2_CASES,
  CRK2_CORPUS,
  CRK2_CORPUS_REVISION,
  CRK2_DEFAULT_K,
  CRK2_GATE_IDS,
  CRK2_PROTECTED_GATE_IDS,
  CRK2_RETRIEVAL_FILES,
  CRK2_STRUCTURAL_NODE_IDS,
  crk2CasesByCategory,
  crk2RetrievalNodeUniverse,
  validateCrk2Corpus
} from './crk2-corpus.js';
export {
  CRK2_CONFIDENCE_RANK,
  CRK2_EMPTY_LATENCY,
  conflictKeyOf,
  crk2ConfidenceViolations,
  crk2ConflictRecall,
  crk2LatencyProfile,
  crk2MatcherKey,
  crk2MatcherMatches,
  crk2ProvenanceCoverage,
  crk2ResultSignature,
  crk2SetRecall,
  evaluateCrk2Case,
  summarizeCrk2Engine,
  type Crk2CaseObservation
} from './crk2-metrics.js';
export { CRK2_FLOOR_SPECS, crk2FloorCoverageGap, crk2FloorIds, evaluateCrk2Floors } from './crk2-floors.js';
export {
  CRK2_DEFAULT_REPEATS,
  CRK2_DEFAULT_WARMUPS,
  Crk2ComparisonError,
  compareRetrievalEngines,
  type Crk2ComparisonOptions
} from './crk2-comparison.js';
export {
  FIXTURE_ABSOLUTE_PATH,
  FIXTURE_SECRET_TOKEN,
  OUTSIDE_SYMLINK_TARGET_TOKEN,
  contextGraphBenchmarkFixtureFamilies,
  fixtureDefinition,
  gitAvailable,
  materializeFixture,
  missingFixtureDefinitions,
  withFixture,
  type FixtureHandle,
  type MaterializeFixtureOptions
} from './fixtures/index.js';
