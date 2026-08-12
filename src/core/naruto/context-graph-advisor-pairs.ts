/**
 * Pair enumeration and fan-out width for the Naruto scope advisory.
 *
 * Split out of `context-graph-advisor.ts` because these three are pure
 * combinatorics over slice ids — they never touch the graph, the reader, or the
 * advice shape — and keeping them beside the advisory's meaning made that file
 * grow every time the retrieval layer underneath it changed.
 */
import {
  CONTEXT_GRAPH_CORRUPT_ERROR,
  CONTEXT_GRAPH_MISSING_ERROR,
  CONTEXT_GRAPH_STALE_ERROR
} from '../triwiki/context-graph/contracts.js';

/** Status to public error code. `fresh` is the only one that is not a refusal. */
export const ERROR_BY_STATUS = {
  fresh: null,
  missing: CONTEXT_GRAPH_MISSING_ERROR,
  stale: CONTEXT_GRAPH_STALE_ERROR,
  corrupt: CONTEXT_GRAPH_CORRUPT_ERROR
} as const;

/** Order-independent key, so `(a,b)` and `(b,a)` name the same pair exactly once. */
export function pairKey(left: string, right: string): string {
  return left < right ? `${left} ${right}` : `${right} ${left}`;
}

export function forEachPair<T extends { id: string }>(rows: readonly T[], visit: (left: T, right: T) => void): void {
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      const a = rows[left];
      const b = rows[right];
      if (a && b) visit(a, b);
    }
  }
}

/** Greedy first wave over the conflict graph; never wider than the slice list the caller proposed. */
export function parallelWidth(sliceIds: readonly string[], unsafe: ReadonlySet<string>): number {
  const wave: string[] = [];
  for (const id of sliceIds) {
    if (wave.some((other) => unsafe.has(pairKey(other, id)))) continue;
    wave.push(id);
  }
  return Math.max(1, Math.min(wave.length, sliceIds.length || 1));
}
