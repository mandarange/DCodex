// Shared regex text helpers.
//
// Kept dependency-free on purpose: this module is imported from CLI fast paths,
// scripts, and core runtime alike, so it must never pull node builtins into an
// import graph that the import-graph budget gates.

/**
 * Escape a value so it can be embedded literally inside a `RegExp` source.
 *
 * Nullish input yields an empty pattern rather than the string `"undefined"`,
 * matching the intent of the guarded local copies this replaced.
 */
export function escapeRegExp(value: unknown): string {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
