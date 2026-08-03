// Deterministic JSON serialization for hashes and equality checks.
//
// This intentionally preserves array order while sorting object keys. It is
// dependency-free so low-level contracts can share it without coupling to a
// feature-specific module.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
