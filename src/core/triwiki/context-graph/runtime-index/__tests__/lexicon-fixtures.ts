import assert from 'node:assert/strict';
import {
  CONTEXT_LEXICON_FIELD,
  buildContextLexicon,
  lookupLexiconTerm,
  tokenizeLexiconField,
  type ContextLexiconBuildResult,
  type ContextLexiconConfig,
  type ContextLexiconDocument,
  type ContextLexiconTermRow,
} from '../lexicon.js';
import { CONTEXT_GRAPH_LEXICON_CONFIG } from '../../query/ranking-config.js';

/**
 * Shared helpers for the lexicon suites.
 *
 * They live here rather than in each suite because the four files assert
 * against the same structures, and a helper copied four times is a helper that
 * ends up meaning four different things. The suites are split by concern —
 * tokenizer, security, scoring, builder — and each one states the property it
 * is responsible for in its own header.
 *
 * Not a `.test.ts` file: it declares no tests and must not be picked up by the
 * runner.
 */

export const CONFIG: ContextLexiconConfig = CONTEXT_GRAPH_LEXICON_CONFIG;
export const FIELD = CONTEXT_LEXICON_FIELD;

/** Tokenizes one field and returns just the terms, which is what most assertions want. */
export function terms(
  value: string,
  field: number = FIELD.PURPOSE,
  config?: ContextLexiconConfig,
): readonly string[] {
  return tokenizeLexiconField(value, field as never, config ?? CONFIG).terms;
}

/** Stable structural comparison; `bigint` has no JSON representation of its own. */
export function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? `${entry}n` : entry));
}

export function docs(entries: readonly ContextLexiconDocument[]): readonly ContextLexiconDocument[] {
  return entries;
}

export function build(
  entries: readonly ContextLexiconDocument[],
  config: ContextLexiconConfig = CONFIG,
): ContextLexiconBuildResult {
  return buildContextLexicon(entries, config);
}

export function termRow(built: ContextLexiconBuildResult, term: string): ContextLexiconTermRow {
  const at = lookupLexiconTerm(built.terms, term);
  assert.notEqual(at, -1, `expected term to be indexed: ${term}`);
  const row = built.terms[at];
  assert.ok(row);
  return row;
}

export function postingsFor(built: ContextLexiconBuildResult, term: string): readonly number[] {
  const row = termRow(built, term);
  return built.postings.slice(row.postingOffset, row.postingOffset + row.postingCount).map((posting) => posting.node);
}

export function scoreFor(built: ContextLexiconBuildResult, term: string, node: number): number {
  const row = termRow(built, term);
  const found = built.postings
    .slice(row.postingOffset, row.postingOffset + row.postingCount)
    .find((posting) => posting.node === node);
  assert.ok(found, `expected a posting for node ${node}`);
  return found.score;
}
