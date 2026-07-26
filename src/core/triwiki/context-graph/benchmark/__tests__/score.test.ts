import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBenchmarkScore, headlineLatencyP95, relativeImprovement, round6 } from '../score.js';
import { EMPTY_LATENCY } from '../metrics.js';
import type {
  ContextGraphBenchmarkAdapterKind,
  ContextGraphBenchmarkAdapterSummary,
  ContextGraphBenchmarkScoreWeights
} from '../types.js';

const WEIGHTS: ContextGraphBenchmarkScoreWeights = {
  taskContextSuccess: 0.3,
  retrievalRecall: 0.2,
  precision: 0.15,
  evidencePerKiloToken: 0.15,
  latencyImprovement: 0.1,
  tokenImprovement: 0.1
};

function summary(
  adapterId: string,
  adapterKind: ContextGraphBenchmarkAdapterKind,
  values: {
    taskContextSuccess: number;
    recallAtK: number;
    precisionAtK: number;
    usefulEvidencePerKiloToken: number;
    meanTokenCost: number;
    warmP95: number;
  }
): ContextGraphBenchmarkAdapterSummary {
  return {
    adapterId,
    adapterKind,
    caseCount: 10,
    okRate: 1,
    taskContextSuccess: values.taskContextSuccess,
    recallAtK: values.recallAtK,
    precisionAtK: values.precisionAtK,
    nodeRecallAtK: values.recallAtK,
    gateRecall: 1,
    protectedGateRecall: 1,
    testRecall: 1,
    conflictRecall: 1,
    provenanceCoverage: 1,
    exclusionCorrectRate: 1,
    exactSeedPreservation: 1,
    meanTokenCost: values.meanTokenCost,
    usefulEvidencePerKiloToken: values.usefulEvidencePerKiloToken,
    coldLatency: { samples: 1, p50: values.warmP95 * 2, p95: values.warmP95 * 2, min: values.warmP95 * 2, max: values.warmP95 * 2 },
    warmLatency: { samples: 3, p50: values.warmP95, p95: values.warmP95, min: values.warmP95, max: values.warmP95 },
    warmCacheHitRate: 1,
    coldCacheHits: 0
  };
}

test('the composite score is the six weighted components and nothing else', () => {
  const baseline = summary('baseline-lexical', 'baseline', {
    taskContextSuccess: 0.5,
    recallAtK: 0.5,
    precisionAtK: 0.5,
    usefulEvidencePerKiloToken: 1,
    meanTokenCost: 4000,
    warmP95: 400
  });
  const candidate = summary('candidate-graph', 'candidate', {
    taskContextSuccess: 1,
    recallAtK: 1,
    precisionAtK: 1,
    usefulEvidencePerKiloToken: 4,
    meanTokenCost: 1000,
    warmP95: 100
  });

  const score = computeBenchmarkScore(baseline, candidate, WEIGHTS, 0.05);

  // hand computed: 0.3*0.5 + 0.2*0.5 + 0.15*0.5 + 0.15*0.25 + 0.10*0.25 + 0.10*0.25
  assert.equal(score.baseline.composite, 0.4125);
  assert.equal(score.candidate.composite, 1);
  assert.equal(score.baseline.components.evidencePerKiloToken, 0.25);
  assert.equal(score.baseline.components.latencyImprovement, 0.25);
  assert.equal(score.baseline.components.tokenImprovement, 0.25);
  assert.equal(score.candidate.components.latencyImprovement, 1);
  assert.equal(score.improvement, round6((1 - 0.4125) / 0.4125));
  assert.equal(score.passed, true);
  assert.equal(score.latencyImprovementRatio, 0.75);
  assert.equal(score.tokenImprovementRatio, 0.75);
});

test('a candidate that does not beat the baseline by five percent fails the rule', () => {
  const baseline = summary('baseline-lexical', 'baseline', {
    taskContextSuccess: 0.5,
    recallAtK: 0.5,
    precisionAtK: 0.5,
    usefulEvidencePerKiloToken: 2,
    meanTokenCost: 2000,
    warmP95: 200
  });
  const candidate = summary('candidate-graph', 'candidate', {
    taskContextSuccess: 0.5,
    recallAtK: 0.52,
    precisionAtK: 0.5,
    usefulEvidencePerKiloToken: 2,
    meanTokenCost: 2000,
    warmP95: 200
  });

  const score = computeBenchmarkScore(baseline, candidate, WEIGHTS, 0.05);
  assert.equal(score.baseline.composite, 0.675);
  assert.equal(score.candidate.composite, 0.679);
  assert.ok(score.improvement > 0, 'the candidate is genuinely better');
  assert.ok(score.improvement < 0.05, 'but not by the five percent the rule demands');
  assert.equal(score.passed, false);
});

test('an identical candidate scores a zero improvement and does not pass', () => {
  const values = {
    taskContextSuccess: 0.9,
    recallAtK: 0.9,
    precisionAtK: 0.9,
    usefulEvidencePerKiloToken: 3,
    meanTokenCost: 1500,
    warmP95: 150
  };
  const score = computeBenchmarkScore(
    summary('baseline-lexical', 'baseline', values),
    summary('candidate-graph', 'candidate', values),
    WEIGHTS,
    0.05
  );
  assert.equal(score.improvement, 0);
  assert.equal(score.passed, false);
});

test('improvement handles a zero baseline without dividing by zero', () => {
  assert.equal(relativeImprovement(0, 0), 0);
  assert.equal(relativeImprovement(0, 0.4), 1);
  assert.equal(relativeImprovement(0.5, 0.75), 0.5);
});

test('cold latency is the headline only when there are no warm samples', () => {
  const warmed = summary('candidate-graph', 'candidate', {
    taskContextSuccess: 1,
    recallAtK: 1,
    precisionAtK: 1,
    usefulEvidencePerKiloToken: 1,
    meanTokenCost: 100,
    warmP95: 40
  });
  assert.equal(headlineLatencyP95(warmed), 40);
  assert.equal(headlineLatencyP95({ ...warmed, warmLatency: EMPTY_LATENCY }), 80);
});
