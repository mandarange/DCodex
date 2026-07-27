// Shared error-value helpers.
//
// Dependency-free on purpose: imported from core runtime, CLI, and scripts.

/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * `Error` instances yield their `.message`; anything else is stringified.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Extract a string error code from an unknown thrown value.
 *
 * Values without a `code` property yield an empty string.
 */
export function errorCodeOf(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}
