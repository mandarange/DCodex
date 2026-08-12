/**
 * The single tokenizer: run splitting, identifier splitting, CJK segmentation,
 * and the two public entry points that compile time and query time share.
 *
 * Every string operation the v1 engine ran per query — lowercasing, path
 * splitting, basename extraction, camel/snake splitting, acronym synthesis, CJK
 * segmentation — happens here, once, at compile time. Query time is left with a
 * dictionary lookup and a posting merge; the v1 key scan is not made faster, it
 * is deleted.
 *
 * There is exactly one tokenizer because a second one would be a second
 * definition of what a term is, and the two would drift until queries stopped
 * matching the documents they were compiled against. `tokenizeLexiconField` and
 * `normalizeLexiconQuery` differ only in dedupe scope and in whether a machine
 * path is refused or redacted; every splitting rule is shared code.
 *
 * The v1 baseline returned nothing at all for Korean and for jargon queries.
 * "Fast because it found nothing" is not a latency win to preserve, so
 * non-Latin scripts are segmented explicitly rather than falling out of a
 * Latin-only token regex.
 *
 * Both entry points are pure: no clock, no filesystem, no ambient state.
 */
import {
  lexiconFieldConfig,
  refuseLexicon as refuse,
  emptyLexiconOmissions,
  freezeLexiconOmissions,
  type ContextLexiconConfig,
  type ContextLexiconFieldId,
  type ContextLexiconOmissions,
  type MutableLexiconOmissions,
} from './lexicon-contract.js';
import {
  LEXICON_CLASS_CJK,
  LEXICON_CLASS_DIGIT,
  LEXICON_CLASS_LETTER,
  LEXICON_CLASS_LOWER,
  LEXICON_CLASS_SEPARATOR,
  LEXICON_CLASS_UPPER,
  classifyLexiconCodePoint,
  isAllDigits,
  isWorkspaceRelativeLexiconPath,
  looksLikeSecretToken,
  redactMachinePaths,
} from './lexicon-text.js';

const RUN_LATIN = 0;
const RUN_CJK = 1;

interface LexiconRun {
  readonly kind: number;
  readonly value: string;
  /** Separator text immediately preceding this run; `.` drives the extension rule. */
  readonly separator: string;
}

function splitRuns(text: string): LexiconRun[] {
  const runs: LexiconRun[] = [];
  let current = '';
  let currentKind = -1;
  let currentSeparator = '';
  let pending = '';

  const flush = (): void => {
    if (current === '') return;
    runs.push({ kind: currentKind, value: current, separator: currentSeparator });
    current = '';
    currentKind = -1;
    currentSeparator = '';
  };

  for (const char of text) {
    const cls = classifyLexiconCodePoint(char.codePointAt(0) as number);
    if (cls === LEXICON_CLASS_SEPARATOR) {
      flush();
      pending += char;
      continue;
    }
    const kind = cls === LEXICON_CLASS_CJK ? RUN_CJK : RUN_LATIN;
    if (current !== '' && kind !== currentKind) flush();
    if (current === '') {
      currentKind = kind;
      currentSeparator = pending;
      pending = '';
      current = char;
    } else {
      current += char;
    }
  }
  flush();
  return runs;
}

/**
 * camelCase, PascalCase, acronym runs and digit boundaries.
 *
 * `HTTPServer` splits before the last capital of the acronym rather than after
 * it, otherwise the acronym absorbs the first letter of the following word and
 * neither `http` nor `server` is searchable.
 */
export function splitLatinSegments(run: string): string[] {
  const chars = [...run];
  if (chars.length <= 1) return chars.length === 0 ? [] : [run];
  const classes = chars.map((char) => classifyLexiconCodePoint(char.codePointAt(0) as number));

  const cuts: number[] = [];
  for (let index = 1; index < chars.length; index += 1) {
    const previous = classes[index - 1] as number;
    const current = classes[index] as number;
    if (current === LEXICON_CLASS_UPPER && previous !== LEXICON_CLASS_UPPER) {
      cuts.push(index);
      continue;
    }
    if (previous === LEXICON_CLASS_UPPER && (current === LEXICON_CLASS_LOWER || current === LEXICON_CLASS_LETTER)) {
      if (index >= 2 && classes[index - 2] === LEXICON_CLASS_UPPER) cuts.push(index - 1);
      continue;
    }
    if ((current === LEXICON_CLASS_DIGIT) !== (previous === LEXICON_CLASS_DIGIT)) cuts.push(index);
  }

  // Sorted and deduped defensively: the acronym rule emits `index - 1`, and a
  // cut list that is not strictly increasing would silently produce empty or
  // overlapping segments.
  const ordered = [...new Set(cuts)].sort((left, right) => left - right);
  const segments: string[] = [];
  let start = 0;
  for (const cut of ordered) {
    if (cut > start) segments.push(chars.slice(start, cut).join(''));
    start = cut;
  }
  if (start < chars.length) segments.push(chars.slice(start).join(''));
  return segments;
}

export interface ContextLexiconTokenization {
  readonly terms: readonly string[];
  readonly omissions: ContextLexiconOmissions;
}

/**
 * Emission is append-only into an array with a `Set` used for membership only.
 * The array order is what reaches the index, and it is a pure function of the
 * input; the `Set` is never iterated.
 *
 * Dedupe scope is the difference between a document and a query. Within one run
 * the derived forms are deduped, so `graph` is not emitted twice because a
 * camel split and an acronym both produced it. Across runs a document must keep
 * multiplicity: term frequency is the entire input to BM25's saturation curve,
 * and a sink that deduped per field would make every `tf` either 0 or 1 and
 * quietly reduce BM25F to a field-weight lookup. A query has no frequency to
 * express, so it dedupes globally and its cap counts distinct terms.
 */
class TokenSink {
  readonly terms: string[] = [];
  private seen = new Set<string>();
  private capped = false;

  constructor(
    private readonly config: ContextLexiconConfig,
    private readonly omissions: MutableLexiconOmissions,
    private readonly limit: number,
    private readonly distinct: boolean,
  ) {}

  get full(): boolean {
    return this.terms.length >= this.limit;
  }

  /** Ends the previous dedupe scope; a no-op when the sink dedupes globally. */
  beginScope(): void {
    if (!this.distinct) this.seen = new Set<string>();
  }

  push(raw: string): void {
    if (raw === '') return;
    if (raw.length > this.config.maxTokenLength) return;
    if (this.seen.has(raw)) return;
    if (looksLikeSecretToken(raw, this.config)) {
      this.omissions.secretTokens += 1;
      return;
    }
    if (this.full) {
      // Counted once per field: the interesting number is "a field was
      // truncated", and incrementing per dropped token would let one minified
      // blob dominate the telemetry.
      if (!this.capped) {
        this.omissions.cappedFieldTokens += 1;
        this.capped = true;
      }
      return;
    }
    this.seen.add(raw);
    this.terms.push(raw);
  }
}

/** Returns whether the run was refused as key material, for the join below. */
function emitLatinRun(
  run: string,
  sink: TokenSink,
  config: ContextLexiconConfig,
  omissions: MutableLexiconOmissions,
): boolean {
  // Judged on the run, before casing and before splitting. Lowercasing an API
  // key destroys the mixed-case evidence that identifies it, and its camel
  // segments and acronym are just as much of a leak as the key itself, so the
  // whole run is refused rather than each emitted form being re-tested.
  if (looksLikeSecretToken(run, config)) {
    omissions.secretTokens += 1;
    return true;
  }

  const lowered = run.toLowerCase();
  sink.push(lowered);
  // The original casing is kept as its own term so an exact-cased query still
  // has something to bind to; §6.3 requires the raw token to survive.
  if (config.preserveExactCase && run !== lowered) sink.push(run);

  const segments = splitLatinSegments(run);
  if (segments.length <= 1) return false;
  for (const segment of segments) {
    if (segment.length < config.minSegmentLength) continue;
    // A bare number carries no identifier signal — `95` out of `p95` matches
    // every percentile in the workspace — while the whole run above keeps
    // `p95`, `u32` and `v2` searchable.
    if (isAllDigits(segment)) continue;
    sink.push(segment.toLowerCase());
  }

  const initials: string[] = [];
  for (const segment of segments) {
    if (initials.length >= config.maxAcronymSegments) break;
    const first = segment[0];
    if (first === undefined) continue;
    if (classifyLexiconCodePoint(first.codePointAt(0) as number) === LEXICON_CLASS_DIGIT) continue;
    initials.push(first.toLowerCase());
  }
  // A one-letter acronym is a stopword with extra steps: it matches everything
  // and ranks nothing.
  if (initials.length >= config.minAcronymLength) sink.push(initials.join(''));
  return false;
}

function emitCjkRun(
  run: string,
  sink: TokenSink,
  config: ContextLexiconConfig,
  omissions: MutableLexiconOmissions,
): void {
  const points = [...run];
  // A long unspaced run is a sentence, not a word: keeping it whole produces a
  // term with document frequency 1 that no query will ever reproduce.
  if (points.length <= config.maxCjkRunLength) sink.push(run);

  let produced = 0;
  let reported = false;
  for (const size of config.cjkNgramSizes) {
    if (size <= 0 || points.length < size) continue;
    for (let start = 0; start + size <= points.length; start += 1) {
      if (produced >= config.maxCjkNgramsPerRun) {
        if (!reported) {
          omissions.cappedCjkNgrams += 1;
          reported = true;
        }
        return;
      }
      sink.push(points.slice(start, start + size).join(''));
      produced += 1;
    }
  }
}

function emitRuns(
  runs: readonly LexiconRun[],
  sink: TokenSink,
  config: ContextLexiconConfig,
  omissions: MutableLexiconOmissions,
): void {
  // Which runs were refused as key material, recorded on the way past rather
  // than recomputed below: the join is built from the run values, so it needs
  // the verdict `emitLatinRun` already reached about them.
  const refused = new Array<boolean>(runs.length).fill(false);
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index] as LexiconRun;
    sink.beginScope();
    if (run.kind === RUN_CJK) emitCjkRun(run.value, sink, config, omissions);
    else refused[index] = emitLatinRun(run.value, sink, config, omissions);
  }
  sink.beginScope();

  // `context.ts` must be one term as well as two, and it must be produced the
  // same way on both sides: a query typed as `context.ts` is free text, so the
  // rule cannot live in a basename-only branch or the query and the document
  // would tokenize differently and never meet.
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1] as LexiconRun;
    const current = runs[index] as LexiconRun;
    if (current.separator !== '.') continue;
    if (previous.kind !== RUN_LATIN || current.kind !== RUN_LATIN) continue;
    if (current.value.length > config.maxExtensionLength) continue;
    // The refusal is carried forward rather than re-tested on the joined form,
    // because the joined form cannot be tested: `looksLikeSecretToken` returns
    // false for any token holding a non-alphanumeric character, so the `.` makes
    // `<key>.json` pass `TokenSink.push` unconditionally. Without this a run
    // refused on its own would be indexed whole the moment a file extension
    // followed it — lowercased, which is lossless for hex — while the counter
    // reported a drop that did not happen. The count is the one `push` would
    // have made had its own test been able to see the token.
    if (refused[index - 1] || refused[index]) {
      omissions.secretTokens += 1;
      continue;
    }
    sink.push(`${previous.value.toLowerCase()}.${current.value.toLowerCase()}`);
  }
}

/** Tokenizes one field of one document. See the module header for purity. */
export function tokenizeLexiconField(
  value: string,
  field: ContextLexiconFieldId,
  config: ContextLexiconConfig,
): ContextLexiconTokenization {
  const settings = lexiconFieldConfig(config, field);
  if (!settings.lexical) refuse('field_not_lexical', { field });

  const omissions = emptyLexiconOmissions();
  const normalized = value.normalize('NFKC').trim();
  let text = normalized;

  if (settings.pathLike) {
    // Refused rather than redacted: a path field carrying an absolute path is a
    // compiler bug upstream, and quietly indexing the tail of it would hide the
    // bug behind plausible-looking results.
    if (normalized !== '' && !isWorkspaceRelativeLexiconPath(normalized)) {
      refuse('machine_path', { field, length: normalized.length });
    }
  } else {
    const scan = redactMachinePaths(normalized);
    text = scan.text;
    omissions.redactedSpans += scan.redactedSpans;
  }

  const sink = new TokenSink(config, omissions, config.maxTokensPerField, false);
  const runs = splitRuns(text);
  // The joined form only exists to make a multi-word label reachable as one
  // term. On a single-run value it is the run's own token, and pushing it as
  // well would count the term twice — inflating both its frequency and the
  // field length that is supposed to normalize it.
  if (settings.keepWholeValue && runs.length > 1) sink.push(text.toLowerCase());
  emitRuns(runs, sink, config, omissions);

  return { terms: Object.freeze([...sink.terms]), omissions: freezeLexiconOmissions(omissions) };
}

export interface NormalizedLexiconQuery {
  readonly normalized: string;
  readonly terms: readonly string[];
  readonly omissions: ContextLexiconOmissions;
}

/**
 * The one query normalization API required by the card.
 *
 * A query is free text, so it is redacted rather than refused — a user pasting
 * an absolute path should get results for the tail of it, not an error.
 */
export function normalizeLexiconQuery(
  query: string,
  config: ContextLexiconConfig,
): NormalizedLexiconQuery {
  const omissions = emptyLexiconOmissions();
  const normalized = String(query ?? '').normalize('NFKC').trim();
  const scan = redactMachinePaths(normalized);
  omissions.redactedSpans += scan.redactedSpans;

  // Distinct: a query plan carries a term id list, and the same term twice
  // would double that term's contribution to every candidate equally — pure
  // cost, no ranking signal.
  const sink = new TokenSink(config, omissions, config.maxQueryTerms, true);
  emitRuns(splitRuns(scan.text), sink, config, omissions);

  return {
    normalized,
    terms: Object.freeze([...sink.terms]),
    omissions: freezeLexiconOmissions(omissions),
  };
}
