import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_INDEX_HEADER_BYTES,
  CONTEXT_INDEX_SECTION,
  CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES,
  ContextIndexFormatError,
  readContextIndexHeader,
  readSectionTable,
} from '../../runtime-index/format.js';
import { openContextIndex } from '../../runtime-index/reader.js';
import { fuzzBaseIndexBytes, fuzzBaseSnapshot, observeContextIndex } from '../crk2-fuzz-index.js';
import { CRK2_FUZZ_STRATEGIES, runContextIndexFuzz } from '../crk2-fuzz.js';

/**
 * The floor is stated as an equality in the work order: corrupt-input rejection
 * 100%. It is checked here as three separate zeros — no divergence, no untyped
 * throw, no leaked detail — because a single ratio can be made to look like 1.0
 * by any denominator, and the three failures it would hide are different bugs.
 */

const BASE = fuzzBaseIndexBytes();

test('the fuzz base index leaves no section empty', () => {
  const header = readContextIndexHeader(BASE);
  const descriptors = readSectionTable(BASE, header);
  assert.equal(descriptors.length, Object.keys(CONTEXT_INDEX_SECTION).length);
  const empty = descriptors.filter((descriptor) => descriptor.length === 0n).map((descriptor) => descriptor.kind);
  // A zero-length section's `offset` field is unconstrained: nothing overlaps
  // it, nothing reads from it, and its checksum is the checksum of no bytes. A
  // base index with one would report inert mutations that say nothing about the
  // reader, so the campaign's own fixture must not contain one.
  assert.deepEqual(empty, [], 'every section must carry bytes or the rejection rate is not measuring the reader');
});

test('the pristine observation is total and stable', () => {
  const first = observeContextIndex(openContextIndex(BASE));
  const second = observeContextIndex(openContextIndex(BASE.slice()));
  assert.equal(first, second, 'the observation must not depend on buffer identity');

  const snapshot = fuzzBaseSnapshot();
  // Pinned rather than trusted: an observation that silently stopped walking
  // nodes would make every mutation look inert.
  for (const node of snapshot.nodes) assert.ok(first.includes(node.id), `${node.id} must appear in the observation`);
  assert.ok(first.includes('gate:release:service_contract'));
  assert.ok(first.split('\n').length > snapshot.nodes.length * 4);
});

test('every mutation inside the covered range is refused, and none is answered wrongly', () => {
  const report = runContextIndexFuzz({ casesPerStrategy: 400 });

  assert.equal(report.cases, 400 * CRK2_FUZZ_STRATEGIES.length);
  assert.equal(report.divergent, 0, `a mutated index answered differently instead of being refused: ${JSON.stringify(report.findings.slice(0, 4))}`);
  assert.equal(report.crashed, 0, `a mutated index threw an untyped error: ${JSON.stringify(report.findings.slice(0, 4))}`);
  assert.equal(report.inert, 0, 'every byte in the covered range must carry information');
  assert.equal(report.rejectionRate, 1, 'the corrupt-input rejection floor is an equality, not a threshold');
  assert.equal(report.ok, true);
});

test('a refusal never carries decoded file content and always names a repair', () => {
  const report = runContextIndexFuzz({ casesPerStrategy: 120, seed: 0x1234_5678 });
  // The file holds interned workspace strings. A `string` field on the error is
  // the channel through which a corrupt-index report becomes a content leak.
  assert.equal(report.nonNumericDetails, 0);
  assert.equal(report.missingRepairCommand, 0);
});

test('a corrupt count never becomes an allocation', () => {
  const report = runContextIndexFuzz({ casesPerStrategy: 400, seed: 0x0bad_c0de });
  const inflated = report.strategyCounts.count_inflate + report.strategyCounts.offset_inflate;
  assert.equal(inflated, 800);
  // 800 descriptors claiming ~2^30 rows would be tens of gigabytes if any of
  // them were believed. The budget is generous on purpose: it is sized to catch
  // "the reader allocated from the count", not to police ordinary GC noise.
  assert.ok(
    report.peakHeapGrowthBytes < 64 * 1024 * 1024,
    `peak heap growth ${report.peakHeapGrowthBytes} suggests an allocation sized from a corrupt count`
  );
  assert.equal(report.divergent + report.crashed, 0);
});

test('the campaign is reproducible from its seed alone', () => {
  const left = runContextIndexFuzz({ casesPerStrategy: 60, seed: 99 });
  const right = runContextIndexFuzz({ casesPerStrategy: 60, seed: 99 });
  assert.deepEqual(left.refusedByCode, right.refusedByCode);
  assert.equal(left.refused, right.refused);

  const other = runContextIndexFuzz({ casesPerStrategy: 60, seed: 100 });
  assert.notDeepEqual(left.refusedByCode, other.refusedByCode, 'two seeds must not walk the same offsets');
});

test('the campaign reaches every granular rejection rule it can', () => {
  const report = runContextIndexFuzz({ casesPerStrategy: 400 });
  const codes = new Set(Object.keys(report.refusedByCode));
  // Named individually: a campaign that only ever tripped the section checksum
  // would report 100% rejection while never reaching a single semantic check.
  for (const expected of [
    'format:section_checksum_mismatch',
    'format:header_checksum_mismatch',
    'format:section_out_of_bounds',
    'format:count_limit_exceeded',
    'format:section_kind_unknown',
    'format:offset_overflow',
    'format:section_table_truncated',
    'format:header_truncated',
  ]) {
    assert.ok(codes.has(expected), `no mutation ever reached ${expected}`);
  }
  assert.ok(codes.size >= 10, `only ${codes.size} distinct rules were reached`);
});

test('an appended tail changes nothing about the graph, and exactly one thing about the reader', () => {
  // Bytes after the last section are an unauthenticated tail: no descriptor
  // covers them, so no checksum notices them and the graph answers identically.
  // That is not a refusal and the campaign must not count it as one — but it is
  // not free either. `byteLength` is the reader's own answer and the cache
  // budgets on it, so a padded file bills the cache for bytes nobody wrote.
  // Measured here so the fact is a number rather than a footnote.
  const padding = 64;
  const extended = new Uint8Array(BASE.length + padding);
  extended.set(BASE, 0);
  extended.fill(0xab, BASE.length);

  const before = observeContextIndex(openContextIndex(BASE)).split('\n');
  const after = observeContextIndex(openContextIndex(extended)).split('\n');
  assert.equal(before.length, after.length);
  const differing = before.map((line, index) => (line === after[index] ? null : index)).filter((index) => index !== null);
  assert.deepEqual(differing.map((index) => before[index as number]), [`bytes=${BASE.length}`]);
  assert.deepEqual(differing.map((index) => after[index as number]), [`bytes=${BASE.length + padding}`]);
});

test('truncation at any offset is refused, never partially answered', () => {
  for (let cut = 1; cut < BASE.length; cut += 7) {
    assert.throws(
      () => openContextIndex(BASE.slice(0, cut)),
      (error: unknown) => error instanceof ContextIndexFormatError,
      `truncation at ${cut} was not refused`
    );
  }
});

test('a descriptor count field is never believed', () => {
  const header = readContextIndexHeader(BASE);
  const descriptors = readSectionTable(BASE, header);
  for (let index = 0; index < descriptors.length; index += 1) {
    const bytes = BASE.slice();
    const view = new DataView(bytes.buffer);
    view.setUint32(CONTEXT_INDEX_HEADER_BYTES + index * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES + 4, 0xffff_ffff, true);
    assert.throws(
      () => openContextIndex(bytes),
      (error: unknown) => error instanceof ContextIndexFormatError,
      `descriptor ${index} count inflation was accepted`
    );
  }
});
