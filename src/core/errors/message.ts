// Shared error-message helpers.
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
