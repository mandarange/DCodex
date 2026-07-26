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
