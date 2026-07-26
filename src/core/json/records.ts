// Shared JSON-shape guards.
//
// Dependency-free on purpose: imported from core runtime, CLI, and scripts.

/**
 * Narrow an unknown value to a plain (non-array, non-null) object.
 *
 * `Boolean(value)` and `value !== null` were both used by the local copies this
 * replaced; they are equivalent here because `null` is the only falsy value
 * whose `typeof` is `'object'`.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Coerce an unknown value to a plain object, or `null` when it is not one.
 *
 * Callers that want a non-null fallback want {@link asRecordOrEmpty} instead —
 * the two were both spelled `asRecord` locally, which is why the difference kept
 * going unnoticed. Import with an alias if the local name matters.
 */
export function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Coerce an unknown value to a plain object, falling back to `{}`. */
export function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
