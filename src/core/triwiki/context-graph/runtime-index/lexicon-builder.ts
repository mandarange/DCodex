/**
 * Turns a corpus of documents into the term table and posting list the reader
 * binary-searches.
 *
 * The term table is sorted by UTF-16 code unit. That is not cosmetic: sorted
 * order is precisely what makes `lookupLexiconTerm` legal, and the binary
 * search is what replaces the v1 per-query key scan. An unsorted table would
 * still "work" by falling back to a scan, which is the silent-downgrade shape
 * the contract's no-fallback rule forbids.
 *
 * A posting records `{node, fieldMask, termFrequency, score}` and nothing else.
 * There is deliberately no confidence on it: §4 of the contract fixes lexical
 * results at `text_candidate`, so a BM25F score has no field to be promoted
 * into at any magnitude. The canonical-id field is not tokenizable at all, so
 * no posting can carry its bit either.
 *
 * Caps here drop the *most common* terms and the *weakest* postings. A cap that
 * dropped rare terms would delete exactly the identifiers the index exists to
 * find, while keeping the ones whose IDF already makes them worthless. Every
 * bound that fires is counted, because a silent bound is a recall regression
 * nothing can attribute later.
 */
import { CONTEXT_INDEX_LIMITS, toFixedPoint } from './format.js';
import {
  CONTEXT_LEXICON_FIELD_COUNT,
  CONTEXT_LEXICON_SCHEMA,
  compareLexiconTerms,
  emptyLexiconOmissions,
  freezeLexiconOmissions,
  lexiconFieldConfig,
  lexiconFieldMask,
  refuseLexicon as refuse,
  type ContextLexiconConfig,
  type ContextLexiconFieldId,
  type ContextLexiconOmissions,
  type MutableLexiconOmissions,
} from './lexicon-contract.js';
import {
  bm25fScore,
  bm25fWeightedTermFrequency,
  fromLexiconFixedScore,
  lexiconIdf,
  toLexiconFixedScore,
} from './lexicon-bm25.js';
import { tokenizeLexiconField } from './lexicon-tokenizer.js';

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

/** Delta encoding needs postings sorted ascending, which they are by construction. */
export function encodeLexiconPostingDeltas(nodes: readonly number[]): number[] {
  const deltas: number[] = [];
  let previous = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index] as number;
    deltas.push(index === 0 ? node : node - previous);
    previous = node;
  }
  return deltas;
}

export function decodeLexiconPostingDeltas(
  deltas: readonly number[],
  offset = 0,
  count = deltas.length - offset,
): number[] {
  const nodes: number[] = [];
  let running = 0;
  for (let index = 0; index < count; index += 1) {
    const delta = deltas[offset + index];
    if (delta === undefined) refuse('count_limit', { offset, count, length: deltas.length });
    running = index === 0 ? delta : running + delta;
    nodes.push(running);
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextLexiconFieldText {
  readonly field: ContextLexiconFieldId;
  readonly text: string;
}

export interface ContextLexiconDocument {
  /** Dense node index, matching the node table. */
  readonly node: number;
  readonly fields: readonly ContextLexiconFieldText[];
}

export interface ContextLexiconTermRow {
  readonly term: string;
  readonly documentFrequency: number;
  readonly postingOffset: number;
  readonly postingCount: number;
  /** Fixed-point IDF, so a diagnostic can show why a common term ranks low. */
  readonly idfFixed: number;
}

export interface ContextLexiconPosting {
  readonly node: number;
  readonly fieldMask: number;
  readonly termFrequency: number;
  readonly score: number;
}

export interface ContextLexiconBuildResult {
  readonly schema: typeof CONTEXT_LEXICON_SCHEMA;
  readonly documentCount: number;
  /** Sorted by UTF-16 code unit, which is what makes query-time binary search legal. */
  readonly terms: readonly ContextLexiconTermRow[];
  readonly postings: readonly ContextLexiconPosting[];
  /** Parallel to `postings`; each term's run restarts from an absolute node id. */
  readonly nodeDeltas: readonly number[];
  readonly averageFieldLengthFixed: readonly number[];
  readonly omissions: ContextLexiconOmissions;
}

interface TermStatistics {
  documentFrequency: number;
}

interface DocumentTermStatistics {
  fieldMask: number;
  termFrequency: number;
  perField: number[];
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Two passes on purpose.
 *
 * IDF and average field length are corpus-wide, so no score can be computed
 * until every document has been seen. Holding every document's per-field term
 * frequencies in memory to avoid the second tokenization would cost hundreds of
 * megabytes on the measured 26,973-node graph — the exact resource problem this
 * work is undoing — so the tokenizer runs twice and memory stays bounded by one
 * document.
 */
export function buildContextLexicon(
  documents: readonly ContextLexiconDocument[],
  config: ContextLexiconConfig,
): ContextLexiconBuildResult {
  if (config.fields.length !== CONTEXT_LEXICON_FIELD_COUNT) {
    refuse('config_invalid', { fields: config.fields.length, expected: CONTEXT_LEXICON_FIELD_COUNT });
  }
  if (documents.length > CONTEXT_INDEX_LIMITS.maxNodeCount) {
    refuse('count_limit', { documents: documents.length, limit: CONTEXT_INDEX_LIMITS.maxNodeCount });
  }

  const omissions = emptyLexiconOmissions();
  const statistics = new Map<string, TermStatistics>();
  const fieldTotals = new Array<number>(CONTEXT_LEXICON_FIELD_COUNT).fill(0);
  const seenNodes = new Set<number>();

  for (const document of documents) {
    if (!Number.isInteger(document.node) || document.node < 0) {
      refuse('node_out_of_range', { node: Number.isFinite(document.node) ? document.node : -1 });
    }
    if (seenNodes.has(document.node)) refuse('duplicate_node', { node: document.node });
    seenNodes.add(document.node);

    const inDocument = new Set<string>();
    for (const entry of document.fields) {
      if (!lexiconFieldConfig(config, entry.field).lexical) continue;
      const tokenized = tokenizeLexiconField(entry.text, entry.field, config);
      mergeOmissions(omissions, tokenized.omissions);
      fieldTotals[entry.field] = (fieldTotals[entry.field] ?? 0) + tokenized.terms.length;
      for (const term of tokenized.terms) inDocument.add(term);
    }
    for (const term of inDocument) {
      const found = statistics.get(term);
      if (found === undefined) statistics.set(term, { documentFrequency: 1 });
      else found.documentFrequency += 1;
    }
  }

  const documentCount = documents.length;
  const averageFieldLengthFixed = fieldTotals.map((total) =>
    documentCount > 0 ? toFixedPoint(total / documentCount) : 0,
  );
  // Scoring reads back the rounded value rather than the raw quotient, so the
  // average stored in the index is exactly the one the scores were built from.
  const averageFieldLength = averageFieldLengthFixed.map((value) => fromLexiconFixedScore(value));

  const keptTerms = applyTermCap(statistics, config, omissions);
  const idfByTerm = new Map<string, number>();
  for (const term of keptTerms) {
    const found = statistics.get(term);
    idfByTerm.set(term, lexiconIdf(documentCount, found === undefined ? 0 : found.documentFrequency));
  }

  const buckets = new Map<string, ContextLexiconPosting[]>();
  for (const document of documents) {
    const perTerm = new Map<string, DocumentTermStatistics>();
    const fieldLength = new Array<number>(CONTEXT_LEXICON_FIELD_COUNT).fill(0);

    for (const entry of document.fields) {
      if (!lexiconFieldConfig(config, entry.field).lexical) continue;
      const tokenized = tokenizeLexiconField(entry.text, entry.field, config);
      fieldLength[entry.field] = (fieldLength[entry.field] ?? 0) + tokenized.terms.length;
      for (const term of tokenized.terms) {
        if (!idfByTerm.has(term)) continue;
        let record = perTerm.get(term);
        if (record === undefined) {
          record = { fieldMask: 0, termFrequency: 0, perField: new Array<number>(CONTEXT_LEXICON_FIELD_COUNT).fill(0) };
          perTerm.set(term, record);
        }
        record.fieldMask |= lexiconFieldMask(entry.field);
        record.termFrequency += 1;
        record.perField[entry.field] = (record.perField[entry.field] ?? 0) + 1;
      }
    }

    for (const [term, record] of perTerm) {
      const weighted = bm25fWeightedTermFrequency(record.perField, fieldLength, averageFieldLength, config);
      // A term seen only in non-scored fields contributes nothing. It is still
      // recorded, because the field mask is what lets the anchor lane explain
      // where the hit came from — but its BM25F score is zero, so lexical rank
      // can never be manufactured out of a canonical id.
      const score = toLexiconFixedScore(bm25fScore(weighted, idfByTerm.get(term) ?? 0, config));
      const bucket = buckets.get(term);
      const posting: ContextLexiconPosting = {
        node: document.node,
        fieldMask: record.fieldMask,
        termFrequency: record.termFrequency,
        score,
      };
      if (bucket === undefined) buckets.set(term, [posting]);
      else bucket.push(posting);
    }
  }

  return assemble(keptTerms, buckets, statistics, idfByTerm, averageFieldLengthFixed, documentCount, config, omissions);
}

/** Emits the sorted term table, its postings and their deltas as one pass. */
function assemble(
  keptTerms: ReadonlySet<string>,
  buckets: ReadonlyMap<string, ContextLexiconPosting[]>,
  statistics: ReadonlyMap<string, TermStatistics>,
  idfByTerm: ReadonlyMap<string, number>,
  averageFieldLengthFixed: readonly number[],
  documentCount: number,
  config: ContextLexiconConfig,
  omissions: MutableLexiconOmissions,
): ContextLexiconBuildResult {
  const orderedTerms = [...keptTerms].sort(compareLexiconTerms);
  const terms: ContextLexiconTermRow[] = [];
  const postings: ContextLexiconPosting[] = [];
  const nodeDeltas: number[] = [];

  for (const term of orderedTerms) {
    const bucket = buckets.get(term) ?? [];
    if (bucket.length === 0) continue;
    let kept = bucket;
    if (bucket.length > config.postingCapPerTerm) {
      // Highest score wins; ties break on the node index so the survivor set is
      // a function of the data and not of the order documents were walked.
      kept = [...bucket]
        .sort((left, right) => (right.score - left.score) || (left.node - right.node))
        .slice(0, config.postingCapPerTerm);
      omissions.cappedPostings += bucket.length - kept.length;
    }
    const ascending = [...kept].sort((left, right) => left.node - right.node);
    const offset = postings.length;
    for (const delta of encodeLexiconPostingDeltas(ascending.map((posting) => posting.node))) nodeDeltas.push(delta);
    for (const posting of ascending) postings.push(posting);
    const found = statistics.get(term);
    terms.push({
      term,
      documentFrequency: found === undefined ? ascending.length : found.documentFrequency,
      postingOffset: offset,
      postingCount: ascending.length,
      idfFixed: toFixedPoint(idfByTerm.get(term) ?? 0),
    });
  }

  if (terms.length > CONTEXT_INDEX_LIMITS.maxTermCount) {
    refuse('count_limit', { terms: terms.length, limit: CONTEXT_INDEX_LIMITS.maxTermCount });
  }

  return {
    schema: CONTEXT_LEXICON_SCHEMA,
    documentCount,
    terms: Object.freeze(terms),
    postings: Object.freeze(postings),
    nodeDeltas: Object.freeze(nodeDeltas),
    averageFieldLengthFixed: Object.freeze(averageFieldLengthFixed),
    omissions: freezeLexiconOmissions(omissions),
  };
}

function mergeOmissions(target: MutableLexiconOmissions, source: ContextLexiconOmissions): void {
  target.secretTokens += source.secretTokens;
  target.redactedSpans += source.redactedSpans;
  target.cappedFieldTokens += source.cappedFieldTokens;
  target.cappedCjkNgrams += source.cappedCjkNgrams;
}

/**
 * The dictionary cap drops the *most common* terms first — see the module
 * header. Ties break on code unit so the survivor set does not depend on `Map`
 * insertion order.
 */
function applyTermCap(
  statistics: ReadonlyMap<string, TermStatistics>,
  config: ContextLexiconConfig,
  omissions: MutableLexiconOmissions,
): Set<string> {
  const all = [...statistics.keys()];
  if (all.length <= config.maxTerms) return new Set(all);
  const ranked = all.sort((left, right) => {
    const leftDf = statistics.get(left)?.documentFrequency ?? 0;
    const rightDf = statistics.get(right)?.documentFrequency ?? 0;
    if (leftDf !== rightDf) return leftDf - rightDf;
    return compareLexiconTerms(left, right);
  });
  const kept = ranked.slice(0, config.maxTerms);
  omissions.cappedTerms += all.length - kept.length;
  return new Set(kept);
}

/**
 * Binary search over the sorted term table. This is the replacement for the v1
 * key scan: it is the reason the term table is sorted by code unit at all.
 */
export function lookupLexiconTerm(terms: readonly ContextLexiconTermRow[], term: string): number {
  let low = 0;
  let high = terms.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = terms[middle];
    if (candidate === undefined) return -1;
    const order = compareLexiconTerms(candidate.term, term);
    if (order === 0) return middle;
    if (order < 0) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}
