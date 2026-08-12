/**
 * The seam between a snapshot's nodes and the identifier lexicon: which node
 * field becomes which BM25F field, and how a built lexicon becomes the two
 * dictionary lanes the reader binary-searches.
 *
 * `buildContextLexicon` was complete and tested before this module existed, and
 * nothing here re-implements any of it. What lives here is the one decision the
 * builder cannot make for itself — what the corpus *is* — plus the encoding step
 * that turns its term rows into `LEXICON_TABLE` / `COARSE_TERM_TABLE` rows.
 *
 * ## Term ids are string-table ids
 *
 * This is forced from both ends, not chosen. `reader-lookup.ts`'s `termIdOf`
 * delegates to `stringIdOf`, and `reader-validate.ts` requires every lexicon
 * term id to be strictly ascending and `< stringCount`. So a lane can only be
 * read at all if its rows are keyed by interned string ids. That in turn fixes
 * the order of operations in the writer: the lexicon is built *before* the
 * interner is sealed, every kept term is interned, and the rows are encoded
 * afterwards. The builder already sorts its term table by UTF-16 code unit and
 * the interner assigns ids in the same order, so "ascending term" and
 * "ascending id" are the same sequence — `assertAscending` below is the guard
 * that keeps that true if either sort is ever touched.
 *
 * ## Which node field feeds which lexicon field, and why
 *
 * A node's text is placed in exactly one identifier field, never two. Indexing
 * the same string twice would double its term frequency and inflate the field
 * length that is supposed to normalize it — the same flattening the release
 * record records as "per-field dedupe flattened BM25F term frequency", in the
 * opposite direction.
 *
 * | Lexicon field    | Node source                            | Why |
 * | ---------------- | -------------------------------------- | --- |
 * | `CANONICAL_ID`   | **nothing**                            | see below |
 * | `EXACT_LABEL`    | `label`, for a node named by prose      | a pasted label must survive as one term (`keepWholeValue`) |
 * | `SYMBOL_SEGMENT` | `label`, for `kind: 'symbol'`           | a symbol name is reached by its parts (`runService` -> `run`, `service`), which is the query shape the anchor lane cannot answer |
 * | `MANIFEST_NAME`  | `label`, for a manifest-declared kind   | a command/route/gate name is quoted verbatim by its manifest, so the whole value is the useful term |
 * | `BASENAME`       | POSIX basename of `path`                | `context.ts` typed alone must hit without a directory |
 * | `PATH_SEGMENT`   | `path`                                  | directory and stem segments; the *whole* path is the anchor lane's key, not this one's |
 * | `PURPOSE`        | string metadata of a non-evidence node  | the only free text a `ContextGraphNode` carries |
 * | `EVIDENCE`       | string metadata of an evidence node     | same text, lower weight, because a proof's prose describes a claim rather than the code |
 * | `COARSE`         | directory of `path`, in its own lane    | the coarse lane answers "which area", so it indexes containment rather than names |
 *
 * `CANONICAL_ID` is fed by nothing, deliberately and permanently. Its weight is
 * 0 in `ranking-config.ts` and its text is never emitted here, so a canonical id
 * exists only in the anchor lane's exact table. That is the mechanism — not the
 * convention — by which §4's "a BM25F score alone never yields `exact`" holds:
 * a lexical hit on a node id is not merely discouraged, it is unreachable,
 * because no posting for that string was ever written.
 *
 * Metadata contributes **string** values only. A boolean or a count carries no
 * lexical signal: `true` would match every flagged node in the workspace and
 * `12` every count that happens to be twelve, at the cost of a posting list per
 * node. Keys are skipped for the same reason — a key is a schema name shared by
 * thousands of nodes, so its IDF is ~0 and its postings are pure cost. Keys are
 * nonetheless *sorted* before their values are joined, because `Object.keys`
 * order is insertion order and insertion order is exactly the ambient input the
 * writer's determinism contract forbids reaching the bytes.
 *
 * ## What format revision 1 cannot carry
 *
 * A posting row in revision 1 is a bare `u32` node index: `validateTermTable`
 * bounds the postings section with stride 4, and `mergePostings` reads one u32
 * per posting. So the builder's `fieldMask`, `termFrequency` and BM25F `score`
 * have nowhere to go on disk, and the reader weights a merge by posting-count
 * rarity instead. The BM25F work is still load-bearing rather than discarded:
 * it is what decides *which* postings survive `postingCapPerTerm` on a common
 * term. Carrying the score itself is a posting-row layout change, and therefore
 * a format revision, not a writer change.
 */
import type { ContextGraphNode } from '../contracts.js';
import {
  CONTEXT_LEXICON_FIELD,
  buildContextLexicon,
  emptyLexiconOmissions,
  freezeLexiconOmissions,
  type ContextLexiconBuildResult,
  type ContextLexiconConfig,
  type ContextLexiconDocument,
  type ContextLexiconFieldId,
  type ContextLexiconFieldText,
  type ContextLexiconOmissions,
} from './lexicon.js';
import { CONTEXT_INDEX_TERM_ROW_BYTES, EVIDENCE_KINDS, refuse } from './writer-contract.js';
import { u32Section } from './writer-tables.js';

/**
 * Kinds whose label is quoted verbatim by a manifest — a command name, a route
 * pattern, a gate id. `keepWholeValue` on this field is what makes the quoted
 * form reachable as one term.
 */
const MANIFEST_NAMED_KINDS: ReadonlySet<string> = new Set([
  'command',
  'route',
  'pipeline',
  'gate',
  'schema',
  'config',
]);

/** Numeric discriminators for `lexicon_invariant`; `detail` carries integers only. */
const LEXICON_CHECK = {
  term_id_not_ascending: 1,
  posting_out_of_run: 2,
  posting_node_out_of_range: 3,
} as const;

export interface ContextIndexLaneSection {
  readonly table: Uint8Array;
  readonly postings: Uint8Array;
  readonly termCount: number;
  readonly postingCount: number;
}

export interface ContextIndexLexicalBuild {
  /** Fields 1-7: the `LEXICON_TABLE` lane. */
  readonly lexical: ContextLexiconBuildResult;
  /** Field 8 only: the `COARSE_TERM_TABLE` lane, with its own corpus statistics. */
  readonly coarse: ContextLexiconBuildResult;
  /** Every term either lane kept. The caller interns these before sealing. */
  readonly terms: readonly string[];
  readonly omissions: ContextLexiconOmissions;
}

/** A lane the writer declares empty, used when no lexicon config was supplied. */
export const EMPTY_CONTEXT_INDEX_LANE: ContextIndexLaneSection = Object.freeze({
  table: new Uint8Array(0),
  postings: new Uint8Array(0),
  termCount: 0,
  postingCount: 0,
});

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function basenameOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? path : path.slice(cut + 1);
}

function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '' : path.slice(0, cut);
}

/** See the module header: one field per node, chosen by kind. */
function labelFieldFor(kind: string): ContextLexiconFieldId {
  if (kind === 'symbol') return CONTEXT_LEXICON_FIELD.SYMBOL_SEGMENT;
  if (MANIFEST_NAMED_KINDS.has(kind)) return CONTEXT_LEXICON_FIELD.MANIFEST_NAME;
  return CONTEXT_LEXICON_FIELD.EXACT_LABEL;
}

/**
 * String metadata values, keys sorted. See the module header for why numbers,
 * booleans and keys are excluded.
 */
function metadataTextOf(node: ContextGraphNode): string {
  const metadata = node.metadata ?? {};
  const parts: string[] = [];
  for (const key of Object.keys(metadata).sort()) {
    const value = metadata[key];
    if (typeof value === 'string') {
      if (value !== '') parts.push(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string' && entry !== '') parts.push(entry);
    }
  }
  return parts.join(' ');
}

function fieldText(field: ContextLexiconFieldId, text: string): ContextLexiconFieldText[] {
  return text === '' ? [] : [{ field, text }];
}

/**
 * One document per node, in node-index order.
 *
 * Every node is present even when it contributes no text, because the document
 * count is BM25's IDF denominator: dropping the text-free nodes would silently
 * raise every term's IDF and make the scores a function of how many nodes
 * happened to be documented.
 */
export function contextLexicalDocuments(nodes: readonly ContextGraphNode[]): ContextLexiconDocument[] {
  return nodes.map((node, position) => {
    const fields: ContextLexiconFieldText[] = [
      ...fieldText(labelFieldFor(node.kind), node.label ?? ''),
      ...(node.path === undefined
        ? []
        : [
            ...fieldText(CONTEXT_LEXICON_FIELD.BASENAME, basenameOf(node.path)),
            ...fieldText(CONTEXT_LEXICON_FIELD.PATH_SEGMENT, node.path),
          ]),
      ...fieldText(
        EVIDENCE_KINDS.has(node.kind) ? CONTEXT_LEXICON_FIELD.EVIDENCE : CONTEXT_LEXICON_FIELD.PURPOSE,
        metadataTextOf(node),
      ),
    ];
    return { node: position, fields };
  });
}

/** The coarse corpus: containment, not names. See the module header. */
export function contextCoarseDocuments(nodes: readonly ContextGraphNode[]): ContextLexiconDocument[] {
  return nodes.map((node, position) => ({
    node: position,
    fields: fieldText(CONTEXT_LEXICON_FIELD.COARSE, node.path === undefined ? '' : directoryOf(node.path)),
  }));
}

function mergedOmissions(
  lexical: ContextLexiconOmissions,
  coarse: ContextLexiconOmissions,
): ContextLexiconOmissions {
  const total = emptyLexiconOmissions();
  total.secretTokens = lexical.secretTokens + coarse.secretTokens;
  total.redactedSpans = lexical.redactedSpans + coarse.redactedSpans;
  total.cappedFieldTokens = lexical.cappedFieldTokens + coarse.cappedFieldTokens;
  total.cappedCjkNgrams = lexical.cappedCjkNgrams + coarse.cappedCjkNgrams;
  total.cappedPostings = lexical.cappedPostings + coarse.cappedPostings;
  total.cappedTerms = lexical.cappedTerms + coarse.cappedTerms;
  return freezeLexiconOmissions(total);
}

/**
 * Builds both lanes.
 *
 * They are separate corpora rather than one build with a field filter, because
 * IDF and average field length are corpus-wide: a coarse term's rarity has to
 * be measured against the coarse text, not against every label in the
 * workspace. The two lanes still share one dictionary — a term id is a string
 * id in both — which is what lets the kernel resolve a query term once and hand
 * the same ids to `reader.lexical` and `reader.coarse`.
 *
 * `nodes` must be in the writer's dense node-index order; `document.node` is
 * that index and is written straight into the posting list.
 */
export function buildContextIndexLexical(
  nodes: readonly ContextGraphNode[],
  config: ContextLexiconConfig,
): ContextIndexLexicalBuild {
  const lexical = buildContextLexicon(contextLexicalDocuments(nodes), config);
  const coarse = buildContextLexicon(contextCoarseDocuments(nodes), config);
  const terms = new Set<string>();
  for (const row of lexical.terms) terms.add(row.term);
  for (const row of coarse.terms) terms.add(row.term);
  return {
    lexical,
    coarse,
    terms: Object.freeze([...terms]),
    omissions: mergedOmissions(lexical.omissions, coarse.omissions),
  };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Encodes one built lexicon as a term table and its posting list.
 *
 * Rows are emitted in the builder's order, which is code-unit order, which the
 * interner reproduces as ascending ids. The check is nonetheless explicit: an
 * unsorted table is not caught by any later step in the writer, and the reader
 * would reject the whole index at open with `csr_not_monotonic` — a corruption
 * code for a compiler bug, which sends a user to rebuild a file that would be
 * rebuilt exactly as wrong.
 */
export function encodeContextIndexLane(
  built: ContextLexiconBuildResult,
  termIdOf: (term: string) => number,
  nodeCount: number,
): ContextIndexLaneSection {
  const rows = built.terms;
  const table = new Uint8Array(rows.length * CONTEXT_INDEX_TERM_ROW_BYTES);
  const view = new DataView(table.buffer);
  const postings: number[] = [];
  let previousTermId = -1;

  rows.forEach((row, position) => {
    const termId = termIdOf(row.term);
    if (termId <= previousTermId) {
      refuse('lexicon_invariant', { row: position, check: LEXICON_CHECK.term_id_not_ascending });
    }
    previousTermId = termId;
    const at = position * CONTEXT_INDEX_TERM_ROW_BYTES;
    view.setUint32(at, termId, true);
    view.setUint32(at + 4, postings.length, true);
    view.setUint32(at + 8, row.postingCount, true);
    for (let index = 0; index < row.postingCount; index += 1) {
      const posting = built.postings[row.postingOffset + index];
      if (posting === undefined) {
        refuse('lexicon_invariant', { row: position, check: LEXICON_CHECK.posting_out_of_run });
      }
      if (!Number.isInteger(posting.node) || posting.node < 0 || posting.node >= nodeCount) {
        refuse('lexicon_invariant', { row: position, check: LEXICON_CHECK.posting_node_out_of_range });
      }
      postings.push(posting.node);
    }
  });

  return {
    table,
    postings: u32Section(postings),
    termCount: rows.length,
    postingCount: postings.length,
  };
}
