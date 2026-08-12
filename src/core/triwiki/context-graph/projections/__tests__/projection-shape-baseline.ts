/**
 * The projections' public output shapes, recorded from the v1 engine before the
 * CG2-13 migration and asserted against the migrated ones.
 *
 * Captured by running each projection on the standard fixture at
 * `9fadd4e2 + working tree`, immediately before any of the six files changed.
 * Recorded as a checked-in descriptor rather than as a note, because a note
 * cannot fail: these six sit under `subagents/triwiki-attention.ts`,
 * `triwiki/code-pack.ts`, `align/code-navigation-align.ts` and
 * `commands/wiki-command.ts`, and a field that quietly changes type or
 * disappears breaks all of them at once with nothing to point at.
 *
 * ## What a spec means
 *
 * A leaf is a `|`-separated set of `typeof` names plus `null`; a value must match
 * one of them. An object spec is matched on its **exact key set**, which is the
 * half that catches a disappearing field — a subset check would pass a projection
 * that stopped emitting `provenance`. An array spec checks every element, so an
 * empty array trivially satisfies its element type: emptiness is a fixture fact,
 * never a contract one.
 *
 * `token_cost` is `number` and not `number|null` on purpose. The v1 anchor always
 * emitted one, including for an unresolved anchor where it is `0`, and a consumer
 * summing them would break on a null.
 */

export type ShapeSpec = string | readonly ShapeSpec[] | { readonly [key: string]: ShapeSpec };

const PROVENANCE_REF: ShapeSpec = { path: 'string', line: 'number|undefined', hash: 'string' };

/** `projectContextGraphAnchors` / `projectContextPackAnchors`, resolved or not. */
export const PROJECTED_ATTENTION_ANCHOR_SHAPE: ShapeSpec = {
  id: 'string',
  claim_hash: 'string|null',
  source_hash: 'string|null',
  hydrate_hint: 'string|null',
  reason_path: ['string'],
  trust_score: 'number',
  freshness: 'string',
  token_cost: 'number',
  provenance: [PROVENANCE_REF]
};

export const CODE_PACK_ENTRY_SHAPE: ShapeSpec = {
  id: 'string',
  text: 'string',
  citations: [{ path: 'string', line: 'number|undefined' }],
  trust_score: 'number',
  freshness: 'string',
  token_cost: 'number'
};

export const CODE_PACK_SHAPE: ShapeSpec = {
  schema: 'string',
  generated_at: 'string',
  git_head_sha: 'string|null',
  source_file_count: 'number',
  index_digest: 'string',
  entries: [CODE_PACK_ENTRY_SHAPE],
  token_budget: 'number',
  total_token_cost: 'number'
};

/**
 * `CodePackProjection`. `query` is the one field whose *type* moved: v1 carried a
 * `ContextGraphQueryResult`, the migrated projection carries the kernel receipt.
 * Both are objects and nothing in the repository reads the field, which is why it
 * is recorded as `object|null` rather than pinned to either engine's result.
 */
export const CODE_PACK_PROJECTION_SHAPE: ShapeSpec = {
  pack: CODE_PACK_SHAPE,
  query: 'object|null',
  candidateCount: 'number',
  omittedForBudget: 'number'
};

/** `rankModuleCandidates` / `sortCandidates`. `node` and `members` are node records. */
export const PROJECTION_CANDIDATE_SHAPE: ShapeSpec = {
  node: 'object',
  text: 'string',
  citations: [{ path: 'string', line: 'number|undefined' }],
  members: ['object'],
  reasonPath: ['string'],
  score: 'number'
};

export const WORKSPACE_CODE_PACK_RESULT_SHAPE: ShapeSpec = {
  ok: 'boolean',
  pack: 'object|null',
  errorCode: 'string|null',
  errors: ['string'],
  warnings: ['string'],
  snapshotHash: 'string',
  snapshotFreshness: 'string',
  candidateCount: 'number',
  omittedForBudget: 'number',
  repairCommand: 'string'
};

export const CONTEXT_GRAPH_ATTENTION_RESULT_SHAPE: ShapeSpec = {
  available: 'boolean',
  reason: 'string|null',
  anchors: [PROJECTED_ATTENTION_ANCHOR_SHAPE],
  profile: 'string',
  snapshotHash: 'string|null',
  snapshotFreshness: 'string|null',
  tokenCost: 'number',
  tokenBudget: 'number',
  provenanceCoverage: 'number',
  warnings: ['string'],
  repairCommand: 'string'
};

/**
 * The public failure codes, unchanged by the migration. Recorded separately
 * because "the field is a string" is not the assertion that matters here — the
 * assertion is that it is still *one of these three*, so a consumer branching on
 * `context_graph_missing` keeps working.
 */
export const PROJECTION_FAILURE_CODES: readonly string[] = Object.freeze([
  'context_graph_missing',
  'context_graph_stale',
  'context_graph_corrupt'
]);

function typeNameOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Assert `value` satisfies `spec`, or throw naming the exact field.
 *
 * Throws rather than returning a boolean: a shape mismatch has to name the path
 * that broke, and a failing assertion that only says `false` sends the reader
 * back to diff two JSON blobs by eye.
 */
export function assertProjectionShape(value: unknown, spec: ShapeSpec, at = '$'): void {
  if (typeof spec === 'string') {
    const allowed = spec.split('|');
    const actual = typeNameOf(value);
    if (allowed.includes(actual)) return;
    if (allowed.includes('undefined') && value === undefined) return;
    throw new Error(`${at}: expected ${spec}, found ${actual}`);
  }

  if (Array.isArray(spec)) {
    if (!Array.isArray(value)) throw new Error(`${at}: expected array, found ${typeNameOf(value)}`);
    const element = spec[0];
    if (element === undefined) return;
    value.forEach((item, index) => assertProjectionShape(item, element, `${at}[${index}]`));
    return;
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${at}: expected object, found ${typeNameOf(value)}`);
  }
  const record = value as Record<string, unknown>;
  const expected = spec as Record<string, ShapeSpec>;
  // Exact key set, both directions. A missing key is a removed field; an extra
  // one is a field a consumer will start depending on without it ever having
  // been recorded as part of the contract.
  const optional = new Set(
    Object.keys(expected).filter((key) => typeof expected[key] === 'string' && (expected[key] as string).includes('undefined'))
  );
  for (const key of Object.keys(expected)) {
    if (!(key in record) && !optional.has(key)) throw new Error(`${at}.${key}: field is missing`);
  }
  for (const key of Object.keys(record)) {
    if (!(key in expected)) throw new Error(`${at}.${key}: field is not part of the recorded shape`);
  }
  for (const key of Object.keys(expected)) {
    if (!(key in record) && optional.has(key)) continue;
    assertProjectionShape(record[key], expected[key] as ShapeSpec, `${at}.${key}`);
  }
}
