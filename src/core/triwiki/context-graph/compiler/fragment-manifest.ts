/**
 * The fragment manifest document — `sks.context-graph-fragment-manifest.v1`.
 *
 * This is the record that replaces reading the previous full JSON snapshot. A
 * v1 incremental compile loaded `context-graph.json`, diffed it, and carried
 * forward the parts it liked; CRK2 deletes that store (ADR §8), so the only
 * thing an incremental build may consult about the previous build is this
 * manifest plus the content-addressed fragments it names.
 *
 * Two properties make that safe:
 *
 * - **The manifest is total.** Every `(extractor, source)` pair the previous
 *   build considered has an entry, including the ones that produced nothing. An
 *   empty fragment is still a fragment; without that, a file no extractor
 *   handles would look new on every run and the no-op path would never fire.
 * - **The manifest is content-addressed and clock-free.** There is deliberately
 *   no `generatedAt`: the hash lands in the operation journal, and a timestamp
 *   would give two identical builds two different manifest hashes.
 *
 * `identity` is the build's rulebook — graph schema revision, compile config,
 * tokenizer. A fragment produced under one rulebook cannot be reused under
 * another even when its source bytes are identical, because the rules that
 * turned those bytes into nodes changed. That is the quiet corruption the
 * full-rebuild trigger exists to prevent.
 */
import { sha256 } from '../../../fsx.js';
import {
  CONTEXT_FRAGMENT_MANIFEST_FIELD,
  CONTEXT_FRAGMENT_MANIFEST_SCHEMA,
  compareFragmentManifestEntries,
  failManifest,
  parseFragmentManifestEntry,
  requireManifestHash,
  requireManifestRevision,
  sourceFragmentKey,
  type FragmentManifestEntry,
} from './fragment-manifest-schema.js';

export * from './fragment-manifest-schema.js';

/** The rulebook a fragment was produced under. Any change forces a full rebuild. */
export interface FragmentManifestIdentity {
  readonly schemaRevision: string;
  readonly configFingerprint: string;
  readonly tokenizerFingerprint: string;
}

export interface ContextFragmentManifest {
  readonly schema: typeof CONTEXT_FRAGMENT_MANIFEST_SCHEMA;
  readonly identity: FragmentManifestIdentity;
  /** Digest of the whole source inventory this manifest describes. */
  readonly sourceFingerprint: string;
  readonly entries: readonly FragmentManifestEntry[];
}

export interface ContextFragmentManifestInput {
  readonly identity: FragmentManifestIdentity;
  readonly sourceFingerprint: string;
  readonly entries: readonly FragmentManifestEntry[];
}

export function buildFragmentManifestIdentity(input: FragmentManifestIdentity): FragmentManifestIdentity {
  return Object.freeze({
    schemaRevision: requireManifestRevision(input.schemaRevision, CONTEXT_FRAGMENT_MANIFEST_FIELD.schemaRevision),
    configFingerprint: requireManifestHash(input.configFingerprint, CONTEXT_FRAGMENT_MANIFEST_FIELD.configFingerprint),
    tokenizerFingerprint: requireManifestHash(
      input.tokenizerFingerprint,
      CONTEXT_FRAGMENT_MANIFEST_FIELD.tokenizerFingerprint,
    ),
  });
}

/**
 * Digest of `path -> hash` over the whole inventory. Equality here means the
 * workspace did not move at all, which is what licenses the no-op fast path;
 * it is derived rather than accepted from a caller so a caller that under-reports
 * a diff cannot talk the compiler into skipping work.
 */
export function computeSourceInventoryFingerprint(inventory: ReadonlyMap<string, string>): string {
  const rows = [...inventory.entries()].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return sha256(rows.map(([path, hash]) => `${path}\u0000${hash}`).join('\n'));
}

/**
 * Two entries for the same source must agree on that source's hash. They are
 * derived from the same bytes, so disagreement means the manifest was assembled
 * from two different workspace states and no entry in it can be trusted.
 */
function assertEntriesConsistent(entries: readonly FragmentManifestEntry[]): void {
  const seen = new Set<string>();
  const sourceHashes = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    const key = sourceFragmentKey(entry.extractor, entry.sourcePath);
    if (seen.has(key)) failManifest('duplicate_entry', { at: index });
    seen.add(key);
    const known = sourceHashes.get(entry.sourcePath);
    if (known === undefined) sourceHashes.set(entry.sourcePath, entry.sourceHash);
    else if (known !== entry.sourceHash) failManifest('source_hash_divergent', { at: index });
  }
}

export function buildContextFragmentManifest(input: ContextFragmentManifestInput): ContextFragmentManifest {
  const entries = [...input.entries].sort(compareFragmentManifestEntries);
  assertEntriesConsistent(entries);
  return Object.freeze({
    schema: CONTEXT_FRAGMENT_MANIFEST_SCHEMA,
    identity: buildFragmentManifestIdentity(input.identity),
    sourceFingerprint: requireManifestHash(input.sourceFingerprint, CONTEXT_FRAGMENT_MANIFEST_FIELD.sourceFingerprint),
    entries: Object.freeze(entries),
  });
}

export function parseContextFragmentManifest(raw: unknown): ContextFragmentManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) failManifest('manifest_not_object', {});
  const record = raw as Record<string, unknown>;
  if (record.schema !== CONTEXT_FRAGMENT_MANIFEST_SCHEMA) {
    failManifest('schema_mismatch', { field: CONTEXT_FRAGMENT_MANIFEST_FIELD.schema });
  }
  const identity = record.identity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    failManifest('identity_malformed', { field: CONTEXT_FRAGMENT_MANIFEST_FIELD.identity });
  }
  if (!Array.isArray(record.entries)) failManifest('entries_malformed', { field: CONTEXT_FRAGMENT_MANIFEST_FIELD.entries });
  const entries = (record.entries as readonly unknown[]).map(parseFragmentManifestEntry);
  // Order is checked rather than restored: the manifest hash is a content
  // address, so a file whose entries drifted is a different document even though
  // it carries the same facts.
  for (let index = 1; index < entries.length; index += 1) {
    if (compareFragmentManifestEntries(entries[index - 1] as FragmentManifestEntry, entries[index] as FragmentManifestEntry) >= 0) {
      failManifest('entry_order', { at: index });
    }
  }
  assertEntriesConsistent(entries);
  return Object.freeze({
    schema: CONTEXT_FRAGMENT_MANIFEST_SCHEMA,
    identity: buildFragmentManifestIdentity(identity as FragmentManifestIdentity),
    sourceFingerprint: requireManifestHash(record.sourceFingerprint, CONTEXT_FRAGMENT_MANIFEST_FIELD.sourceFingerprint),
    entries: Object.freeze(entries),
  });
}

/** Exactly the bytes the store writes, so the hash and the file can never disagree. */
export function serializeContextFragmentManifest(manifest: ContextFragmentManifest): string {
  return JSON.stringify({
    schema: manifest.schema,
    identity: {
      schemaRevision: manifest.identity.schemaRevision,
      configFingerprint: manifest.identity.configFingerprint,
      tokenizerFingerprint: manifest.identity.tokenizerFingerprint,
    },
    sourceFingerprint: manifest.sourceFingerprint,
    entries: manifest.entries.map((entry) => ({
      extractor: entry.extractor,
      extractorRevision: entry.extractorRevision,
      sourcePath: entry.sourcePath,
      sourceHash: entry.sourceHash,
      fragmentHash: entry.fragmentHash,
      dependencyKeys: [...entry.dependencyKeys],
      nodeCount: entry.nodeCount,
      edgeCount: entry.edgeCount,
    })),
  });
}

export function contextFragmentManifestHash(manifest: ContextFragmentManifest): string {
  return sha256(serializeContextFragmentManifest(manifest));
}

export function fragmentManifestEntryIndex(
  manifest: ContextFragmentManifest,
): ReadonlyMap<string, FragmentManifestEntry> {
  const index = new Map<string, FragmentManifestEntry>();
  for (const entry of manifest.entries) index.set(sourceFragmentKey(entry.extractor, entry.sourcePath), entry);
  return index;
}

/** The previous build's inventory, recovered from the entries rather than stored twice. */
export function fragmentManifestSourceHashes(manifest: ContextFragmentManifest): ReadonlyMap<string, string> {
  const hashes = new Map<string, string>();
  for (const entry of manifest.entries) hashes.set(entry.sourcePath, entry.sourceHash);
  return hashes;
}

export function fragmentManifestExtractorRevisions(
  manifest: ContextFragmentManifest,
): ReadonlyMap<string, string> {
  const revisions = new Map<string, string>();
  for (const entry of manifest.entries) revisions.set(entry.extractor, entry.extractorRevision);
  return revisions;
}
