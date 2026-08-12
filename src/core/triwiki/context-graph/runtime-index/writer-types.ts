/**
 * The write-shape contracts, separated so the table builders and the assembler
 * can share `ProvenanceRow` without importing the encoder.
 */
import type { ContextGraphSnapshot } from '../contracts.js';
import type { ContextLexiconConfig, ContextLexiconOmissions } from './lexicon.js';

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
  /**
   * BM25F tuning for the lexical and coarse lanes. Threaded in rather than
   * imported, because the values live in `query/ranking-config.ts` — the only
   * file the bounded optimizer may edit — and a copy of a weight at this call
   * site would be a weight nothing can tune.
   *
   * Omitting it leaves all four dictionary sections empty. That is an absent
   * lexicon, not a defaulted one: there is deliberately no fallback config
   * anywhere under `runtime-index/`, so a caller that forgets produces an index
   * with no lexical lane rather than one tuned by numbers nobody chose.
   */
  lexicon?: ContextLexiconConfig;
}

export interface ContextIndexWriteLexiconResult {
  termCount: number;
  postingCount: number;
  coarseTermCount: number;
  coarsePostingCount: number;
  /** Every bound that fired. A silent bound is a recall regression nothing can attribute later. */
  omissions: ContextLexiconOmissions;
}

export interface ContextIndexWriteResult {
  bytes: Uint8Array;
  nodeCount: number;
  edgeCount: number;
  provenanceCount: number;
  stringCount: number;
  sectionBytes: Readonly<Record<string, number>>;
  /** `null` when no lexicon config was supplied and the dictionary lanes are empty. */
  lexicon: ContextIndexWriteLexiconResult | null;
}

export interface ProvenanceRow {
  readonly pathId: number;
  readonly line: number;
  readonly hashId: number;
  readonly extractorId: number;
}

/**
 * One row of the node-metadata section.
 *
 * A named record rather than the tuple revision 1 used: with five columns, two
 * of which are small integers that the type system cannot tell apart, a
 * positional tuple is a transposition waiting to happen — and transposing `type`
 * with `ordinal` produces a file that passes every bounds check and decodes to
 * the wrong types.
 */
export interface MetadataRow {
  readonly node: number;
  readonly key: number;
  /** Always a string-table id. The tag says how to read it, never where it is. */
  readonly value: number;
  readonly type: number;
  /** Element position for an array row; 0 for every scalar. */
  readonly ordinal: number;
}

