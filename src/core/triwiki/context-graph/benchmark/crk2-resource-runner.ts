/**
 * Cold and warm resource measurement for the v2 read path.
 *
 * The v1 baseline is a memory story before it is a latency story: 55.7 MB of
 * JSON parsed into 175 MB of heap and 368 MB of RSS, per process, before any
 * query runs. Latency alone would miss that entirely, so this runner reports
 * bytes, heap and RSS beside the query counters rather than in a separate table
 * somebody has to remember to read.
 *
 * Cold and warm are collected separately and never averaged together. Cold pays
 * for opening the index; warm reuses the reader and pays only for the query.
 * Averaging them would let a fast warm path hide an expensive open, which is the
 * exact cost v1 had and v2 exists to delete.
 *
 * **The coarse lane's evidence lives here.** Every selected candidate carries
 * its lane contributions, so a candidate whose *only* contribution is `coarse`
 * is a node no other lane produced. That count is the whole prove-or-delete
 * decision: a lane that never contributes a unique candidate costs bytes in
 * every index and reads as working, which is worse than absent. It is measured
 * per query rather than asserted once, because the lane's weight varies by
 * profile — `review` and `planning` weight it above `lexical`, `implementation`
 * below.
 */
import { openContextIndex, type ContextIndexReader } from '../runtime-index/reader.js';
import { hydrateSelectedCandidates } from '../query/hydrate.js';
import { fixedKernelClock, runContextKernel } from '../query/kernel.js';
import { RETRIEVAL_LANES, type ContextKernelResult, type RetrievalLane } from '../query/kernel-types.js';
import type { ContextGraphQueryProfileName } from '../profiles.js';

export interface Crk2ResourceQuery {
  readonly id: string;
  readonly query: string;
  readonly profile: ContextGraphQueryProfileName;
  readonly risk?: 'normal' | 'high';
  readonly tokenBudget?: number;
  readonly focusPaths?: readonly string[];
}

export interface Crk2ResourceSample {
  readonly durationMs: number;
  /** Heap growth attributable to this operation, not absolute heap. */
  readonly heapDeltaBytes: number;
  readonly rssBytes: number;
  readonly postingsExamined: number;
  readonly matchedTerms: number;
  readonly candidateCount: number;
  readonly selected: number;
  readonly visitedNodes: number;
  readonly visitedEdges: number;
  readonly hydratedNodes: number;
  readonly hydratedEdges: number;
  readonly provenanceCoverage: number;
  /**
   * `LaneTelemetry.candidates` per lane — **nodes the lane admitted FIRST**, not
   * nodes it matched.
   *
   * `runPostingLane` only increments this when `table.size` grew, so a lane that
   * scores a node an earlier lane already admitted records a zero while still
   * calling `table.contribute`. Lane order is anchor → lexical → coarse →
   * local_graph, so on a graph where the two BM25F lanes overlap, `coarse` reads
   * `0` while genuinely contributing to the ranking of candidates lexical
   * happened to reach first.
   *
   * This field is kept because it is what the kernel reports, and removing it
   * would only move the misreading somewhere with no counterpart. Use
   * `laneContributions` for "did this lane do any work" — two workers read a
   * `coarse: 0` here as a dead lane and it was not.
   */
  readonly laneCandidates: Readonly<Record<RetrievalLane, number>>;
  /**
   * Selected candidates carrying a contribution from each lane, regardless of
   * which lane admitted them first. This is the honest per-lane work measure.
   */
  readonly laneContributions: Readonly<Record<RetrievalLane, number>>;
  /** Selected candidates whose only lane contribution is `coarse`. The lane's proof. */
  readonly coarseOnlySelected: number;
  /** Selected candidates whose only lane contribution is `lexical`, for comparison. */
  readonly lexicalOnlySelected: number;
}

export interface Crk2LatencyStats {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly mean: number;
  /** Sample standard deviation; the confidence interval is derived from it. */
  readonly stddev: number;
  /** Half-width of the 95% confidence interval of the mean. */
  readonly ci95: number;
}

export interface Crk2QueryResourceRow {
  readonly id: string;
  readonly profile: ContextGraphQueryProfileName;
  readonly cold: Crk2ResourceSample;
  readonly warm: Crk2ResourceSample;
  readonly warmLatency: Crk2LatencyStats;
}

export interface Crk2IndexOpenMeasurement {
  readonly indexBytes: number;
  readonly openMs: number;
  readonly heapDeltaBytes: number;
  readonly rssBytes: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly termCount: number;
  readonly stringCount: number;
}

export interface Crk2ResourceReport {
  readonly open: Crk2IndexOpenMeasurement;
  readonly rows: readonly Crk2QueryResourceRow[];
  readonly repeats: number;
  readonly warmups: number;
  /** Total coarse-only selections across every query. Zero is the delete verdict. */
  readonly coarseOnlySelected: number;
  readonly lexicalOnlySelected: number;
  /** Queries in which the coarse lane produced at least one unique selection. */
  readonly queriesWithCoarseOnly: number;
}

export const CRK2_RESOURCE_DEFAULT_REPEATS = 32;
export const CRK2_RESOURCE_DEFAULT_WARMUPS = 2;

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[at] as number;
}

/**
 * Mean, spread, and a 95% confidence interval on the mean.
 *
 * A benchmark that reports a mean without a spread cannot distinguish a real
 * change from run-to-run noise, and the whole point of the before/after table is
 * to make that distinction. 1.96 is the normal approximation; at 30+ samples the
 * t correction is under 4% and would not move any conclusion here.
 */
export function crk2LatencyStats(samples: readonly number[]): Crk2LatencyStats {
  if (samples.length === 0) return { samples: 0, p50: 0, p95: 0, p99: 0, mean: 0, stddev: 0, ci95: 0 };
  const sorted = [...samples].sort((left, right) => left - right);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.length < 2
    ? 0
    : samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1);
  const stddev = Math.sqrt(variance);
  return {
    samples: samples.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    mean,
    stddev,
    ci95: 1.96 * (stddev / Math.sqrt(samples.length)),
  };
}

function laneOnlyCount(result: ContextKernelResult, lane: RetrievalLane): number {
  let count = 0;
  for (const entry of result.selected) {
    const lanes = new Set(entry.contributions.map((contribution) => contribution.lane));
    // `local_graph` is excluded from the uniqueness test: a candidate the walk
    // also reached is still a candidate the lane produced first, and counting it
    // as shared would understate every seed lane equally.
    lanes.delete('local_graph');
    if (lanes.size === 1 && lanes.has(lane)) count += 1;
  }
  return count;
}

/**
 * Selected candidates carrying each lane's contribution.
 *
 * Counted from `SelectedCandidate.contributions`, which the lane writes whether
 * or not it was the lane that admitted the node. That independence from
 * admission order is the whole point: `LaneTelemetry.candidates` reports zero for
 * a lane whose every hit was already in the table, which reads as a dead lane.
 */
function laneContributionCounts(result: ContextKernelResult): Record<RetrievalLane, number> {
  const counts = Object.fromEntries(RETRIEVAL_LANES.map((lane) => [lane, 0])) as Record<RetrievalLane, number>;
  for (const entry of result.selected) {
    for (const lane of new Set(entry.contributions.map((contribution) => contribution.lane))) {
      counts[lane] += 1;
    }
  }
  return counts;
}

function sampleOf(reader: ContextIndexReader, query: Crk2ResourceQuery): Crk2ResourceSample {
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = runContextKernel(
    reader,
    {
      query: query.query,
      profile: query.profile,
      ...(query.risk === undefined ? {} : { risk: query.risk }),
      ...(query.tokenBudget === undefined ? {} : { tokenBudget: query.tokenBudget }),
      ...(query.focusPaths === undefined ? {} : { focusPaths: [...query.focusPaths] }),
    },
    { clock: fixedKernelClock(0) }
  );
  const hydration = hydrateSelectedCandidates(reader, result.selected, { indexFresh: true });
  const durationMs = performance.now() - started;
  const memory = process.memoryUsage();

  const laneCandidates = Object.fromEntries(RETRIEVAL_LANES.map((lane) => [lane, 0])) as Record<RetrievalLane, number>;
  let postingsExamined = 0;
  let matchedTerms = 0;
  for (const telemetry of result.lanes) {
    laneCandidates[telemetry.lane] = telemetry.candidates;
    postingsExamined += telemetry.postingsExamined;
    matchedTerms += telemetry.matchedTerms;
  }

  return {
    durationMs,
    heapDeltaBytes: Math.max(0, memory.heapUsed - heapBefore),
    rssBytes: memory.rss,
    postingsExamined,
    matchedTerms,
    candidateCount: result.candidateCount,
    selected: result.selected.length,
    visitedNodes: result.visitedNodes,
    visitedEdges: result.visitedEdges,
    hydratedNodes: hydration.hydratedNodes,
    hydratedEdges: hydration.hydratedEdges,
    provenanceCoverage: hydration.provenanceCoverage,
    laneCandidates,
    laneContributions: laneContributionCounts(result),
    coarseOnlySelected: laneOnlyCount(result, 'coarse'),
    lexicalOnlySelected: laneOnlyCount(result, 'lexical'),
  };
}

export interface Crk2ResourceOptions {
  readonly repeats?: number;
  readonly warmups?: number;
}

/**
 * Measure one index end to end.
 *
 * The cold sample is taken against a reader opened inside the measurement, so it
 * carries the open cost; every warm sample reuses that reader. `bytes` is taken
 * rather than a path because the open cost is the parse-and-validate, not the
 * read syscall — comparing against v1's `JSON.parse` means comparing the same
 * kind of work.
 */
export function runCrk2ResourceBenchmark(
  bytes: Uint8Array,
  queries: readonly Crk2ResourceQuery[],
  options: Crk2ResourceOptions = {}
): Crk2ResourceReport {
  const repeats = Math.max(1, Math.trunc(options.repeats ?? CRK2_RESOURCE_DEFAULT_REPEATS));
  const warmups = Math.max(0, Math.trunc(options.warmups ?? CRK2_RESOURCE_DEFAULT_WARMUPS));

  const heapBeforeOpen = process.memoryUsage().heapUsed;
  const openStarted = performance.now();
  const reader = openContextIndex(bytes);
  const openMs = performance.now() - openStarted;
  const afterOpen = process.memoryUsage();

  const open: Crk2IndexOpenMeasurement = {
    indexBytes: bytes.length,
    openMs,
    heapDeltaBytes: Math.max(0, afterOpen.heapUsed - heapBeforeOpen),
    rssBytes: afterOpen.rss,
    nodeCount: reader.nodeCount,
    edgeCount: reader.edgeCount,
    termCount: reader.termCount,
    stringCount: reader.stringCount,
  };

  const rows: Crk2QueryResourceRow[] = [];
  for (const query of queries) {
    // The cold sample runs against its own reader so the open cost is inside it.
    const coldReader = openContextIndex(bytes);
    const cold = sampleOf(coldReader, query);

    for (let iteration = 0; iteration < warmups; iteration += 1) sampleOf(reader, query);

    const samples: number[] = [];
    let warm = sampleOf(reader, query);
    samples.push(warm.durationMs);
    for (let iteration = 1; iteration < repeats; iteration += 1) {
      const next = sampleOf(reader, query);
      samples.push(next.durationMs);
      // Keep the median-ish sample's counters rather than the last one's: the
      // counters are deterministic across repeats, so any is correct, but taking
      // the first keeps the reported latency and the reported counters from the
      // same run.
      if (iteration === Math.floor(repeats / 2)) warm = next;
    }

    rows.push({ id: query.id, profile: query.profile, cold, warm, warmLatency: crk2LatencyStats(samples) });
  }

  const coarseOnlySelected = rows.reduce((sum, row) => sum + row.warm.coarseOnlySelected, 0);
  const lexicalOnlySelected = rows.reduce((sum, row) => sum + row.warm.lexicalOnlySelected, 0);
  return {
    open,
    rows,
    repeats,
    warmups,
    coarseOnlySelected,
    lexicalOnlySelected,
    queriesWithCoarseOnly: rows.filter((row) => row.warm.coarseOnlySelected > 0).length,
  };
}
