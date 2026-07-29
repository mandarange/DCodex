// Shared string-list helpers.
//
// Dependency-free on purpose: imported from core runtime, CLI, and scripts.

/** De-duplicate values by identity, preserving their original order. */
export function uniqueValues<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Stringify, trim, drop empties, and de-duplicate — input order preserved.
 *
 * Order matters to some callers, so the sorted behaviour lives in
 * {@link uniqueStringsSorted} rather than being folded in here.
 */
export function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

/** As {@link uniqueStrings}, then sorted — for deterministic receipts/digests. */
export function uniqueStringsSorted(values: readonly unknown[]): string[] {
  return uniqueStrings(values).sort();
}
