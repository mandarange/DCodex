import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  computeCorpusHash,
  defaultCorpusPath,
  loadContextGraphBenchmarkCorpus,
  parseContextGraphBenchmarkCorpus,
  ContextGraphBenchmarkCorpusError
} from '../corpus.js';
import { CONTEXT_GRAPH_BENCHMARK_FIXTURE_FAMILIES } from '../types.js';
import { fixtureDefinition } from '../fixtures/index.js';
import { runContextGraphBenchmark } from '../runner.js';
import { stubAdapter, STRONG_CANDIDATE, WEAK_BASELINE } from './adapters.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = defaultCorpusPath(path.join(__dirname, '..'));

function readRawCorpus(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as Record<string, unknown>;
}

test('the shipped corpus is sealed and self-consistent', () => {
  const parsed = loadContextGraphBenchmarkCorpus(CORPUS_PATH);
  assert.equal(parsed.hashOk, true, 'corpus_hash must match the canonical serialization of the file');
  assert.equal(parsed.corpus.corpusHash, parsed.computedHash);
  assert.equal(parsed.corpus.cases.length, 10, 'the corpus covers the ten real-repository query types');
  assert.equal(parsed.corpus.improvementThreshold, 0.05);
  const weightTotal = Object.values(parsed.corpus.scoreWeights).reduce((sum, weight) => sum + weight, 0);
  assert.ok(Math.abs(weightTotal - 1) < 1e-9);
  assert.equal(parsed.corpus.scoreWeights.taskContextSuccess, 0.3);
  assert.equal(parsed.corpus.scoreWeights.retrievalRecall, 0.2);
  assert.equal(parsed.corpus.scoreWeights.precision, 0.15);
  assert.equal(parsed.corpus.scoreWeights.evidencePerKiloToken, 0.15);
  assert.equal(parsed.corpus.scoreWeights.latencyImprovement, 0.1);
  assert.equal(parsed.corpus.scoreWeights.tokenImprovement, 0.1);
});

test('every case and safety probe names a fixture family that actually exists', () => {
  const parsed = loadContextGraphBenchmarkCorpus(CORPUS_PATH);
  for (const item of parsed.corpus.cases) {
    assert.ok(CONTEXT_GRAPH_BENCHMARK_FIXTURE_FAMILIES.includes(item.fixture));
    assert.ok(fixtureDefinition(item.fixture).files.length > 0, `${item.fixture} must define files`);
    assert.ok(item.gold.paths.length > 0, `${item.id} needs a machine-verifiable gold path set`);
  }
  const probedFloors = new Set(parsed.corpus.safetyProbes.map((probe) => probe.floor));
  assert.equal(probedFloors.size, 11, 'all eleven hard floors are covered by a probe');
  const probedFamilies = new Set([
    ...parsed.corpus.cases.map((item) => item.fixture),
    ...parsed.corpus.safetyProbes.map((probe) => probe.fixture)
  ]);
  for (const family of CONTEXT_GRAPH_BENCHMARK_FIXTURE_FAMILIES) {
    assert.ok(probedFamilies.has(family), `fixture family ${family} is referenced by a case or a probe`);
  }
});

test('canonical serialization is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, 3] }), canonicalJson({ a: [2, 3], b: 1 }));
  assert.notEqual(canonicalJson({ a: [2, 3] }), canonicalJson({ a: [3, 2] }));
});

test('editing a gold set trips the corpus integrity hash', () => {
  const raw = readRawCorpus();
  const before = computeCorpusHash(raw);
  assert.equal(before, raw.corpus_hash);

  const cases = raw.cases as Array<Record<string, unknown>>;
  const first = cases[0];
  assert.ok(first, 'corpus must have at least one case');
  const gold = first.gold as Record<string, unknown>;
  gold.paths = (gold.paths as string[]).slice(1);
  const after = computeCorpusHash(raw);
  assert.notEqual(after, before, 'weakening a gold set must change corpus_hash');

  const parsed = parseContextGraphBenchmarkCorpus(raw);
  assert.equal(parsed.hashOk, false);
});

test('deleting a case trips the corpus integrity hash', () => {
  const raw = readRawCorpus();
  raw.cases = (raw.cases as unknown[]).slice(1);
  const parsed = parseContextGraphBenchmarkCorpus(raw);
  assert.equal(parsed.hashOk, false, 'removing a failing case must be detectable');
});

test('re-weighting the score trips the corpus integrity hash', () => {
  const raw = readRawCorpus();
  const weights = raw.score_weights as Record<string, number>;
  weights.latency_improvement = 0.2;
  weights.task_context_success = 0.2;
  const parsed = parseContextGraphBenchmarkCorpus(raw);
  assert.equal(parsed.hashOk, false);
});

test('a corpus with weights that do not sum to one is rejected outright', () => {
  const raw = readRawCorpus();
  (raw.score_weights as Record<string, number>).precision = 0.5;
  assert.throws(() => parseContextGraphBenchmarkCorpus(raw), ContextGraphBenchmarkCorpusError);
});

test('a tripped corpus hash stops the benchmark before anything is scored', async () => {
  const raw = readRawCorpus();
  const cases = raw.cases as Array<Record<string, unknown>>;
  const first = cases[0];
  assert.ok(first);
  (first.gold as Record<string, unknown>).gate_ids = [];

  const parsed = parseContextGraphBenchmarkCorpus(raw);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-cg-bench-root-'));
  try {
    const report = await runContextGraphBenchmark(
      [
        stubAdapter('baseline-lexical', 'baseline', parsed.corpus.cases, WEAK_BASELINE),
        stubAdapter('candidate-graph', 'candidate', parsed.corpus.cases, STRONG_CANDIDATE)
      ],
      { root, corpus: raw, coldIterations: 1, warmIterations: 1 }
    );
    assert.equal(report.integrity.corpusHashOk, false);
    assert.equal(report.integrity.ok, false);
    assert.equal(report.score, null, 'no composite score may be produced from an unsealed corpus');
    assert.equal(report.cases.length, 0, 'no case may run against an unsealed corpus');
    assert.ok(report.notes.includes('corpus_hash_mismatch'));
    assert.equal(report.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
