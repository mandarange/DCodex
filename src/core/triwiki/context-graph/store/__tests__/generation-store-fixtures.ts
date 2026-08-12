/**
 * Shared fixtures for the generation store suites.
 *
 * The index builder produces a structurally valid `SKSCG2` file whose header
 * claims a chosen snapshot hash, which is what lets these tests exercise the
 * store's content-address and checksum checks without depending on the compact
 * writer another lane owns.
 *
 * `withRoot` is the safety rail: every filesystem test runs inside a fresh
 * `mkdtemp` directory under the OS temp dir and removes it afterwards, so a
 * suite can never touch the operator's real workspace or home.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT_INDEX_FORMAT_REVISION,
  CONTEXT_INDEX_HEADER_BYTES,
  CONTEXT_INDEX_REQUIRED_SECTIONS,
  CONTEXT_INDEX_SECTION,
  CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES,
  contextIndexChecksum,
  encodeContextIndexHeader,
  encodeSectionDescriptor,
  type SectionDescriptor,
} from '../../runtime-index/format.js';
import {
  ContextIndexStoreError,
  beginContextIndexOperation,
  cleanContextIndexOperation,
  commitContextIndexGeneration,
  stageContextIndexGeneration,
  type ContextIndexLintOutcome,
} from '../generation-store.js';

export const HASH_A = 'a1'.repeat(32);
export const HASH_B = 'b2'.repeat(32);
export const HASH_C = 'c3'.repeat(32);
export const CONFIG = 'c0'.repeat(16);
export const SOURCE_A = 'd0'.repeat(16);
export const SOURCE_B = 'd1'.repeat(16);
export const PASS: ContextIndexLintOutcome = { passed: true, errorCount: 0, warningCount: 0 };

export const NODE_COUNT = 2;
export const EDGE_COUNT = 1;

function u32Array(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true));
  return bytes;
}

function stringTable(values: readonly string[]): Uint8Array {
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const ends: number[] = [];
  let running = 0;
  for (const entry of encoded) {
    running += entry.length;
    ends.push(running);
  }
  const bytes = new Uint8Array(ends.length * 4 + running);
  bytes.set(u32Array(ends), 0);
  let at = ends.length * 4;
  for (const entry of encoded) {
    bytes.set(entry, at);
    at += entry.length;
  }
  return bytes;
}

function hexBytes(value: string, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index + 1 < Math.min(value.length, length * 2); index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function sectionPayload(kind: number, salt: string): { payload: Uint8Array; count: number } {
  switch (kind) {
    case CONTEXT_INDEX_SECTION.STRING_TABLE: {
      const values = ['alpha', `beta-${salt}`];
      return { payload: stringTable(values), count: values.length };
    }
    case CONTEXT_INDEX_SECTION.NODE_TABLE:
      return { payload: u32Array(new Array(NODE_COUNT).fill(0)), count: NODE_COUNT };
    case CONTEXT_INDEX_SECTION.EDGE_TABLE:
      return { payload: u32Array([1]), count: EDGE_COUNT };
    case CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS:
    case CONTEXT_INDEX_SECTION.IN_CSR_OFFSETS:
      return { payload: u32Array([0, 1, 1]), count: 3 };
    case CONTEXT_INDEX_SECTION.OUT_CSR_EDGES:
    case CONTEXT_INDEX_SECTION.IN_CSR_EDGES:
      return { payload: u32Array([0]), count: EDGE_COUNT };
    default:
      return { payload: u32Array([0]), count: 1 };
  }
}

/** A structurally valid index whose header claims `snapshotHash`, so the store's content-address check holds. */
export function buildIndexBytes(snapshotHash: string, salt = 'x'): Uint8Array {
  const kinds = [...CONTEXT_INDEX_REQUIRED_SECTIONS];
  const tableEnd = CONTEXT_INDEX_HEADER_BYTES + kinds.length * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES;
  const payloads = kinds.map((kind) => ({ kind, ...sectionPayload(kind, salt) }));

  let cursor = tableEnd;
  const placements = payloads.map((entry) => {
    const offset = cursor;
    cursor += entry.payload.length;
    return { ...entry, offset };
  });

  const bytes = new Uint8Array(cursor);
  for (const placement of placements) bytes.set(placement.payload, placement.offset);

  bytes.set(
    encodeContextIndexHeader({
      formatRevision: CONTEXT_INDEX_FORMAT_REVISION,
      schemaRevision: 1,
      flags: 0,
      nodeCount: NODE_COUNT,
      edgeCount: EDGE_COUNT,
      termCount: 1,
      provenanceCount: 1,
      snapshotHash: hexBytes(snapshotHash, 32),
      configHash: hexBytes(CONFIG, 32),
      sectionCount: kinds.length,
    }),
    0,
  );

  placements.forEach((placement, index) => {
    const descriptor: SectionDescriptor = {
      kind: placement.kind,
      count: placement.count,
      offset: BigInt(placement.offset),
      length: BigInt(placement.payload.length),
      checksum: contextIndexChecksum(bytes, placement.offset, placement.offset + placement.payload.length),
    };
    bytes.set(
      encodeSectionDescriptor(descriptor),
      CONTEXT_INDEX_HEADER_BYTES + index * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES,
    );
  });
  return bytes;
}

export async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-crk2-generation-store-'));
  try {
    return await fn(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

export interface CompileOptions {
  readonly target: string;
  readonly source?: string;
  readonly salt?: string;
}

/** begin → stage → commit → clean, the whole normal path. */
export async function compile(root: string, options: CompileOptions): Promise<void> {
  const journal = await beginContextIndexOperation(root, {
    targetSnapshotHash: options.target,
    configFingerprint: CONFIG,
    sourceFingerprint: options.source ?? SOURCE_A,
  });
  const staged = await stageContextIndexGeneration(
    root,
    journal,
    buildIndexBytes(options.target, options.salt ?? 'x'),
  );
  const result = await commitContextIndexGeneration(root, staged, { lint: PASS });
  await cleanContextIndexOperation(root, result.journal);
}

export function storeError(code: string, publicCode: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ContextIndexStoreError, `expected store error, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.publicCode, publicCode);
    for (const value of Object.values(error.detail)) assert.equal(typeof value, 'number');
    return true;
  };
}

export function publicCodeIs(publicCode: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    const carrier = error as { publicCode?: unknown; repairCommand?: unknown };
    assert.equal(carrier.publicCode, publicCode, `got ${String(error)}`);
    assert.equal(typeof carrier.repairCommand, 'string');
    return true;
  };
}

export async function fileExists(target: string): Promise<boolean> {
  return fsp
    .stat(target)
    .then(() => true)
    .catch(() => false);
}

