import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCorpusPath, loadContextGraphBenchmarkCorpus } from '../corpus.js';
import { runContextGraphBenchmark } from '../runner.js';
import { reportLeakRules } from '../report.js';
import { CONTEXT_GRAPH_BENCHMARK_REPORT_SCHEMA } from '../types.js';
import { behaviour, stubAdapter, STRONG_CANDIDATE, WEAK_BASELINE } from './adapters.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = defaultCorpusPath(path.join(__dirname, '..'));
const CASE_IDS = [
  'command-handler-route-pipeline-gate',
  'search-context-change-tests-and-gates',
  'parallel-naruto-slices-share-a-write-target'
];

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sks-cg-bench-root-'));
}

test('a strong candidate beats a lexical baseline by more than five percent', async () => {
  const parsed = loadContextGraphBenchmarkCorpus(CORPUS_PATH);
  const root = tempRoot();
  try {
    const report = await runContextGraphBenchmark(
      [
        stubAdapter('baseline-lexical', 'baseline', parsed.corpus.cases, WEAK_BASELINE),
        stubAdapter('candidate-graph', 'candidate', parsed.corpus.cases, STRONG_CANDIDATE)
      ],
      { root, caseIds: CASE_IDS, coldIterations: 1, warmIterations: 2, now: '2026-01-01T00:00:00.000Z' }
    );

    assert.equal(report.schema, CONTEXT_GRAPH_BENCHMARK_REPORT_SCHEMA);
    assert.equal(report.integrity.ok, true);
    assert.equal(report.floors.ok, true);
    assert.ok(report.score, 'a clean run must produce a composite score');
    assert.equal(report.score?.passed, true);
    assert.ok((report.score?.improvement ?? 0) >= 0.05);
    assert.equal(report.ok, true);
    assert.equal(report.cases.length, CASE_IDS.length * 2);
    assert.equal(report.generatedAt, '2026-01-01T00:00:00.000Z');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cold and warm runs are collected and labelled separately', async () => {
  const parsed = loadContextGraphBenchmarkCorpus(CORPUS_PATH);
  const root = tempRoot();
  try {
    const report = await runContextGraphBenchmark(
      [stubAdapter('candidate-graph', 'candidate', parsed.corpus.cases, STRONG_CANDIDATE)],
      { root, caseIds: CASE_IDS, coldIterations: 2, warmIterations: 3 }
    );
    const summary = report.summaries[0];
    assert.ok(summary);
    assert.equal(summary.coldLatency.samples, CASE_IDS.length * 2);
    assert.equal(summary.warmLatency.samples, CASE_IDS.length * 3);
    assert.equal(summary.coldLatency.p95, STRONG_CANDIDATE.coldLatencyMs);
    assert.equal(summary.warmLatency.p95, STRONG_CANDIDATE.warmLatencyMs);
    assert.ok(summary.coldLatency.p95 > summary.warmLatency.p95, 'a cold run is never reported as a warm run');
    assert.equal(summary.warmCacheHitRate, 1);
    assert.equal(summary.coldCacheHits, 0);
    assert.equal(report.capabilities.coldIterations, 2);
    assert.equal(report.capabilities.warmIterations, 3);
    for (const row of report.cases) {
      assert.equal(row.coldRuns, 2);
      assert.equal(row.warmRuns, 3);
    }
    assert.equal(report.score, null, 'one candidate alone cannot be compared against anything');
    assert.ok(report.notes.includes('composite_score_withheld:needs_one_baseline_and_one_candidate'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a cold run that reports a cache hit is flagged as a warm/cold separation problem', async () => {
  const parsed = loadContextGraphBenchmarkCorpus(CORPUS_PATH);
  const root = tempRoot();
  try {
    const cheating = stubAdapter('candidate-graph', 'candidate', parsed.corpus.cases, STRONG_CANDIDATE);
    const report = await runContextGraphBenchmark(
      [
        {
          id: cheating.id,
          kind: cheating.kind,
          run: async (query) => ({ ...(await cheating.run(query)), cacheHit: true })
        }
      ],
      { root, caseIds: [CASE_IDS[0] ?? ''], coldIterations: 1, warmIterations: 1 }
    );
    assert.ok(report.warnings.some((warning) => warning.endsWith('cold_run_reported_cache_hit')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the written report carries provenance for the machine and the scoring code, and leaks nothing', async () => {
  const parsed = loadContextGraphBenchmarkCorpus(CORPUS_PATH);
  const root = tempRoot();
  try {
    const report = await runContextGraphBenchmark(
      [
        stubAdapter('baseline-lexical', 'baseline', parsed.corpus.cases, WEAK_BASELINE),
        stubAdapter('candidate-graph', 'candidate', parsed.corpus.cases, STRONG_CANDIDATE)
      ],
      { root, caseIds: [CASE_IDS[0] ?? ''], coldIterations: 1, warmIterations: 1, writeReport: true }
    );

    assert.equal(report.integrity.corpusHash, parsed.corpus.corpusHash);
    assert.equal(report.integrity.expectedCorpusHash, parsed.computedHash);
    assert.ok(report.integrity.scoringCodeHash, 'the scoring code hash must be recorded');
    assert.match(String(report.integrity.scoringCodeHash), /^[0-9a-f]{64}$/);
    assert.ok(report.environment.machine.cpuCount > 0);
    assert.match(report.environment.dirtyFingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(reportLeakRules(report), []);
    assert.deepEqual(report.integrity.reportLeakRules, []);
    assert.ok(report.notes.some((note) => note.startsWith('report_written:.sneakoscope/reports/')));

    const written = path.join(root, '.sneakoscope', 'reports', 'context-graph-benchmark.json');
    assert.ok(fs.existsSync(written));
    const parsedReport = JSON.parse(fs.readFileSync(written, 'utf8')) as { schema: string };
    assert.equal(parsedReport.schema, CONTEXT_GRAPH_BENCHMARK_REPORT_SCHEMA);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a benchmark report path outside the workspace reports directory is refused', async () => {
  const parsed = loadContextGraphBenchmarkCorpus(CORPUS_PATH);
  const root = tempRoot();
  try {
    const outside = path.join(root, 'outside-report.json');
    const report = await runContextGraphBenchmark(
      [stubAdapter('candidate-graph', 'candidate', parsed.corpus.cases, STRONG_CANDIDATE)],
      {
        root,
        caseIds: [CASE_IDS[0] ?? ''],
        coldIterations: 1,
        warmIterations: 1,
        writeReport: true,
        reportPath: outside
      }
    );
    assert.equal(fs.existsSync(outside), false);
    assert.deepEqual(report.integrity.reportLeakRules, ['benchmark_report_path_outside_workspace_reports']);
    assert.ok(report.notes.includes('report_not_written:leak_rule_tripped'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an expected scoring-code hash that no longer matches stops the run before scoring', async () => {
  const parsed = loadContextGraphBenchmarkCorpus(CORPUS_PATH);
  const root = tempRoot();
  try {
    const report = await runContextGraphBenchmark(
      [
        stubAdapter('baseline-lexical', 'baseline', parsed.corpus.cases, WEAK_BASELINE),
        stubAdapter('candidate-graph', 'candidate', parsed.corpus.cases, STRONG_CANDIDATE)
      ],
      {
        root,
        caseIds: [CASE_IDS[0] ?? ''],
        coldIterations: 1,
        warmIterations: 1,
        expectedScoringCodeHash: '0'.repeat(64)
      }
    );
    assert.equal(report.integrity.scoringCodeHashOk, false);
    assert.equal(report.integrity.ok, false);
    assert.equal(report.score, null);
    assert.ok(report.notes.includes('scoring_code_hash_mismatch'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an adapter that throws is recorded as a failed run instead of aborting the benchmark', async () => {
  const parsed = loadContextGraphBenchmarkCorpus(CORPUS_PATH);
  const root = tempRoot();
  try {
    const report = await runContextGraphBenchmark(
      [
        stubAdapter('baseline-lexical', 'baseline', parsed.corpus.cases, WEAK_BASELINE),
        stubAdapter(
          'candidate-graph',
          'candidate',
          parsed.corpus.cases,
          behaviour({ throwOnRun: true }, STRONG_CANDIDATE)
        )
      ],
      { root, caseIds: [CASE_IDS[0] ?? ''], coldIterations: 1, warmIterations: 1 }
    );
    assert.ok(report.warnings.some((warning) => warning.includes('adapter_threw')));
    const failed = report.cases.filter((row) => row.adapterId === 'candidate-graph');
    assert.ok(failed.length > 0);
    assert.equal(failed.every((row) => row.ok === false), true);
    assert.equal(report.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
