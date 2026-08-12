/**
 * Term dictionary lookup and posting merge — the query-time half of retiring
 * the v1 key scan.
 *
 * Everything expensive about matching a term happened at compile time: the
 * table is sorted, so a term is found by binary search, and a posting run is a
 * byte range rather than a filtered array. What remains here is dictionary
 * lookup and merge, which is all §6.1 leaves for query time.
 */
import { CONTEXT_INDEX_FIXED_POINT_SCALE } from './format.js';
import { CONTEXT_INDEX_TERM_ROW_BYTES } from './writer.js';
import {
  ArrayScoredPostingSlice,
  BufferPostingSlice,
  EMPTY_POSTINGS,
  EMPTY_SCORED_POSTINGS,
} from './reader-cursor.js';
import {
  TERM_ID_AT,
  TERM_POSTING_COUNT_AT,
  TERM_POSTING_START_AT,
  stringIdOf,
  type ContextIndexGeometry,
  type ContextIndexLane,
} from './reader-layout.js';
import {
  CONTEXT_INDEX_FIELD_MASK_ALL,
  type ContextIndexQueryBounds,
  type PostingSlice,
  type ScoredPostingSlice,
} from './reader-types.js';

interface PostingRun {
  readonly start: number;
  readonly count: number;
}

/** Binary search; correct only because the writer sorts term rows ascending. */
function termRun(geometry: ContextIndexGeometry, lane: ContextIndexLane, termId: number): PostingRun | null {
  const base = Number(lane.terms.offset);
  let low = 0;
  let high = lane.terms.count - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const at = base + mid * CONTEXT_INDEX_TERM_ROW_BYTES;
    const probe = geometry.view.getUint32(at + TERM_ID_AT, true);
    if (probe === termId) {
      return {
        start: geometry.view.getUint32(at + TERM_POSTING_START_AT, true),
        count: geometry.view.getUint32(at + TERM_POSTING_COUNT_AT, true),
      };
    }
    if (probe < termId) low = mid + 1;
    else high = mid - 1;
  }
  return null;
}

function postingsFor(geometry: ContextIndexGeometry, lane: ContextIndexLane, termId: number): PostingSlice {
  if (termId < 0) return EMPTY_POSTINGS;
  const run = termRun(geometry, lane, termId);
  if (run === null || run.count === 0) return EMPTY_POSTINGS;
  return new BufferPostingSlice(geometry.view, Number(lane.postings.offset) + run.start * 4, run.count);
}

/**
 * Revision 1's exact table holds canonical node ids only, so a mask with no
 * bits set is the only way it can exclude anything. The parameter is honoured
 * rather than ignored: silently dropping a caller's filter is how a lane ends
 * up returning results the profile said it must not see.
 */
export function exactPostings(
  geometry: ContextIndexGeometry,
  term: string,
  fieldMask: number = CONTEXT_INDEX_FIELD_MASK_ALL,
): PostingSlice {
  if ((fieldMask & CONTEXT_INDEX_FIELD_MASK_ALL) === 0) return EMPTY_POSTINGS;
  return postingsFor(geometry, geometry.exact, stringIdOf(geometry, term));
}

/** Keyed by the node's workspace-relative path, which is what the writer interns. */
export function basenamePostings(geometry: ContextIndexGeometry, term: string): PostingSlice {
  return postingsFor(geometry, geometry.basename, stringIdOf(geometry, term));
}

/**
 * Posting merge with a document-frequency weight.
 *
 * The weight is bounded in `[1, scale]` and derived only from the posting count
 * the index already stores; per-field and term-frequency weights are ranking
 * policy and live in `ranking-config.ts`, applied by the kernel. The reader
 * deliberately embeds no weight constants of its own — a magic number copied
 * here would be a second, invisible ranking config.
 */
export function mergePostings(
  geometry: ContextIndexGeometry,
  lane: ContextIndexLane,
  termIds: readonly number[],
  plan: ContextIndexQueryBounds,
): ScoredPostingSlice {
  const perTerm = Math.max(0, Math.trunc(plan.postingCapPerTerm));
  const budget = Math.max(0, Math.trunc(plan.candidateBudget));
  if (lane.terms.count === 0 || perTerm === 0 || budget === 0 || termIds.length === 0) return EMPTY_SCORED_POSTINGS;

  const postingBase = Number(lane.postings.offset);
  const scores = new Map<number, number>();
  let matchedTerms = 0;
  let truncated = false;
  // Sorted and deduped so the same term set always merges in the same order; an
  // accumulation order that follows the caller's array is a tie-break that
  // changes with the caller.
  for (const termId of [...new Set(termIds)].sort((a, b) => a - b)) {
    const run = termRun(geometry, lane, termId);
    if (run === null || run.count === 0) continue;
    matchedTerms += 1;
    const take = Math.min(run.count, perTerm);
    if (take < run.count) truncated = true;
    const weight = rarityWeight(geometry.nodeCount, run.count);
    for (let index = 0; index < take; index += 1) {
      const node = geometry.view.getUint32(postingBase + (run.start + index) * 4, true);
      scores.set(node, (scores.get(node) ?? 0) + weight);
    }
  }
  if (scores.size === 0) return EMPTY_SCORED_POSTINGS;

  // Ties break on the integer node, which is assigned in sorted node-id order
  // by the writer — so this is exactly "tie-break on the stable node id".
  const ordered = [...scores.keys()].sort((a, b) => (scores.get(b) as number) - (scores.get(a) as number) || a - b);
  if (ordered.length > budget) {
    ordered.length = budget;
    truncated = true;
  }
  const nodes = new Uint32Array(ordered.length);
  const values = new Int32Array(ordered.length);
  for (let index = 0; index < ordered.length; index += 1) {
    const node = ordered[index] as number;
    nodes[index] = node;
    values[index] = scores.get(node) as number;
  }
  return new ArrayScoredPostingSlice(nodes, values, matchedTerms, truncated);
}

function rarityWeight(nodeCount: number, documentFrequency: number): number {
  if (nodeCount === 0 || documentFrequency <= 0) return 1;
  const rare = nodeCount - Math.min(documentFrequency, nodeCount);
  return 1 + Math.floor((CONTEXT_INDEX_FIXED_POINT_SCALE * rare) / nodeCount);
}
