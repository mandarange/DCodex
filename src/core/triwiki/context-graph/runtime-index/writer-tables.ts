/**
 * String interning and the fixed-width section builders.
 *
 * Sorting the string table is not cosmetic. Insertion order depends on how the
 * caller happened to walk the graph, so a sorted table is what makes the same
 * snapshot produce the same bytes; it also lets the reader binary-search a term
 * instead of scanning, which is the whole point of retiring the query-time key
 * scan.
 */
import type { ContextGraphNode } from '../contracts.js';
import { quantizeTrust } from './format.js';
import {
  CONTEXT_INDEX_METADATA_ROW_BYTES,
  CONTEXT_INDEX_NODE_FLAG,
  CONTEXT_INDEX_NO_VALUE,
  CONTEXT_INDEX_PROVENANCE_ROW_BYTES,
  CONTEXT_INDEX_SOURCE_HASH_ROW_BYTES,
  CONTEXT_INDEX_TERM_ROW_BYTES,
  EVIDENCE_KINDS,
  TEST_OR_GATE_KINDS,
} from './writer-contract.js';
import type { ProvenanceRow } from './writer-types.js';

export class StringInterner {
  private readonly values = new Set<string>();
  private table: string[] = [];
  private index = new Map<string, number>();
  private sealed = false;

  add(value: string): void {
    if (this.sealed) throw new Error('string interner already sealed');
    this.values.add(value);
  }

  seal(): void {
    if (this.sealed) return;
    // Code-unit order, not locale order: `localeCompare` varies by ICU build.
    this.table = [...this.values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    this.index = new Map(this.table.map((value, position) => [value, position]));
    this.sealed = true;
  }

  idOf(value: string): number {
    if (!this.sealed) throw new Error('string interner not sealed');
    const found = this.index.get(value);
    if (found === undefined) throw new Error('string interned after seal');
    return found;
  }

  idOrSentinel(value: string | undefined): number {
    return value === undefined || value === '' ? CONTEXT_INDEX_NO_VALUE : this.idOf(value);
  }

  get size(): number {
    return this.sealed ? this.table.length : this.values.size;
  }

  encode(): Uint8Array {
    if (!this.sealed) throw new Error('string interner not sealed');
    const encoder = new TextEncoder();
    const blobs = this.table.map((value) => encoder.encode(value));
    const total = blobs.reduce((sum, blob) => sum + blob.length, 0);
    const bytes = new Uint8Array(blobs.length * 4 + total);
    const view = new DataView(bytes.buffer);
    let running = 0;
    blobs.forEach((blob, position) => {
      running += blob.length;
      view.setUint32(position * 4, running, true);
    });
    let at = blobs.length * 4;
    for (const blob of blobs) {
      bytes.set(blob, at);
      at += blob.length;
    }
    return bytes;
  }
}

export function nodeFlags(node: ContextGraphNode, protectedIds: ReadonlySet<string>, invalidatedIds: ReadonlySet<string>): number {
  let flags = 0;
  if (!invalidatedIds.has(node.id) && node.freshness === 'fresh') flags |= CONTEXT_INDEX_NODE_FLAG.GROUNDABLE;
  if (invalidatedIds.has(node.id)) flags |= CONTEXT_INDEX_NODE_FLAG.INVALIDATED;
  if (protectedIds.has(node.id) || node.risk === 'protected') flags |= CONTEXT_INDEX_NODE_FLAG.PROTECTED;
  if (EVIDENCE_KINDS.has(node.kind)) flags |= CONTEXT_INDEX_NODE_FLAG.IS_EVIDENCE;
  if (TEST_OR_GATE_KINDS.has(node.kind)) flags |= CONTEXT_INDEX_NODE_FLAG.IS_TEST_OR_GATE;
  if (node.path !== undefined) flags |= CONTEXT_INDEX_NODE_FLAG.HAS_PATH;
  if (node.contentHash !== undefined) flags |= CONTEXT_INDEX_NODE_FLAG.HAS_CONTENT_HASH;
  return flags;
}

export function csrOffsets(buckets: readonly number[], nodeCount: number): number[] {
  const counts = new Array<number>(nodeCount).fill(0);
  for (const bucket of buckets) counts[bucket] = (counts[bucket] as number) + 1;
  const offsets = new Array<number>(nodeCount + 1).fill(0);
  let running = 0;
  for (let index = 0; index < nodeCount; index += 1) {
    offsets[index] = running;
    running += counts[index] as number;
  }
  offsets[nodeCount] = running;
  return offsets;
}

export function termTable(entries: readonly (readonly [number, number])[]): {
  table: Uint8Array;
  postings: Uint8Array;
  termCount: number;
  postingCount: number;
} {
  const grouped = new Map<number, number[]>();
  for (const [termId, node] of entries) {
    const bucket = grouped.get(termId);
    if (bucket) bucket.push(node);
    else grouped.set(termId, [node]);
  }
  const terms = [...grouped.keys()].sort((a, b) => a - b);
  const table = new Uint8Array(terms.length * CONTEXT_INDEX_TERM_ROW_BYTES);
  const view = new DataView(table.buffer);
  const postings: number[] = [];
  terms.forEach((termId, position) => {
    const nodesForTerm = (grouped.get(termId) as number[]).slice().sort((a, b) => a - b);
    const at = position * CONTEXT_INDEX_TERM_ROW_BYTES;
    view.setUint32(at, termId, true);
    view.setUint32(at + 4, postings.length, true);
    view.setUint32(at + 8, nodesForTerm.length, true);
    postings.push(...nodesForTerm);
  });
  return { table, postings: u32Section(postings), termCount: terms.length, postingCount: postings.length };
}

export function provenanceTable(rows: readonly ProvenanceRow[]): Uint8Array {
  const bytes = new Uint8Array(rows.length * CONTEXT_INDEX_PROVENANCE_ROW_BYTES);
  const view = new DataView(bytes.buffer);
  rows.forEach((row, position) => {
    const at = position * CONTEXT_INDEX_PROVENANCE_ROW_BYTES;
    view.setUint32(at, row.pathId, true);
    view.setUint32(at + 4, row.line >>> 0, true);
    view.setUint32(at + 8, row.hashId, true);
    view.setUint32(at + 12, row.extractorId, true);
  });
  return bytes;
}

export function tripleTable(rows: readonly (readonly [number, number, number])[]): Uint8Array {
  const bytes = new Uint8Array(rows.length * CONTEXT_INDEX_METADATA_ROW_BYTES);
  const view = new DataView(bytes.buffer);
  rows.forEach((row, position) => {
    const at = position * CONTEXT_INDEX_METADATA_ROW_BYTES;
    view.setUint32(at, row[0], true);
    view.setUint32(at + 4, row[1], true);
    view.setUint32(at + 8, row[2], true);
  });
  return bytes;
}

export function pairTable(rows: readonly (readonly [number, number])[]): Uint8Array {
  const bytes = new Uint8Array(rows.length * CONTEXT_INDEX_SOURCE_HASH_ROW_BYTES);
  const view = new DataView(bytes.buffer);
  rows.forEach((row, position) => {
    const at = position * CONTEXT_INDEX_SOURCE_HASH_ROW_BYTES;
    view.setUint32(at, row[0], true);
    view.setUint32(at + 4, row[1], true);
  });
  return bytes;
}


/** Parses the canonical snapshot hash into the header's fixed 32-byte field. */
export function hexToBytes(value: string, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const usable = Math.min(length * 2, value.length - (value.length % 2));
  for (let index = 0; index < usable; index += 2) {
    const parsed = Number.parseInt(value.slice(index, index + 2), 16);
    bytes[index / 2] = Number.isFinite(parsed) ? parsed : 0;
  }
  return bytes;
}

export function u32Section(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true));
  return bytes;
}

