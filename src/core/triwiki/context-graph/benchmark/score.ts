/**
 * Composite score.
 *
 * The weights live in the locked corpus, not here, so re-weighting the score is
 * a corpus edit and therefore an integrity change. Only the arithmetic lives in
 * this module, and it is symmetric: baseline and candidate go through the same
 * function with the same inputs.
 */
import type {
  ContextGraphBenchmarkAdapterSummary,
  ContextGraphBenchmarkScore,
  ContextGraphBenchmarkScoreComponents,
  ContextGraphBenchmarkScoreWeights,
  ContextGraphBenchmarkSideScore
} from './types.js';

/** Six decimals: enough resolution to rank, few enough that the report bytes stay stable. */
export function round6(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e6) / 1e6;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Higher is better: the better side scores 1, the other scores its share of it. */
function higherIsBetter(side: number, other: number): number {
  const best = Math.max(side, other);
  if (!(best > 0)) return 0;
  return clamp01(side / best);
}

/** Lower is better: the faster / cheaper side scores 1, the other scores the ratio. */
function lowerIsBetter(side: number, other: number): number {
  const safeSide = Number.isFinite(side) && side > 0 ? side : 0;
  const safeOther = Number.isFinite(other) && other > 0 ? other : 0;
  if (safeSide <= 0) return 1;
  if (safeOther <= 0) return 0;
  return clamp01(Math.min(safeSide, safeOther) / safeSide);
}

/** Warm p95 is the headline latency; cold p95 is used only when no warm samples exist. */
export function headlineLatencyP95(summary: ContextGraphBenchmarkAdapterSummary): number {
  return summary.warmLatency.samples > 0 ? summary.warmLatency.p95 : summary.coldLatency.p95;
}

function componentsFor(
  side: ContextGraphBenchmarkAdapterSummary,
  other: ContextGraphBenchmarkAdapterSummary
): ContextGraphBenchmarkScoreComponents {
  return {
    taskContextSuccess: clamp01(side.taskContextSuccess),
    retrievalRecall: clamp01(side.recallAtK),
    precision: clamp01(side.precisionAtK),
    evidencePerKiloToken: higherIsBetter(side.usefulEvidencePerKiloToken, other.usefulEvidencePerKiloToken),
    latencyImprovement: lowerIsBetter(headlineLatencyP95(side), headlineLatencyP95(other)),
    tokenImprovement: lowerIsBetter(side.meanTokenCost, other.meanTokenCost)
  };
}

function weigh(
  components: ContextGraphBenchmarkScoreComponents,
  weights: ContextGraphBenchmarkScoreWeights
): ContextGraphBenchmarkScoreComponents {
  return {
    taskContextSuccess: round6(components.taskContextSuccess * weights.taskContextSuccess),
    retrievalRecall: round6(components.retrievalRecall * weights.retrievalRecall),
    precision: round6(components.precision * weights.precision),
    evidencePerKiloToken: round6(components.evidencePerKiloToken * weights.evidencePerKiloToken),
    latencyImprovement: round6(components.latencyImprovement * weights.latencyImprovement),
    tokenImprovement: round6(components.tokenImprovement * weights.tokenImprovement)
  };
}

function sideScore(
  side: ContextGraphBenchmarkAdapterSummary,
  other: ContextGraphBenchmarkAdapterSummary,
  weights: ContextGraphBenchmarkScoreWeights
): ContextGraphBenchmarkSideScore {
  const raw = componentsFor(side, other);
  const weighted = weigh(raw, weights);
  const composite = round6(
    weighted.taskContextSuccess +
      weighted.retrievalRecall +
      weighted.precision +
      weighted.evidencePerKiloToken +
      weighted.latencyImprovement +
      weighted.tokenImprovement
  );
  return {
    adapterId: side.adapterId,
    adapterKind: side.adapterKind,
    components: {
      taskContextSuccess: round6(raw.taskContextSuccess),
      retrievalRecall: round6(raw.retrievalRecall),
      precision: round6(raw.precision),
      evidencePerKiloToken: round6(raw.evidencePerKiloToken),
      latencyImprovement: round6(raw.latencyImprovement),
      tokenImprovement: round6(raw.tokenImprovement)
    },
    weighted,
    composite
  };
}

/** Relative gain of `candidate` over `baseline`; a zero baseline counts any positive candidate as a full win. */
export function relativeImprovement(baseline: number, candidate: number): number {
  if (baseline > 0) return round6((candidate - baseline) / baseline);
  return candidate > 0 ? 1 : 0;
}

function reductionRatio(baseline: number, candidate: number): number {
  if (!(baseline > 0)) return 0;
  return round6((baseline - candidate) / baseline);
}

export function computeBenchmarkScore(
  baseline: ContextGraphBenchmarkAdapterSummary,
  candidate: ContextGraphBenchmarkAdapterSummary,
  weights: ContextGraphBenchmarkScoreWeights,
  threshold: number
): ContextGraphBenchmarkScore {
  const baselineSide = sideScore(baseline, candidate, weights);
  const candidateSide = sideScore(candidate, baseline, weights);
  const improvement = relativeImprovement(baselineSide.composite, candidateSide.composite);
  return {
    weights,
    baseline: baselineSide,
    candidate: candidateSide,
    improvement,
    threshold,
    passed: improvement >= threshold,
    latencyImprovementRatio: reductionRatio(headlineLatencyP95(baseline), headlineLatencyP95(candidate)),
    tokenImprovementRatio: reductionRatio(baseline.meanTokenCost, candidate.meanTokenCost)
  };
}
