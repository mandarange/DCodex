/**
 * The write-shape contracts, separated so the table builders and the assembler
 * can share `ProvenanceRow` without importing the encoder.
 */
import type { ContextGraphSnapshot } from '../contracts.js';

export interface ContextIndexWriteInput {
  snapshot: ContextGraphSnapshot;
  /** Hash over profile/ranking/tokenizer config; part of index identity. */
  configHash: Uint8Array;
  schemaRevision: number;
  /** Non-empty means the graph failed lint and must not be indexed. */
  lintErrors?: readonly string[];
  /** Node ids the ranking policy marks protected. */
  protectedNodeIds?: Iterable<string>;
  /** Node ids whose provenance failed to ground at compile time. */
  invalidatedNodeIds?: Iterable<string>;
}

export interface ContextIndexWriteResult {
  bytes: Uint8Array;
  nodeCount: number;
  edgeCount: number;
  provenanceCount: number;
  stringCount: number;
  sectionBytes: Readonly<Record<string, number>>;
}

export interface ProvenanceRow {
  readonly pathId: number;
  readonly line: number;
  readonly hashId: number;
  readonly extractorId: number;
}

