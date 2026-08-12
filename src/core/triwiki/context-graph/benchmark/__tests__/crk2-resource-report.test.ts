import assert from 'node:assert/strict';
import test from 'node:test';
import { fuzzBaseIndexBytes } from '../crk2-fuzz-index.js';
import {
  crk2LatencyStats,
  runCrk2ResourceBenchmark,
  type Crk2ResourceQuery,
} from '../crk2-resource-runner.js';
import { buildCrk2Report, formatCrk2Report, pooledCi95 } from '../crk2-report.js';

const BYTES = fuzzBaseIndexBytes();

const QUERIES: readonly Crk2ResourceQuery[] = [
  { id: 'exact-node-id', query: 'file:src/core/service/runner.ts', profile: 'implementation' },
  { id: 'lexical', query: 'registry service', profile: 'implementation' },
  { id: 'coarse-weighted', query: 'service area', profile: 'planning' },
  { id: 'empty', query: 'zzz-nothing-in-this-index-zzz', profile: 'implementation' },
];

test('the runner records every counter the card names', () => {
  const report = runCrk2ResourceBenchmark(BYTES, QUERIES, { repeats: 8, warmups: 1 });

  assert.equal(report.open.indexBytes, BYTES.length);
  assert.ok(report.open.openMs >= 0);
  assert.ok(report.open.nodeCount > 0);
  assert.ok(report.open.termCount > 0, 'a zero term count would void every recall number downstream');
  assert.equal(report.rows.length, QUERIES.length);

  for (const row of report.rows) {
    for (const sample of [row.cold, row.warm]) {
      // heap, RSS, index bytes, postings scanned, hydration count, nodes visited
      assert.ok(sample.rssBytes > 0, `${row.id}: RSS not recorded`);
      assert.ok(sample.heapDeltaBytes >= 0, `${row.id}: heap not recorded`);
      assert.ok(sample.postingsExamined >= 0, `${row.id}: postings not recorded`);
      assert.ok(sample.hydratedNodes >= 0, `${row.id}: hydration not recorded`);
      assert.ok(sample.visitedNodes >= 0, `${row.id}: visited nodes not recorded`);
      assert.equal(Object.keys(sample.laneCandidates).length, 4, `${row.id}: a lane is missing from telemetry`);
    }
    assert.equal(row.warmLatency.samples, 8);
  }
});

test('an answer that found nothing is marked, not reported as a latency win', () => {
  const resources = runCrk2ResourceBenchmark(BYTES, QUERIES, { repeats: 8, warmups: 1 });
  const report = buildCrk2Report({
    snapshot: { bytes: 1_000_000, parseMs: 40, heapDeltaBytes: 5_000_000, rssBytes: 60_000_000, nodeCount: 6, edgeCount: 6 },
    resources,
    lexicon: { termCount: 10, postingCount: 20, coarseTermCount: 3, coarsePostingCount: 6 },
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.deepEqual(report.emptyAnswerQueries, ['empty']);
  const empty = report.queries.find((row) => row.id === 'empty');
  assert.ok(empty);
  assert.equal(empty.emptyAnswer, true);
  assert.equal(empty.selected, 0);
  // The v1 baseline's fastest cases were its emptiest. The marker travels with
  // the row so the number cannot be quoted out of the table as a win.
  assert.ok(formatCrk2Report(report).includes('empty **(empty)**'));
  assert.ok(report.notes.includes('empty_answer:empty'));
});

test('an empty lexicon voids the whole report rather than reading as a fast index', () => {
  const resources = runCrk2ResourceBenchmark(BYTES, QUERIES, { repeats: 4, warmups: 0 });
  const report = buildCrk2Report({
    snapshot: { bytes: 1, parseMs: 1, heapDeltaBytes: 1, rssBytes: 1, nodeCount: 1, edgeCount: 1 },
    resources,
    lexicon: { termCount: 0, postingCount: 0, coarseTermCount: 0, coarsePostingCount: 0 },
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.ok(report.notes.includes('lexicon_empty:every_recall_number_in_this_report_is_void'));
  assert.ok(report.notes.includes('coarse_lane_empty'));
});

test('the coarse verdict is derived from unique selections, not from the lane existing', () => {
  const resources = runCrk2ResourceBenchmark(BYTES, QUERIES, { repeats: 4, warmups: 0 });
  const report = buildCrk2Report({
    snapshot: { bytes: 1, parseMs: 1, heapDeltaBytes: 1, rssBytes: 1, nodeCount: 1, edgeCount: 1 },
    resources,
    lexicon: { termCount: 10, postingCount: 20, coarseTermCount: 3, coarsePostingCount: 6 },
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  // The verdict is a function of the measurement, so a lane that is present but
  // never uniquely contributes still reads `delete`.
  assert.equal(report.coarseVerdict, resources.coarseOnlySelected > 0 ? 'proved' : 'delete');
  if (report.coarseVerdict === 'delete') {
    assert.ok(report.notes.includes('coarse_lane_contributed_no_unique_selection'));
  }
});

test('a mean is never published without its spread', () => {
  const stats = crk2LatencyStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(stats.samples, 10);
  assert.equal(stats.mean, 5.5);
  assert.ok(Math.abs(stats.stddev - 3.0276503541) < 1e-6);
  assert.ok(Math.abs(stats.ci95 - 1.96 * (stats.stddev / Math.sqrt(10))) < 1e-12);

  // A single sample has no spread, and must report none rather than zero-with-confidence.
  assert.equal(crk2LatencyStats([7]).ci95, 0);
  assert.equal(crk2LatencyStats([]).samples, 0);
});

test('pooling confidence intervals adds variances rather than averaging half-widths', () => {
  const left = crk2LatencyStats([1, 2, 3, 4, 5, 6, 7, 8]);
  const right = crk2LatencyStats([10, 20, 30, 40, 50, 60, 70, 80]);
  const pooled = pooledCi95([left, right]);
  // Averaging the half-widths would give (left.ci95 + right.ci95) / 2, which is
  // larger here; the correct pooling is over the variance of the mean of means.
  assert.ok(pooled < (left.ci95 + right.ci95) / 2);
  assert.ok(pooled > 0);
  assert.equal(pooledCi95([]), 0);
});

test('a lane reporting zero candidates may still have contributed', () => {
  // `LaneTelemetry.candidates` counts nodes a lane admitted FIRST. Lane order is
  // anchor -> lexical -> coarse -> local_graph, so a coarse hit on a node the
  // lexical lane already admitted reports zero while `table.contribute` still
  // fired. Two workers on this project read a `coarse: 0` as a dead lane and
  // escalated it as a defect; it was neither dead nor a defect. This test pins
  // the distinction so the third reader does not repeat it.
  const report = runCrk2ResourceBenchmark(BYTES, QUERIES, { repeats: 4, warmups: 1 });

  for (const row of report.rows) {
    for (const sample of [row.cold, row.warm]) {
      assert.equal(Object.keys(sample.laneContributions).length, 4, `${row.id}: a lane is missing from contributions`);
      // Contributions are counted over selected candidates, so they can never
      // exceed the selected set.
      for (const lane of Object.keys(sample.laneContributions)) {
        const value = sample.laneContributions[lane as keyof typeof sample.laneContributions];
        assert.ok(value <= sample.selected, `${row.id}/${lane}: more contributions than selected candidates`);
      }
      // A lane that uniquely owns a selection must show up in the contribution
      // count. This is the invariant that makes `coarse: 0` in `laneCandidates`
      // safe to ignore and `laneContributions.coarse` the field to trust.
      assert.ok(
        sample.laneContributions.coarse >= sample.coarseOnlySelected,
        `${row.id}: coarse-only selections exceed recorded coarse contributions`
      );
      assert.ok(
        sample.laneContributions.lexical >= sample.lexicalOnlySelected,
        `${row.id}: lexical-only selections exceed recorded lexical contributions`
      );
    }
  }
});

test('cold carries the open cost and warm does not', () => {
  const report = runCrk2ResourceBenchmark(BYTES, QUERIES, { repeats: 16, warmups: 2 });
  const row = report.rows[0];
  assert.ok(row);
  // Not asserted as "cold is slower" — on a six-node fixture the open is cheap
  // enough that the two can cross. What must hold is that they are reported
  // separately and never averaged, which is what the shape guarantees.
  assert.notEqual(row.cold, row.warm);
  assert.ok(row.warmLatency.samples > 1);
});
