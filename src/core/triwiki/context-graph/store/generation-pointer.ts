/**
 * The two small records that say what is current: the pointer and the meta.
 *
 * The pointer names the bytes a query may read; the meta describes what those
 * bytes contain. They are separate files because only one of them can be
 * replaced atomically, and the pointer is the one that has to move last.
 *
 * **Divergence is an error, not a tie to break.** If the two disagree about the
 * snapshot, config, or source fingerprint, neither statement is attestable, so
 * `context_index_pointer_meta_divergent` is raised rather than a side being
 * preferred (ADR §6). Preferring one would mean attesting a fingerprint triple
 * that nothing verified.
 *
 * Both records are re-validated on the way in even though this process wrote
 * them: they survive crashes, editors, and half-flushed writes, so on the way
 * back they are untrusted input.
 */
import {
  CONTEXT_INDEX_FORMAT_REVISION,
} from '../runtime-index/format.js';
import { isWorkspaceRelativePosixPath } from '../paths.js';
import { contextIndexMetaPath, contextIndexPointerPath } from './generation-layout.js';
import { readJsonFile } from './generation-io.js';
import { refuseStore, type ContextIndexStoreErrorCode } from './generation-errors.js';
import { isContextOperationHash } from './operation-journal.js';

export const CONTEXT_INDEX_POINTER_SCHEMA = 'sks.context-graph-index-pointer.v1' as const;
export const CONTEXT_INDEX_META_SCHEMA = 'sks.context-graph-index-meta.v1' as const;

export interface ContextIndexIdentity {
  readonly snapshotHash: string;
  readonly configFingerprint: string;
  readonly sourceFingerprint: string;
}

export interface ContextIndexPointer extends ContextIndexIdentity {
  readonly schema: typeof CONTEXT_INDEX_POINTER_SCHEMA;
  readonly formatRevision: number;
  /** Workspace-relative POSIX path of the generation this pointer makes current. */
  readonly generationPath: string;
  /** Retained for incremental merge and audit only — never a fallback target. */
  readonly previousSnapshotHash: string | null;
  readonly indexBytes: number;
  readonly indexChecksum: string;
  readonly committedAt: string;
}

export interface ContextIndexMeta extends ContextIndexIdentity {
  readonly schema: typeof CONTEXT_INDEX_META_SCHEMA;
  readonly formatRevision: number;
  readonly generationPath: string;
  readonly previousSnapshotHash: string | null;
  readonly indexBytes: number;
  readonly indexChecksum: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly termCount: number;
  readonly provenanceCount: number;
  readonly operationId: string;
  readonly committedAt: string;
}

/** Numeric field ids so a rejection can say which field failed without echoing its value. */
const POINTER_FIELD = {
  schema: 1,
  formatRevision: 2,
  snapshotHash: 3,
  configFingerprint: 4,
  sourceFingerprint: 5,
  generationPath: 6,
  previousSnapshotHash: 7,
  indexBytes: 8,
  indexChecksum: 9,
  nodeCount: 10,
  edgeCount: 11,
  termCount: 12,
  provenanceCount: 13,
  operationId: 14,
} as const;

function requireStoreHash(value: unknown, field: number, code: ContextIndexStoreErrorCode): string {
  if (!isContextOperationHash(value)) refuseStore(code, { field });
  return value;
}

function requireStoreCount(value: unknown, field: number, code: ContextIndexStoreErrorCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) refuseStore(code, { field });
  return value;
}

function requireStoreRelativePath(value: unknown, field: number): string {
  if (typeof value !== 'string' || !isWorkspaceRelativePosixPath(value)) refuseStore('unsafe_store_path', { field });
  return value;
}

function parseOptionalHash(value: unknown, field: number, code: ContextIndexStoreErrorCode): string | null {
  if (value === null || value === undefined) return null;
  return requireStoreHash(value, field, code);
}

function requireFormatRevision(value: unknown, code: ContextIndexStoreErrorCode): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) refuseStore(code, { field: POINTER_FIELD.formatRevision });
  // Checked before any other field so an index written by a newer build is
  // reported as an unsupported format instead of as corruption.
  if (value !== CONTEXT_INDEX_FORMAT_REVISION) {
    refuseStore('format_revision_unsupported', { found: value, supported: CONTEXT_INDEX_FORMAT_REVISION });
  }
  return value;
}

export function parseContextIndexPointer(raw: unknown): ContextIndexPointer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuseStore('pointer_malformed', { field: 0 });
  const record = raw as Record<string, unknown>;
  if (record.schema !== CONTEXT_INDEX_POINTER_SCHEMA) {
    refuseStore('pointer_malformed', { field: POINTER_FIELD.schema });
  }
  return Object.freeze({
    schema: CONTEXT_INDEX_POINTER_SCHEMA,
    formatRevision: requireFormatRevision(record.formatRevision, 'pointer_malformed'),
    snapshotHash: requireStoreHash(record.snapshotHash, POINTER_FIELD.snapshotHash, 'pointer_malformed'),
    configFingerprint: requireStoreHash(record.configFingerprint, POINTER_FIELD.configFingerprint, 'pointer_malformed'),
    sourceFingerprint: requireStoreHash(record.sourceFingerprint, POINTER_FIELD.sourceFingerprint, 'pointer_malformed'),
    generationPath: requireStoreRelativePath(record.generationPath, POINTER_FIELD.generationPath),
    previousSnapshotHash: parseOptionalHash(
      record.previousSnapshotHash,
      POINTER_FIELD.previousSnapshotHash,
      'pointer_malformed',
    ),
    indexBytes: requireStoreCount(record.indexBytes, POINTER_FIELD.indexBytes, 'pointer_malformed'),
    indexChecksum: requireStoreHash(record.indexChecksum, POINTER_FIELD.indexChecksum, 'pointer_malformed'),
    committedAt: typeof record.committedAt === 'string' ? record.committedAt : '',
  });
}

export function parseContextIndexMeta(raw: unknown): ContextIndexMeta {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuseStore('meta_malformed', { field: 0 });
  const record = raw as Record<string, unknown>;
  if (record.schema !== CONTEXT_INDEX_META_SCHEMA) refuseStore('meta_malformed', { field: POINTER_FIELD.schema });
  return Object.freeze({
    schema: CONTEXT_INDEX_META_SCHEMA,
    formatRevision: requireFormatRevision(record.formatRevision, 'meta_malformed'),
    snapshotHash: requireStoreHash(record.snapshotHash, POINTER_FIELD.snapshotHash, 'meta_malformed'),
    configFingerprint: requireStoreHash(record.configFingerprint, POINTER_FIELD.configFingerprint, 'meta_malformed'),
    sourceFingerprint: requireStoreHash(record.sourceFingerprint, POINTER_FIELD.sourceFingerprint, 'meta_malformed'),
    generationPath: requireStoreRelativePath(record.generationPath, POINTER_FIELD.generationPath),
    previousSnapshotHash: parseOptionalHash(
      record.previousSnapshotHash,
      POINTER_FIELD.previousSnapshotHash,
      'meta_malformed',
    ),
    indexBytes: requireStoreCount(record.indexBytes, POINTER_FIELD.indexBytes, 'meta_malformed'),
    indexChecksum: requireStoreHash(record.indexChecksum, POINTER_FIELD.indexChecksum, 'meta_malformed'),
    nodeCount: requireStoreCount(record.nodeCount, POINTER_FIELD.nodeCount, 'meta_malformed'),
    edgeCount: requireStoreCount(record.edgeCount, POINTER_FIELD.edgeCount, 'meta_malformed'),
    termCount: requireStoreCount(record.termCount, POINTER_FIELD.termCount, 'meta_malformed'),
    provenanceCount: requireStoreCount(record.provenanceCount, POINTER_FIELD.provenanceCount, 'meta_malformed'),
    operationId: requireStoreHash(record.operationId, POINTER_FIELD.operationId, 'meta_malformed'),
    committedAt: typeof record.committedAt === 'string' ? record.committedAt : '',
  });
}

/** The divergence check itself; see this module's header for why it never picks a side. */
export function assertContextIndexPointerMetaAgreement(
  pointer: ContextIndexPointer,
  meta: ContextIndexMeta,
): void {
  const snapshotAgrees = pointer.snapshotHash === meta.snapshotHash;
  const configAgrees = pointer.configFingerprint === meta.configFingerprint;
  const sourceAgrees = pointer.sourceFingerprint === meta.sourceFingerprint;
  if (snapshotAgrees && configAgrees && sourceAgrees) return;
  refuseStore('pointer_meta_divergent', {
    snapshot: snapshotAgrees ? 1 : 0,
    config: configAgrees ? 1 : 0,
    source: sourceAgrees ? 1 : 0,
  });
}

export async function readContextIndexPointer(root: string): Promise<ContextIndexPointer | null> {
  const raw = await readJsonFile(contextIndexPointerPath(root));
  if (raw === null) return null;
  return parseContextIndexPointer(raw);
}

export async function readContextIndexMeta(root: string): Promise<ContextIndexMeta | null> {
  const raw = await readJsonFile(contextIndexMetaPath(root));
  if (raw === null) return null;
  return parseContextIndexMeta(raw);
}

export interface LenientContextIndexPointer {
  readonly pointer: ContextIndexPointer | null;
  readonly present: boolean;
}

/**
 * Compile-side read. An unreadable pointer is reported as "present but not
 * understood" rather than thrown, because the compile that reads it is about to
 * replace it with a fully rebuilt generation. That is a replacement, not an
 * in-place repair — the corrupt bytes are never parsed for salvage.
 */
export async function readContextIndexPointerLenient(root: string): Promise<LenientContextIndexPointer> {
  const raw = await readJsonFile(contextIndexPointerPath(root));
  if (raw === null) return { pointer: null, present: false };
  try {
    return { pointer: parseContextIndexPointer(raw), present: true };
  } catch {
    return { pointer: null, present: true };
  }
}
