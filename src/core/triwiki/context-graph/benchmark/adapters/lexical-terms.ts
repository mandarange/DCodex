/**
 * Query term extraction for the measurement-only lexical baseline.
 *
 * MEASUREMENT INSTRUMENT ONLY. Nothing in this directory is a production
 * retrieval path and nothing outside `benchmark/adapters/` may import it.
 *
 * The retired pre-graph context mode regex-escaped the *whole* question and
 * searched for that one literal phrase, which finds nothing for any
 * natural-language query. Reproducing that verbatim would hand the graph a
 * strawman: every case would be won 1.00 to 0.00 for reasons that say nothing
 * about retrieval quality. So the baseline is deliberately given the strongest
 * honest lexical reading of a question — the terms a person would actually grep
 * for — and the comparison is made against that.
 */

/**
 * Words that carry no retrieval signal in a "where is X / what depends on Y"
 * question. Kept small and closed: an aggressive list would quietly tune the
 * baseline down, which is the failure mode this whole file exists to avoid.
 */
export const LEXICAL_STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'affected', 'affects', 'all', 'always', 'and', 'any', 'anything', 'are', 'be',
  'been', 'both', 'but', 'by', 'can', 'change', 'changed', 'changes', 'changing', 'consistent',
  'current', 'depend', 'depends', 'do', 'does', 'each', 'every', 'for', 'from', 'has', 'have',
  'how', 'if', 'in', 'into', 'is', 'it', 'its', 'must', 'no', 'not', 'of', 'on', 'one', 'only',
  'or', 'other', 'out', 'over', 'same', 'should', 'stay', 'such', 'than', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'two', 'up', 'use', 'used',
  'was', 'we', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would',
  'you', 'your'
]);

/** Upper bound on the terms a single query may contribute; keeps the regex and the scan bounded. */
export const MAX_LEXICAL_TERMS = 12;

/** Terms shorter than this are noise in a code repository (`is`, `of`, `id`). */
export const MIN_LEXICAL_TERM_LENGTH = 3;

const SPLIT_PATTERN = /[^A-Za-z0-9_$]+/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Distinct, lowercased, stop-word-free terms in first-appearance order.
 * First-appearance order (not frequency order) keeps the result a pure function
 * of the question text, so two runs of the same case build the same regex.
 */
export function lexicalQueryTerms(query: string, max: number = MAX_LEXICAL_TERMS): string[] {
  const limit = Number.isFinite(max) && max > 0 ? Math.trunc(max) : MAX_LEXICAL_TERMS;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(query ?? '').split(SPLIT_PATTERN)) {
    if (out.length >= limit) break;
    const term = raw.toLowerCase();
    if (term.length < MIN_LEXICAL_TERM_LENGTH) continue;
    if (LEXICAL_STOP_WORDS.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

/**
 * One alternation over the escaped terms. Returns an empty string when there is
 * nothing to search for, which the caller must treat as "no text channel"
 * rather than as "match everything".
 */
export function lexicalAlternationPattern(terms: readonly string[]): string {
  const parts: string[] = [];
  for (const term of terms) {
    const escaped = escapeRegex(term);
    if (escaped && !parts.includes(escaped)) parts.push(escaped);
  }
  return parts.join('|');
}

/** How many distinct terms occur in `haystack`. Case-insensitive, substring semantics. */
export function lexicalTermHits(haystack: string, terms: readonly string[]): number {
  if (!haystack) return 0;
  const lowered = haystack.toLowerCase();
  let hits = 0;
  for (const term of terms) if (lowered.includes(term)) hits += 1;
  return hits;
}
