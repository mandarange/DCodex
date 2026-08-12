/**
 * Generative corrupt-input campaign against the SKSCG2 reader.
 *
 * `runtime-index/__tests__/format.test.ts` covers thirteen hand-built corrupt
 * cases — one per rule, each written by someone who already knew which rule they
 * were breaking. This is the complement: mutate a valid index at offsets nobody
 * chose and classify whatever comes back.
 *
 * Four outcomes, and only two of them are acceptable:
 *
 * | outcome | meaning |
 * |---|---|
 * | `refused` | a typed `ContextIndexFormatError` / `ContextIndexReaderError` with a repair command |
 * | `inert` | opened, and the total observation is byte-identical to the pristine reader |
 * | `divergent` | opened and answered *differently* — silent corruption, a finding |
 * | `crashed` | threw something untyped — `RangeError` here is the reader reading out of bounds, a finding |
 *
 * `divergent` and `crashed` are findings rather than noise, and the floor is
 * that both are zero. `inert` is reported separately rather than folded into
 * the rejection rate: a mutation in a byte the format does not read is not a
 * reader defect, but it is also not evidence the reader refused anything, and
 * hiding it inside a "100%" would be the kind of benchmark that measures
 * nothing while reporting a pass.
 *
 * Allocation is measured, not assumed. `count_inflate` writes a huge value into
 * a descriptor's count field — the classic "believe the header and allocate"
 * attack — and the campaign records peak heap growth across every case, so a
 * reader that sized an array from a corrupt count would show up as a number
 * rather than as a hung process.
 */
import {
  ContextIndexFormatError,
  CONTEXT_INDEX_HEADER_BYTES,
  CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES,
  readContextIndexHeader,
  readSectionTable,
} from '../runtime-index/format.js';
import { ContextIndexReaderError, contextIndexFailureOf, openContextIndex } from '../runtime-index/reader.js';
import { fuzzBaseIndexBytes, observeContextIndex } from './crk2-fuzz-index.js';

/** Mutation families. Each names a way a file on disk actually goes wrong. */
export const CRK2_FUZZ_STRATEGIES = [
  'byte_set',
  'bit_flip',
  'zero_run',
  'truncate',
  'count_inflate',
  'offset_inflate',
  'range_swap',
] as const;

export type Crk2FuzzStrategy = (typeof CRK2_FUZZ_STRATEGIES)[number];

export type Crk2FuzzOutcome = 'refused' | 'inert' | 'divergent' | 'crashed';

export interface Crk2FuzzFinding {
  readonly outcome: 'divergent' | 'crashed';
  readonly strategy: Crk2FuzzStrategy;
  readonly caseIndex: number;
  /** Byte offset the mutation targeted. An integer, never decoded content. */
  readonly at: number;
  /** Error constructor name for a crash; `observation_diverged` for a divergence. */
  readonly detail: string;
}

export interface Crk2FuzzReport {
  readonly seed: number;
  readonly cases: number;
  readonly indexBytes: number;
  /** Bytes the format claims: header, section table, and every section payload. */
  readonly coveredBytes: number;
  readonly refused: number;
  readonly inert: number;
  readonly divergent: number;
  readonly crashed: number;
  /** Mutations redrawn because the draw reproduced the original bytes. */
  readonly redraws: number;
  /** Draws that still reproduced the original bytes after every redraw; never classified. */
  readonly noops: number;
  /** `refused / (refused + divergent + crashed)`; inert cases are excluded, not counted as passes. */
  readonly rejectionRate: number;
  readonly refusedByCode: Readonly<Record<string, number>>;
  readonly strategyCounts: Readonly<Record<Crk2FuzzStrategy, number>>;
  /** Refusals whose error carried a non-numeric detail field — a content-leak channel. */
  readonly nonNumericDetails: number;
  /** Refusals that did not name a repair command. */
  readonly missingRepairCommand: number;
  readonly peakHeapGrowthBytes: number;
  readonly findings: readonly Crk2FuzzFinding[];
  readonly ok: boolean;
}

export interface Crk2FuzzOptions {
  readonly seed?: number;
  /** Cases per strategy. The campaign runs `cases * strategies` mutations. */
  readonly casesPerStrategy?: number;
  readonly bytes?: Uint8Array;
}

export const CRK2_FUZZ_DEFAULT_SEED = 0x5ee_d11f;
export const CRK2_FUZZ_DEFAULT_CASES_PER_STRATEGY = 400;

/**
 * xorshift32. Seeded and self-contained so a campaign is reproducible from the
 * seed alone — a fuzz finding nobody can replay is a rumour.
 */
class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = (seed >>> 0) || 1;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value >>>= 0;
    value ^= value >>> 17;
    value ^= value << 5;
    value >>>= 0;
    this.state = value;
    return value;
  }

  below(bound: number): number {
    return bound <= 0 ? 0 : this.next() % bound;
  }
}

interface Geometry {
  readonly coveredEnd: number;
  readonly tableEnd: number;
  readonly descriptorCount: number;
}

function geometryOf(bytes: Uint8Array): Geometry {
  const header = readContextIndexHeader(bytes);
  const descriptors = readSectionTable(bytes, header);
  const tableEnd = CONTEXT_INDEX_HEADER_BYTES + descriptors.length * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES;
  let coveredEnd = tableEnd;
  for (const descriptor of descriptors) {
    coveredEnd = Math.max(coveredEnd, Number(descriptor.offset + descriptor.length));
  }
  return { coveredEnd, tableEnd, descriptorCount: descriptors.length };
}

/** Descriptor field offsets, from `encodeSectionDescriptor`: kind, count, offset, length, checksum. */
const DESCRIPTOR_COUNT_AT = 4;
const DESCRIPTOR_OFFSET_AT = 8;

function mutate(
  base: Uint8Array,
  geometry: Geometry,
  strategy: Crk2FuzzStrategy,
  prng: Prng
): { bytes: Uint8Array; at: number } {
  switch (strategy) {
    case 'byte_set': {
      const bytes = base.slice();
      const at = prng.below(geometry.coveredEnd);
      const before = bytes[at] as number;
      bytes[at] = (before + 1 + prng.below(255)) & 0xff;
      return { bytes, at };
    }
    case 'bit_flip': {
      const bytes = base.slice();
      const at = prng.below(geometry.coveredEnd);
      bytes[at] = (bytes[at] as number) ^ (1 << prng.below(8));
      return { bytes, at };
    }
    case 'zero_run': {
      const bytes = base.slice();
      const at = prng.below(geometry.coveredEnd);
      const run = 1 + prng.below(Math.min(64, geometry.coveredEnd - at));
      let changed = false;
      for (let index = at; index < at + run; index += 1) {
        if (bytes[index] !== 0) changed = true;
        bytes[index] = 0;
      }
      // An all-zero run over already-zero bytes is not a mutation; nudge one byte
      // so every case in the campaign really does change the file.
      if (!changed) bytes[at] = 0xff;
      return { bytes, at };
    }
    case 'truncate': {
      const at = 1 + prng.below(base.length - 1);
      return { bytes: base.slice(0, at), at };
    }
    case 'count_inflate': {
      const bytes = base.slice();
      const index = prng.below(geometry.descriptorCount);
      const at = CONTEXT_INDEX_HEADER_BYTES + index * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES + DESCRIPTOR_COUNT_AT;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      view.setUint32(at, 0x4000_0000 + prng.below(0x3fff_ffff), true);
      return { bytes, at };
    }
    case 'offset_inflate': {
      const bytes = base.slice();
      const index = prng.below(geometry.descriptorCount);
      const at = CONTEXT_INDEX_HEADER_BYTES + index * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES + DESCRIPTOR_OFFSET_AT;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      view.setBigUint64(at, BigInt(0x8000_0000) + BigInt(prng.next()), true);
      return { bytes, at };
    }
    default: {
      const bytes = base.slice();
      const span = 1 + prng.below(32);
      const left = prng.below(Math.max(1, geometry.coveredEnd - span));
      const right = prng.below(Math.max(1, geometry.coveredEnd - span));
      const carry = bytes.slice(left, left + span);
      bytes.set(bytes.slice(right, right + span), left);
      bytes.set(carry, right);
      return { bytes, at: left };
    }
  }
}

/**
 * A mutation that produced the original file is not a test of anything.
 *
 * `range_swap` can draw the same range twice, or two ranges holding identical
 * bytes; counting those as "the reader accepted a corrupt index" would report a
 * defect that does not exist, and counting them as refusals would inflate the
 * rejection rate with cases that never corrupted anything. They are redrawn.
 */
function isUnchanged(candidate: Uint8Array, base: Uint8Array): boolean {
  if (candidate.length !== base.length) return false;
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== base[index]) return false;
  }
  return true;
}

const MAX_REDRAWS = 8;

interface Classification {
  readonly outcome: Crk2FuzzOutcome;
  readonly code: string;
  readonly detail: string;
  readonly nonNumericDetail: boolean;
  readonly missingRepair: boolean;
}

function classify(bytes: Uint8Array, pristine: string): Classification {
  let observation: string;
  try {
    const reader = openContextIndex(bytes);
    observation = observeContextIndex(reader);
  } catch (error: unknown) {
    const typed = error instanceof ContextIndexFormatError || error instanceof ContextIndexReaderError;
    if (!typed) {
      return {
        outcome: 'crashed',
        code: 'untyped',
        detail: error instanceof Error ? error.constructor.name : 'non_error_throw',
        nonNumericDetail: false,
        missingRepair: false,
      };
    }
    const failure = contextIndexFailureOf(error);
    const detailValues = Object.values(error.detail as Record<string, unknown>);
    return {
      outcome: 'refused',
      code: `${error.name === 'ContextIndexFormatError' ? 'format' : 'reader'}:${error.code}`,
      detail: error.code,
      nonNumericDetail: detailValues.some((value) => typeof value !== 'number'),
      missingRepair: failure === null || !failure.repairCommand.startsWith('sks '),
    };
  }
  return observation === pristine
    ? { outcome: 'inert', code: 'inert', detail: 'inert', nonNumericDetail: false, missingRepair: false }
    : {
      outcome: 'divergent',
      code: 'divergent',
      detail: 'observation_diverged',
      nonNumericDetail: false,
      missingRepair: false,
    };
}

/**
 * Run the campaign.
 *
 * The observation of the *pristine* index is taken first and compared for
 * equality, so a bug that made every reader answer the same wrong thing would
 * not hide inside the comparison: `crk2-fuzz.test.ts` pins the pristine
 * observation's own content separately.
 */
export function runContextIndexFuzz(options: Crk2FuzzOptions = {}): Crk2FuzzReport {
  const seed = options.seed ?? CRK2_FUZZ_DEFAULT_SEED;
  const casesPerStrategy = Math.max(1, Math.trunc(options.casesPerStrategy ?? CRK2_FUZZ_DEFAULT_CASES_PER_STRATEGY));
  const base = options.bytes ?? fuzzBaseIndexBytes();
  const geometry = geometryOf(base);
  const pristine = observeContextIndex(openContextIndex(base));

  const prng = new Prng(seed);
  const refusedByCode: Record<string, number> = {};
  const strategyCounts = Object.fromEntries(
    CRK2_FUZZ_STRATEGIES.map((strategy) => [strategy, 0])
  ) as Record<Crk2FuzzStrategy, number>;
  const findings: Crk2FuzzFinding[] = [];
  const heapBefore = process.memoryUsage().heapUsed;
  let peakHeap = heapBefore;
  let refused = 0;
  let inert = 0;
  let divergent = 0;
  let crashed = 0;
  let nonNumericDetails = 0;
  let missingRepairCommand = 0;
  let caseIndex = 0;
  let redraws = 0;
  let noops = 0;

  for (const strategy of CRK2_FUZZ_STRATEGIES) {
    for (let iteration = 0; iteration < casesPerStrategy; iteration += 1) {
      let mutated = mutate(base, geometry, strategy, prng);
      for (let redraw = 0; redraw < MAX_REDRAWS && isUnchanged(mutated.bytes, base); redraw += 1) {
        mutated = mutate(base, geometry, strategy, prng);
        redraws += 1;
      }
      if (isUnchanged(mutated.bytes, base)) {
        noops += 1;
        continue;
      }
      const verdict = classify(mutated.bytes, pristine);
      strategyCounts[strategy] += 1;
      if (verdict.outcome === 'refused') {
        refused += 1;
        refusedByCode[verdict.code] = (refusedByCode[verdict.code] ?? 0) + 1;
        if (verdict.nonNumericDetail) nonNumericDetails += 1;
        if (verdict.missingRepair) missingRepairCommand += 1;
      } else if (verdict.outcome === 'inert') {
        inert += 1;
      } else {
        if (verdict.outcome === 'divergent') divergent += 1;
        else crashed += 1;
        findings.push({
          outcome: verdict.outcome,
          strategy,
          caseIndex,
          at: mutated.at,
          detail: verdict.detail,
        });
      }
      // Sampled rather than per-case: `memoryUsage()` is a syscall, and taking it
      // every iteration would make the campaign's own cost the thing being measured.
      if ((caseIndex & 0x3f) === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      caseIndex += 1;
    }
  }
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);

  const decided = refused + divergent + crashed;
  return {
    seed,
    cases: caseIndex,
    indexBytes: base.length,
    coveredBytes: geometry.coveredEnd,
    refused,
    inert,
    divergent,
    crashed,
    redraws,
    noops,
    rejectionRate: decided === 0 ? 1 : refused / decided,
    refusedByCode,
    strategyCounts,
    nonNumericDetails,
    missingRepairCommand,
    peakHeapGrowthBytes: Math.max(0, peakHeap - heapBefore),
    findings,
    ok: divergent === 0 && crashed === 0 && nonNumericDetails === 0 && missingRepairCommand === 0,
  };
}
