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
 * The `todo` on the type-preservation assertion is deliberate and is the whole
 * point of the module: the format-level fix is a 12→16 byte metadata row change
 * that this card does not own, so the gap is reported on every run rather than
 * living in someone's memory. When the row layout lands, the `todo` comes off
 * and this test starts failing until the numbers agree.
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

test('a boolean metadata value does not survive the writer, and the count is recorded', async () => {
  const report = summarizeCrk2MetadataGap(await measureFamilies());

  // The measurement is only meaningful if the corpus authors the predicates at
  // all. A zero here would mean the fixtures stopped carrying typed metadata and
  // the gap became invisible rather than fixed.
  assert.ok(report.booleanTruePredicatesV1 > 0, 'no fixture family authors a `=== true` metadata predicate');
  assert.ok(report.sourcesWithTruePredicates > 0);

  // `String(true)` is `'true'`, so the reader's `Record<string, string>` can
  // never satisfy `=== true`. Asserted as an equality rather than described in a
  // comment, so the day the row layout carries a type code this line fails.
  assert.equal(report.booleanTruePredicatesV2, 0, 'the writer is expected to lose every boolean');

  // The consumer-level workaround must recover all of them. If this ever falls
  // short, `contextNodeFlag` has stopped being a complete workaround and the
  // format fix is no longer optional.
  assert.equal(
    report.booleanTruePredicatesViaFlag,
    report.booleanTruePredicatesV1,
    'contextNodeFlag must recover every predicate the writer loses'
  );
});

test('metadata values keep their type through the writer', { todo: 'needs the 12->16 byte metadata row (format revision 2)' }, async () => {
  const report = summarizeCrk2MetadataGap(await measureFamilies());
  assert.equal(report.typePreserved, true, `predicates lost: ${report.booleanTruePredicatesV1}, keys: ${report.lostKeys.join(',')}`);
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

test('no fixture family authors a gate protected only by metadata', async () => {
  const entries = await measureFamilies();
  // Stated over the compiled snapshots rather than over the manifest sets, so
  // the two independent routes to the same conclusion have to agree.
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(
      entry.loss.booleanTruePredicatesV2,
      0,
      `${entry.label} unexpectedly preserved a boolean; the gap may already be fixed`
    );
  }
});
