import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareEvaluationReports,
  compareMetricBlocks,
  harnessGrowthReport,
  runEvaluationBenchmark,
  serializedSizeBytes
} from '../evaluation.js';

function metric(overrides: Record<string, unknown> = {}) {
  return {
    label: 'fixture',
    serialized_size_bytes: 100,
    token_count: null,
    token_evidence: null,
    context_build_ms_per_run: 1,
    quality: {
      accuracy_proxy: 1,
      relevance_precision: 1,
      support_ratio: 1,
      required_recall: 1,
      unsupported_critical_selected: 0
    },
    ...overrides
  };
}

test('serialized size is deterministic UTF-8 byte size and is not labeled as tokens', () => {
  assert.equal(serializedSizeBytes('한글'), Buffer.byteLength('한글', 'utf8'));

  const report = runEvaluationBenchmark({ iterations: 1 });
  assert.equal(report.baseline.size_metric.name, 'serialized_json_bytes');
  assert.equal(report.baseline.size_metric.proxy_for_tokens, false);
  assert.equal('estimated_tokens' in report.baseline, false);
  assert.equal(report.comparison.token_savings_pct, null);
  assert.equal(report.comparison.checks.token_savings, null);
  assert.equal(report.comparison.meaningful_improvement, false);
});

test('harness growth report uses the official Codex subagent defaults', () => {
  const multiagent = harnessGrowthReport().codex_native.multiagent_v2;

  assert.equal(multiagent.max_threads, 256);
  assert.equal(multiagent.max_depth, 1);
  assert.equal(multiagent.job_max_runtime_seconds, 1200);
});

test('token savings are computed only from actual counts carrying an evidence source', () => {
  const report = runEvaluationBenchmark({
    iterations: 1,
    tokenEvidence: {
      source: 'authoritative-tokenizer-receipt.json',
      baseline_tokens: 100,
      candidate_tokens: 70
    }
  });
  assert.equal(report.baseline.token_count, 100);
  assert.deepEqual(report.candidate.token_evidence, { source: 'authoritative-tokenizer-receipt.json' });
  assert.equal(report.comparison.token_savings_pct, 0.3);

  const baseline = metric({
    token_count: 100,
    token_evidence: { source: 'authoritative-tokenizer-receipt.json' }
  });
  const candidate = metric({
    serialized_size_bytes: 80,
    token_count: 70,
    token_evidence: { source: 'authoritative-tokenizer-receipt.json' }
  });
  const comparison = compareMetricBlocks(baseline, candidate, {
    min_token_savings_pct: 0.1,
    min_accuracy_delta: 0,
    min_required_recall: 0.95,
    max_unsupported_critical_selected: 0,
    max_candidate_build_ms_per_run: 25
  });

  assert.equal(comparison.token_measurement.available, true);
  assert.equal(comparison.token_measurement.evidence_identity, 'authoritative-tokenizer-receipt.json');
  assert.equal(comparison.token_savings_pct, 0.3);
  assert.equal(comparison.serialized_size_savings_pct, 0.2);
  assert.equal(comparison.checks.token_savings, true);
  assert.equal(comparison.meaningful_improvement, true);
});

test('token savings require matching measurement evidence identity', () => {
  const baseline = metric({
    token_count: 100,
    token_evidence: { source: 'tokenizer-a-receipt.json' }
  });
  const candidate = metric({
    serialized_size_bytes: 80,
    token_count: 70,
    token_evidence: { source: 'tokenizer-b-receipt.json' }
  });
  const comparison = compareMetricBlocks(baseline, candidate, {
    min_token_savings_pct: 0.1,
    min_accuracy_delta: 0,
    min_required_recall: 0.95,
    max_unsupported_critical_selected: 0,
    max_candidate_build_ms_per_run: 25
  });

  assert.equal(comparison.token_measurement.available, false);
  assert.equal(comparison.token_measurement.evidence_identity, null);
  assert.equal(comparison.token_measurement.reason, 'matching_token_evidence_identity_required');
  assert.equal(comparison.token_savings_pct, null);
  assert.equal(comparison.checks.token_evidence, false);
  assert.equal(comparison.checks.token_savings, null);
  assert.equal(comparison.meaningful_improvement, false);
});

test('legacy estimated-token reports remain comparable without becoming token evidence', () => {
  const baseline = { schema_version: 1, candidate: metric({ serialized_size_bytes: undefined, estimated_tokens: 100 }) };
  const candidate = { schema_version: 1, candidate: metric({ serialized_size_bytes: undefined, estimated_tokens: 60 }) };
  const comparison = compareEvaluationReports(baseline, candidate);

  assert.equal(comparison.comparison.token_measurement.available, false);
  assert.equal(comparison.comparison.token_savings_pct, null);
  assert.equal(comparison.comparison.serialized_size_savings_pct, null);
  assert.equal(comparison.comparison.meaningful_improvement, false);
});
