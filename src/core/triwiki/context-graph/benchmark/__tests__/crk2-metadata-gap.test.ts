import assert from 'node:assert/strict';
import test from 'node:test';
import { compileContextGraph } from '../../compiler/index.js';
import { contextGraphExtractors } from '../../extractors/index.js';
import { CONTEXT_GRAPH_BENCHMARK_FIXTURE_FAMILIES } from '../types.js';
import { withFixture } from '../fixtures/index.js';
import {
  measureMetadataTypeLoss,
  measureProtectedGateFlagReachability,
  summarizeCrk2MetadataGap,
  type Crk2MetadataGapEntry,
} from '../crk2-metadata-gap.js';

/**
 * These assertions carried a `todo` for one card: the format-level fix was a
 * 12→16 byte metadata row change that the measuring card did not own, so the gap
 * was reported on every run rather than living in someone's memory. Format
 * revision 2 landed the row, the `todo`s came off, and the direction of every
 * assertion below is now inverted — the corpus must *keep* its types, and a
 * regression to the string-flattened writer fails here rather than being noticed
 * downstream by a test selector that quietly got faster.
 */

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';

async function measureFamilies(): Promise<readonly Crk2MetadataGapEntry[]> {
  const entries: Crk2MetadataGapEntry[] = [];
  for (const family of CONTEXT_GRAPH_BENCHMARK_FIXTURE_FAMILIES) {
    const entry = await withFixture(family, async (handle) => {
      const compiled = await compileContextGraph({
        root: handle.root,
        extractors: contextGraphExtractors(),
        observedAt: OBSERVED_AT,
        persistArtifacts: false,
      });
      if (!compiled.snapshot) return null;
      return { label: family, loss: measureMetadataTypeLoss(compiled.snapshot) };
    });
    if (entry) entries.push(entry);
  }
  return entries;
}

test('every declared fixture family compiles to a snapshot the measurement can read', async () => {
  const entries = await measureFamilies();
  assert.equal(
    entries.length,
    CONTEXT_GRAPH_BENCHMARK_FIXTURE_FAMILIES.length,
    'a family that fails to compile silently drops out of the measurement'
  );
});

test('a boolean metadata value survives the writer, and the count is recorded', async () => {
  const report = summarizeCrk2MetadataGap(await measureFamilies());

  // The measurement is only meaningful if the corpus authors the predicates at
  // all. A zero here would mean the fixtures stopped carrying typed metadata and
  // the gap became invisible rather than fixed — which would make the equality
  // below pass as `0 === 0` while proving nothing.
  assert.ok(report.booleanTruePredicatesV1 > 0, 'no fixture family authors a `=== true` metadata predicate');
  assert.ok(report.sourcesWithTruePredicates > 0);

  // Revision 1 measured 11 lost across 9 families, structurally: `String(true)`
  // is `'true'` and no `Record<string, string>` can satisfy `=== true`. The row
  // tag is what makes these two counts the same number.
  assert.equal(
    report.booleanTruePredicatesV2,
    report.booleanTruePredicatesV1,
    `the writer lost a boolean: ${report.lostKeys.join(',')}`
  );

  // The consumer-level helper must still recover all of them. It reads both the
  // boolean and the text spelling, because extractors author the flag both ways;
  // a helper that recognized only the new spelling would have moved the silent
  // failure rather than removed it.
  assert.equal(
    report.booleanTruePredicatesViaFlag,
    report.booleanTruePredicatesV1,
    'contextNodeFlag must still recover every predicate'
  );
});

test('metadata values keep their type through the writer', async () => {
  const report = summarizeCrk2MetadataGap(await measureFamilies());
  assert.equal(report.typePreserved, true, `predicates lost: ${report.booleanTruePredicatesV1}, keys: ${report.lostKeys.join(',')}`);
  // Type preservation is not only about booleans. `lostKeys` also collects the
  // numbers, nulls and arrays that failed to round-trip, so an implementation
  // that tagged booleans and left the other four flattened still fails here.
  assert.deepEqual(report.lostKeys, [], 'every authored metadata type must round-trip');
});

test('the protected-gate metadata flags cannot be true on an unprotected node', () => {
  const report = measureProtectedGateFlagReachability();

  // Three flags, not two. `nonRecursive` shares the disjunct, so an
  // `isProtectedGateNode` arm added for it would be born unreachable as well.
  assert.deepEqual(
    report.flags.map((entry) => entry.flag),
    ['requiredForPublish', 'alwaysOnRelease', 'nonRecursive']
  );
  for (const entry of report.flags) {
    assert.ok(entry.gateIds > 0, `${entry.flag} names no gate ids; the proof would be vacuous`);
    assert.deepEqual(
      entry.counterexamples,
      [],
      `${entry.flag} can be true on a node gateRisk does not classify protected`
    );
  }
  assert.equal(report.totalCounterexamples, 0);

  // This is the recorded disposition of the release record's "an arm no run can
  // currently verify". It is not a fixture gap: no fixture can close it, because
  // the compiler cannot emit the shape. A fixture built for it would emit an
  // ordinary protected gate and pass while proving nothing.
  assert.equal(report.metadataArmUnreachable, true);
});

test('every fixture family preserves its own types, not just the corpus in aggregate', async () => {
  const entries = await measureFamilies();
  // Per family rather than summed. The aggregate can stay whole while one family
  // loses every predicate and another gains them, and the aggregate is what the
  // release notes quote — so the finer statement is the one worth asserting.
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(
      entry.loss.booleanTruePredicatesV2,
      entry.loss.booleanTruePredicatesV1,
      `${entry.label} lost a boolean the writer used to carry: ${entry.loss.lostKeys.join(',')}`
    );
    assert.deepEqual(entry.loss.lostKeys, [], `${entry.label} lost a metadata type`);
  }
});
