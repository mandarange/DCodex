import { CONTEXT_GRAPH_REPAIR_COMMAND } from '../contracts.js';
/**
 * Field discipline and per-entry schema for `sks.context-graph-fragment-manifest.v1`.
 *
 * The manifest is what makes fragment reuse *safe* rather than merely fast. Every
 * entry answers one question — "may I skip re-extracting this source with this
 * extractor?" — and a wrong answer is silent graph corruption, not a slow build.
 * So three rules are enforced here rather than trusted:
 *
 * - **Strict decode on the way back in.** The file survives crashes, editors, and
 *   half-flushed writes; on the way back it is untrusted input even though this
 *   process wrote it.
 * - **Total order, enforced on parse.** The manifest is content-addressed and its
 *   hash lands in the operation journal. An entry list that drifted out of order
 *   would hash differently while describing the same build, so order is part of
 *   the schema, not a rendering choice.
 * - **No path outside the workspace, no prose, no secret** (work order §1.4).
 *   Paths are workspace-relative POSIX only, hashes are hex, counts are integers,
 *   and errors carry numeric field ids rather than the values that failed.
 */
import { compareContextGraphIds } from '../ids.js';
import { isWorkspaceRelativePosixPath } from '../paths.js';

export const CONTEXT_FRAGMENT_MANIFEST_SCHEMA = 'sks.context-graph-fragment-manifest.v1' as const;

/** A fragment that declares thousands of reads has stopped being incremental; refuse rather than carry it. */
export const CONTEXT_FRAGMENT_MANIFEST_MAX_DEPENDENCY_KEYS = 4096;
export const CONTEXT_FRAGMENT_MANIFEST_MAX_COUNT = 10_000_000;
export const CONTEXT_FRAGMENT_MANIFEST_MAX_PATH_LENGTH = 1024;

export const CONTEXT_FRAGMENT_MANIFEST_ERRORS = {
  manifest_unreadable: 'context_fragment_manifest_corrupt',
  manifest_not_object: 'context_fragment_manifest_corrupt',
  schema_mismatch: 'context_fragment_manifest_corrupt',
  identity_malformed: 'context_fragment_manifest_corrupt',
  entries_malformed: 'context_fragment_manifest_corrupt',
  entry_not_object: 'context_fragment_manifest_corrupt',
  entry_order: 'context_fragment_manifest_corrupt',
  duplicate_entry: 'context_fragment_manifest_corrupt',
  source_hash_divergent: 'context_fragment_manifest_corrupt',
  extractor_malformed: 'context_fragment_manifest_corrupt',
  revision_malformed: 'context_fragment_manifest_corrupt',
  path_unsafe: 'context_fragment_manifest_corrupt',
  hash_malformed: 'context_fragment_manifest_corrupt',
  dependency_keys_malformed: 'context_fragment_manifest_corrupt',
  count_malformed: 'context_fragment_manifest_corrupt',
} as const;

export type ContextFragmentManifestErrorCode = keyof typeof CONTEXT_FRAGMENT_MANIFEST_ERRORS;

/**
 * A damaged manifest costs a full rebuild, never a wrong graph, so the repair is
 * the ordinary compile rather than an index rebuild.
 */
export const CONTEXT_FRAGMENT_MANIFEST_REPAIR_COMMAND = CONTEXT_GRAPH_REPAIR_COMMAND;

/**
 * Numeric field ids so a rejection can say *which* field failed without echoing
 * its value. Entries hold workspace paths and hashes; a `string` in an error
 * payload is how those reach a log.
 */
export const CONTEXT_FRAGMENT_MANIFEST_FIELD = {
  schema: 1,
  identity: 2,
  schemaRevision: 3,
  configFingerprint: 4,
  tokenizerFingerprint: 5,
  sourceFingerprint: 6,
  entries: 7,
  extractor: 8,
  extractorRevision: 9,
  sourcePath: 10,
  sourceHash: 11,
  fragmentHash: 12,
  dependencyKeys: 13,
  nodeCount: 14,
  edgeCount: 15,
} as const;

export class ContextFragmentManifestError extends Error {
  readonly code: ContextFragmentManifestErrorCode;
  readonly publicCode: string;
  readonly repairCommand: string;
  readonly detail: Readonly<Record<string, number>>;

  constructor(code: ContextFragmentManifestErrorCode, detail: Record<string, number> = {}) {
    super(code);
    this.name = 'ContextFragmentManifestError';
    this.code = code;
    this.publicCode = CONTEXT_FRAGMENT_MANIFEST_ERRORS[code];
    this.repairCommand = CONTEXT_FRAGMENT_MANIFEST_REPAIR_COMMAND;
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(detail)) {
      if (Number.isFinite(value)) numeric[key] = value;
    }
    this.detail = Object.freeze(numeric);
  }
}

export function failManifest(code: ContextFragmentManifestErrorCode, detail: Record<string, number> = {}): never {
  throw new ContextFragmentManifestError(code, detail);
}

// ---------------------------------------------------------------------------
// Field discipline
// ---------------------------------------------------------------------------

/** Hex only: a hash field is the one place a caller might be tempted to pass a label. */
const HASH_PATTERN = /^[0-9a-f]{16,64}$/;
/** Machine codes, matching the closed vocabulary the journal and event log enforce. */
const EXTRACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,31}$/;

export function isFragmentManifestHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

export function requireManifestHash(value: unknown, field: number): string {
  if (!isFragmentManifestHash(value)) failManifest('hash_malformed', { field });
  return value;
}

export function requireManifestRevision(value: unknown, field: number): string {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) failManifest('revision_malformed', { field });
  return value;
}

export function requireExtractorId(value: unknown): string {
  if (typeof value !== 'string' || !EXTRACTOR_PATTERN.test(value)) {
    failManifest('extractor_malformed', { field: CONTEXT_FRAGMENT_MANIFEST_FIELD.extractor });
  }
  return value;
}

/**
 * Workspace-relative POSIX, and already canonical. `./a.ts` and `a.ts` name the
 * same file but hash and key differently, so a manifest that accepted both would
 * hold two entries for one source and reuse the wrong one.
 */
export function requireSourcePath(value: unknown, field: number): string {
  if (typeof value !== 'string' || !isWorkspaceRelativePosixPath(value)) failManifest('path_unsafe', { field, reason: 0 });
  if (value.length > CONTEXT_FRAGMENT_MANIFEST_MAX_PATH_LENGTH) failManifest('path_unsafe', { field, reason: 1 });
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') failManifest('path_unsafe', { field, reason: 2 });
  }
  return value;
}

export function requireManifestCount(value: unknown, field: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) failManifest('count_malformed', { field });
  if (value > CONTEXT_FRAGMENT_MANIFEST_MAX_COUNT) failManifest('count_malformed', { field, over: 1 });
  return value;
}

/**
 * Sorted and unique on the way in as well as out. Dependency keys are hashed into
 * the manifest, so two builds that read the same files in a different order must
 * still produce the same bytes.
 */
export function requireDependencyKeys(value: unknown, sorted: boolean): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) {
    failManifest('dependency_keys_malformed', { field: CONTEXT_FRAGMENT_MANIFEST_FIELD.dependencyKeys, reason: 0 });
  }
  if (value.length > CONTEXT_FRAGMENT_MANIFEST_MAX_DEPENDENCY_KEYS) {
    failManifest('dependency_keys_malformed', { count: value.length, limit: CONTEXT_FRAGMENT_MANIFEST_MAX_DEPENDENCY_KEYS });
  }
  const keys: string[] = [];
  for (const entry of value) {
    keys.push(requireSourcePath(entry, CONTEXT_FRAGMENT_MANIFEST_FIELD.dependencyKeys));
  }
  if (!sorted) return Object.freeze([...new Set(keys)].sort(compareContextGraphIds));
  for (let index = 1; index < keys.length; index += 1) {
    if (compareContextGraphIds(keys[index - 1] as string, keys[index] as string) >= 0) {
      failManifest('dependency_keys_malformed', { at: index, reason: 1 });
    }
  }
  return Object.freeze(keys);
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/**
 * One `(extractor, sourcePath)` pair. `dependencyKeys` is the extractor's
 * declared **read set** for this source: every other file whose content the
 * fragment's correctness depends on. Reuse is decided from that set, so an
 * extractor that reads a file without declaring it will see stale fragments
 * survive a change — the one way this design can be wrong.
 */
export interface FragmentManifestEntry {
  readonly extractor: string;
  readonly extractorRevision: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly fragmentHash: string;
  readonly dependencyKeys: readonly string[];
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface FragmentManifestEntryInput {
  readonly extractor: string;
  readonly extractorRevision: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly fragmentHash: string;
  readonly dependencyKeys?: readonly string[] | undefined;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

/** NUL separator: it cannot occur in an extractor id or a workspace path, so the key is unambiguous. */
export function sourceFragmentKey(extractor: string, sourcePath: string): string {
  return `${extractor}\u0000${sourcePath}`;
}

export function compareFragmentManifestEntries(left: FragmentManifestEntry, right: FragmentManifestEntry): number {
  const byExtractor = compareContextGraphIds(left.extractor, right.extractor);
  return byExtractor !== 0 ? byExtractor : compareContextGraphIds(left.sourcePath, right.sourcePath);
}

function freezeEntry(input: FragmentManifestEntryInput, sortedKeys: boolean): FragmentManifestEntry {
  return Object.freeze({
    extractor: requireExtractorId(input.extractor),
    extractorRevision: requireManifestRevision(input.extractorRevision, CONTEXT_FRAGMENT_MANIFEST_FIELD.extractorRevision),
    sourcePath: requireSourcePath(input.sourcePath, CONTEXT_FRAGMENT_MANIFEST_FIELD.sourcePath),
    sourceHash: requireManifestHash(input.sourceHash, CONTEXT_FRAGMENT_MANIFEST_FIELD.sourceHash),
    fragmentHash: requireManifestHash(input.fragmentHash, CONTEXT_FRAGMENT_MANIFEST_FIELD.fragmentHash),
    dependencyKeys: requireDependencyKeys(input.dependencyKeys, sortedKeys),
    nodeCount: requireManifestCount(input.nodeCount, CONTEXT_FRAGMENT_MANIFEST_FIELD.nodeCount),
    edgeCount: requireManifestCount(input.edgeCount, CONTEXT_FRAGMENT_MANIFEST_FIELD.edgeCount),
  });
}

/** Normalizing constructor: dependency keys are sorted and deduped for the caller. */
export function buildFragmentManifestEntry(input: FragmentManifestEntryInput): FragmentManifestEntry {
  return freezeEntry(input, false);
}

/** Strict decode: an already-written entry must already be canonical. */
export function parseFragmentManifestEntry(raw: unknown): FragmentManifestEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) failManifest('entry_not_object', {});
  const record = raw as Record<string, unknown>;
  return freezeEntry(
    {
      extractor: record.extractor as string,
      extractorRevision: record.extractorRevision as string,
      sourcePath: record.sourcePath as string,
      sourceHash: record.sourceHash as string,
      fragmentHash: record.fragmentHash as string,
      dependencyKeys: record.dependencyKeys as readonly string[] | undefined,
      nodeCount: record.nodeCount as number,
      edgeCount: record.edgeCount as number,
    },
    true,
  );
}
