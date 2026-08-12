/**
 * A structural fingerprint of `SearchResponse`, for the CRK2 consumer migration.
 *
 * The migration replaces the engine under `searchContext`, and a new engine is
 * *supposed* to return different nodes in a different order — CRK2 finds things
 * v1 could not. What may not change is the shape every caller codes against:
 * field names, field types, and whether a field can be absent. Pinning the
 * result set instead would pin v1's behaviour, including the empty `korean` and
 * `jargon` answers the kernel exists to fix.
 *
 * ## Why a merged field map and not a per-response shape
 *
 * The obvious encoding — one shape string per response — is data-dependent in a
 * way that makes it useless here. A response whose only match happens to be a
 * symbol reports `symbol` as always present; the same query answered with a file
 * node reports it as absent. Both are the same contract. So paths are collected
 * across *every* recorded response and merged: a field observed under a parent
 * fewer times than the parent itself was observed is optional, and a field's type
 * is the union of everything seen at that path.
 *
 * The comparison this enables is the one the card actually asks for: no field
 * disappears, no field changes type, and anything new is reported rather than
 * silently accepted.
 *
 * Two object shapes here are *data*, not contract — `skipped.reasons` and
 * `context.graph.omissionReasons` are keyed by whichever omission happened. They
 * collapse to a single `*` path so that "the traversal stopped for a different
 * reason" is not reported as a broken response contract.
 */

/** Object paths whose keys are values rather than contract. `[]` marks an array hop. */
const DYNAMIC_KEY_PATHS: ReadonlySet<string> = new Set([
  '$.skipped.reasons',
  '$.context.graph.omissionReasons',
]);

const ROOT = '$';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeNameOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isPlainObject(value)) return 'object';
  return typeof value;
}

interface Accumulator {
  /** Path -> the set of type names observed at it. */
  readonly types: Map<string, Set<string>>;
  /** Path -> how many times a value was observed at it. Drives optionality. */
  readonly seen: Map<string, number>;
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function visit(value: unknown, path: string, acc: Accumulator): void {
  let types = acc.types.get(path);
  if (types === undefined) {
    types = new Set<string>();
    acc.types.set(path, types);
  }
  types.add(typeNameOf(value));
  bump(acc.seen, path);

  if (Array.isArray(value)) {
    for (const row of value) visit(row, `${path}[]`, acc);
    return;
  }
  if (!isPlainObject(value)) return;
  if (DYNAMIC_KEY_PATHS.has(path)) {
    for (const entry of Object.values(value)) visit(entry, `${path}.*`, acc);
    return;
  }
  for (const key of Object.keys(value).sort()) visit(value[key], `${path}.${key}`, acc);
}

/**
 * The parent of a field path. `$.a.b` -> `$.a`, `$.a[]` -> `$.a`.
 *
 * Optionality is a statement about a field relative to its container, so a field
 * seen 3 times under a container seen 7 times is optional. Comparing against the
 * response count instead would call every field of every match optional.
 */
function parentOf(path: string): string | null {
  if (path === ROOT) return null;
  if (path.endsWith('[]')) return path.slice(0, -2);
  const cut = path.lastIndexOf('.');
  return cut <= 0 ? ROOT : path.slice(0, cut);
}

export type ResponseFieldMap = Readonly<Record<string, string>>;

/**
 * Merge one or more responses into a field map: path -> type union, with `?`
 * appended to a path that was sometimes absent from its container.
 *
 * Pass every recorded response at once. Passing them one at a time and comparing
 * the results would reintroduce exactly the data-dependence this exists to remove.
 */
export function searchResponseFieldMap(responses: readonly unknown[]): ResponseFieldMap {
  const acc: Accumulator = { types: new Map(), seen: new Map() };
  for (const response of responses) visit(response, ROOT, acc);

  const out: Record<string, string> = {};
  for (const [path, types] of [...acc.types].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    const parent = parentOf(path);
    // A `*` path is the value side of a dynamic-key record: its container count
    // is the number of *entries*, not the number of records, so optionality is
    // meaningless there and would always read as false-positive.
    const optional =
      parent !== null && !path.endsWith('.*') && (acc.seen.get(path) ?? 0) < (acc.seen.get(parent) ?? 0);
    out[`${path}${optional ? '?' : ''}`] = [...types].sort().join('|');
  }
  return Object.freeze(out);
}

/**
 * Fields that lost a type, changed type, or vanished between two maps.
 *
 * Additions are returned separately because they are not automatically a break:
 * a new optional field is compatible, a removed one never is. The caller decides
 * what to do with each, which is the point — a comparison that folded both into
 * one boolean would let a removal hide behind an addition.
 */
export interface FieldMapDiff {
  /** Paths present before and absent after, or whose type set shrank or changed. */
  readonly broken: readonly string[];
  readonly added: readonly string[];
}

function pathOf(key: string): string {
  return key.endsWith('?') ? key.slice(0, -1) : key;
}

export function diffResponseFieldMaps(before: ResponseFieldMap, after: ResponseFieldMap): FieldMapDiff {
  const afterByPath = new Map<string, string>();
  for (const [key, types] of Object.entries(after)) afterByPath.set(pathOf(key), types);

  const broken: string[] = [];
  for (const [key, types] of Object.entries(before)) {
    const path = pathOf(key);
    const found = afterByPath.get(path);
    if (found === undefined) {
      broken.push(`${path}: removed (was ${types})`);
      continue;
    }
    // A widened union is still a break for a caller that switched on the old
    // set exhaustively, so any difference is reported rather than only shrinkage.
    if (found !== types) broken.push(`${path}: ${types} -> ${found}`);
  }

  const beforePaths = new Set(Object.keys(before).map(pathOf));
  const added = Object.keys(after)
    .map(pathOf)
    .filter((path) => !beforePaths.has(path));

  return { broken: broken.sort(), added: added.sort() };
}

export interface SearchResponseFingerprint {
  readonly ok: boolean;
  readonly matchCount: number;
  readonly confidences: readonly string[];
  readonly errors: readonly string[];
  readonly repairCommand: string | null;
}

/**
 * The per-query facts that are value parity rather than shape parity.
 *
 * `errors` and `repairCommand` are compared verbatim: ADR §5 fixes the codes and
 * the command, so those may not drift at all. `confidences` is recorded because
 * §4 tightened the mapping and a label move is a reportable change, not a break.
 * `matchCount` is a number so a test can require "still answered" without
 * requiring "answered with the same rows".
 */
export function searchResponseFingerprint(response: unknown): SearchResponseFingerprint {
  const row = isPlainObject(response) ? response : {};
  const context = isPlainObject(row.context) ? row.context : {};
  const matches = Array.isArray(row.matches) ? row.matches : [];
  const errors = Array.isArray(row.errors)
    ? row.errors.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const confidences = new Set<string>();
  for (const match of matches) {
    if (isPlainObject(match) && typeof match.confidence === 'string') confidences.add(match.confidence);
  }

  return {
    ok: row.ok === true,
    matchCount: matches.length,
    confidences: [...confidences].sort(),
    errors: [...errors].sort(),
    repairCommand: typeof context.repairCommand === 'string' ? context.repairCommand : null,
  };
}
