/**
 * Builds the v2 binary index the benchmark's consumers need, from a snapshot
 * the session has already compiled.
 *
 * This calls `encodeContextIndex` directly instead of routing through the
 * CG2-12 generation compiler. The compiler is green, but a fixture built by the
 * simplest thing that produces a valid index keeps a compiler defect from
 * surfacing as a benchmark failure — and, more importantly, keeps a *symmetric*
 * compiler defect from hiding a real one. If the compiler and the benchmark
 * both round-tripped through the same code, a bug that corrupted writing and
 * reading in matching ways would measure as a pass.
 *
 * Nothing here is nullable and nothing here returns an empty result. A reader
 * that could be absent would let `detectWriteScopeConflicts` return `[]` for a
 * workspace that really does have a collision, and `conflictRecall` is an
 * equality floor — the run would report a pass while measuring nothing. Failing
 * loudly is the only honest option, so every failure path throws.
 */
import crypto from 'node:crypto';
import type { ContextGraphSnapshot } from '../../contracts.js';
import { encodeContextIndex } from '../../runtime-index/writer.js';
import { openContextIndex, type ContextIndexReader } from '../../runtime-index/reader.js';
import { CONTEXT_GRAPH_LEXICON_CONFIG } from '../../query/ranking-config.js';

/**
 * Config identity for benchmark-built indexes.
 *
 * Derived from a fixed label rather than from ambient ranking config: the
 * benchmark compares engines, so the index's config identity has to be the same
 * on every machine and in every process or two runs would not be comparable.
 */
export const BENCHMARK_INDEX_CONFIG_LABEL = 'sks.context-graph-benchmark-index.v1';

export const BENCHMARK_INDEX_CONFIG_HASH: Uint8Array = new Uint8Array(
  crypto.createHash('sha256').update(BENCHMARK_INDEX_CONFIG_LABEL).digest()
);

/** Layout revision this harness writes. Bumped only when the on-disk layout moves. */
export const BENCHMARK_INDEX_SCHEMA_REVISION = 1;

export type BenchmarkIndexErrorCode = 'index_encode_failed' | 'index_open_failed';

export class BenchmarkIndexError extends Error {
  readonly code: BenchmarkIndexErrorCode;

  /** Adapter-shaped code so a failure reaches the report as an error, not as a silent empty answer. */
  readonly adapterErrorCode: string;

  constructor(code: BenchmarkIndexErrorCode, cause: unknown) {
    // The cause's own message may quote index bytes or a fixture path, so only
    // its error name crosses into a message the report could ever carry.
    const name = cause instanceof Error ? cause.name : 'UnknownError';
    super(`${code}:${name}`);
    this.name = 'BenchmarkIndexError';
    this.code = code;
    this.adapterErrorCode = `adapter_error:${code}`;
  }
}

export interface BenchmarkContextIndex {
  readonly reader: ContextIndexReader;
  /** Encoded size, reported as telemetry per work order §12.4. */
  readonly indexBytes: number;
  readonly snapshotHash: string;
}

/**
 * Encode a compiled snapshot and open it as a reader.
 *
 * The snapshot is the one the session already compiled, so this adds an encode
 * and a validate — not a second compile — to the cold path, and nothing at all
 * to the warm path.
 */
export function buildBenchmarkContextIndex(snapshot: ContextGraphSnapshot): BenchmarkContextIndex {
  let bytes: Uint8Array;
  try {
    bytes = encodeContextIndex({
      snapshot,
      configHash: BENCHMARK_INDEX_CONFIG_HASH,
      schemaRevision: BENCHMARK_INDEX_SCHEMA_REVISION,
      // Without this the four dictionary sections are written empty and the
      // benchmark measures a search that can only answer a pasted path — the
      // exact shape of a suite reporting a pass for something nobody can use.
      lexicon: CONTEXT_GRAPH_LEXICON_CONFIG
    }).bytes;
  } catch (error: unknown) {
    throw new BenchmarkIndexError('index_encode_failed', error);
  }

  try {
    // `openContextIndex` validates the header, every section checksum, both CSR
    // arrays and every cross-table reference before the first lookup, so a
    // reader that opens is a reader whose answers can be attested to.
    const reader = openContextIndex(bytes, { expectedSnapshotHash: snapshot.snapshotHash });
    return { reader, indexBytes: bytes.byteLength, snapshotHash: reader.snapshotHash };
  } catch (error: unknown) {
    throw new BenchmarkIndexError('index_open_failed', error);
  }
}
