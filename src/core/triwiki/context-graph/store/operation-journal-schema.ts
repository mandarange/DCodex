/**
 * Schema, field discipline, and phase algebra for the compile operation journal.
 *
 * The journal is the durable record of an index compile in flight, and after a
 * crash it is the only evidence of what that compile was doing. Everything in
 * this module exists to make sure it cannot lie:
 *
 * - **Strict decode on the way back in.** Every field is re-validated even
 *   though this process wrote it; the file survives crashes, editors, and
 *   half-flushed writes, so on the way back it is untrusted input.
 * - **Forward-only phases.** A journal that could go back to `merged` after
 *   `committed` would tell the next compile to rebuild over a generation that is
 *   already current.
 * - **No path, no prose, no secret.** Every field is a hash, a machine code, a
 *   count, or a workspace-relative POSIX path, and errors carry numeric field
 *   ids rather than values (work order §1.4). The operation id is a digest for
 *   the same reason: a digest cannot carry an absolute path or an environment
 *   value even by accident.
 */
import { sha256 } from '../../../fsx.js';
import { isWorkspaceRelativePosixPath } from '../paths.js';

export const CONTEXT_OPERATION_JOURNAL_SCHEMA = 'sks.context-graph-operation.v2' as const;

/** The phase sequence is total and ordered; a compile only ever moves forward. */
export const CONTEXT_OPERATION_PHASES = [
  'prepared',
  'extracted',
  'merged',
  'indexed',
  'committed',
  'cleaned',
] as const;

export type ContextOperationPhase = (typeof CONTEXT_OPERATION_PHASES)[number];

/** Phase at which a temp index exists, is complete, and has been verified. */
export const CONTEXT_OPERATION_RESUMABLE_PHASE: ContextOperationPhase = 'indexed';

export const CONTEXT_OPERATION_MAX_BLOCKERS = 32;

const PHASE_RANK: ReadonlyMap<string, number> = new Map(
  CONTEXT_OPERATION_PHASES.map((phase, rank) => [phase as string, rank]),
);

export function contextOperationPhaseRank(phase: ContextOperationPhase): number {
  return PHASE_RANK.get(phase) as number;
}

export function isContextOperationPhase(value: unknown): value is ContextOperationPhase {
  return typeof value === 'string' && PHASE_RANK.has(value);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const CONTEXT_OPERATION_JOURNAL_ERRORS = {
  journal_unreadable: 'context_operation_journal_corrupt',
  journal_not_object: 'context_operation_journal_corrupt',
  schema_mismatch: 'context_operation_journal_corrupt',
  operation_id_malformed: 'context_operation_journal_corrupt',
  hash_malformed: 'context_operation_journal_corrupt',
  phase_unknown: 'context_operation_journal_corrupt',
  phase_regression: 'context_operation_journal_corrupt',
  temp_index_unsafe: 'context_operation_journal_corrupt',
  blockers_malformed: 'context_operation_journal_corrupt',
  timestamp_malformed: 'context_operation_journal_corrupt',
} as const;

export type ContextOperationJournalErrorCode = keyof typeof CONTEXT_OPERATION_JOURNAL_ERRORS;

export const CONTEXT_OPERATION_JOURNAL_REPAIR_COMMAND = 'sks align run --rebuild-index' as const;

/**
 * Numeric field ids so a rejection can say *which* field failed without ever
 * echoing the field's value. The journal holds workspace paths and hashes; a
 * `string` in an error payload is how those end up in a log.
 */
export const CONTEXT_OPERATION_JOURNAL_FIELD = {
  schema: 1,
  operationId: 2,
  baseSnapshotHash: 3,
  targetSnapshotHash: 4,
  phase: 5,
  tempIndex: 6,
  indexChecksum: 7,
  fragmentManifestHash: 8,
  configFingerprint: 9,
  sourceFingerprint: 10,
  startedAt: 11,
  blockers: 12,
} as const;

export class ContextOperationJournalError extends Error {
  readonly code: ContextOperationJournalErrorCode;
  readonly publicCode: string;
  readonly repairCommand: string;
  readonly detail: Readonly<Record<string, number>>;

  constructor(code: ContextOperationJournalErrorCode, detail: Record<string, number> = {}) {
    super(code);
    this.name = 'ContextOperationJournalError';
    this.code = code;
    this.publicCode = CONTEXT_OPERATION_JOURNAL_ERRORS[code];
    this.repairCommand = CONTEXT_OPERATION_JOURNAL_REPAIR_COMMAND;
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(detail)) {
      if (Number.isFinite(value)) numeric[key] = value;
    }
    this.detail = Object.freeze(numeric);
  }
}

function fail(code: ContextOperationJournalErrorCode, detail?: Record<string, number>): never {
  throw new ContextOperationJournalError(code, detail);
}

// ---------------------------------------------------------------------------
// Field discipline
// ---------------------------------------------------------------------------

/** Hex only: a hash field is the one place a caller might be tempted to pass a label. */
const HASH_PATTERN = /^[0-9a-f]{16,64}$/;
const OPERATION_ID_PATTERN = /^[0-9a-f]{16,64}$/;
/** Machine codes, matching the closed vocabulary the event log already enforces. */
const BLOCKER_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function isContextOperationHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function requireHash(value: unknown, field: number): string {
  if (!isContextOperationHash(value)) fail('hash_malformed', { field });
  return value;
}

function requireOptionalHash(value: unknown, field: number): string | null {
  if (value === null || value === undefined) return null;
  if (!isContextOperationHash(value)) fail('hash_malformed', { field });
  return value;
}

/**
 * The temp index path travels into the workspace as text. Anything absolute, any
 * `..` hop, and any `~` prefix is refused here so a later `path.join` cannot be
 * talked into writing — or deleting — outside the workspace.
 */
function requireTempIndex(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    fail('temp_index_unsafe', { field: CONTEXT_OPERATION_JOURNAL_FIELD.tempIndex, reason: 0 });
  }
  if (!isWorkspaceRelativePosixPath(value)) {
    fail('temp_index_unsafe', { field: CONTEXT_OPERATION_JOURNAL_FIELD.tempIndex, reason: 1 });
  }
  return value;
}

function requireBlockers(value: unknown): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) fail('blockers_malformed', { field: CONTEXT_OPERATION_JOURNAL_FIELD.blockers });
  if (value.length > CONTEXT_OPERATION_MAX_BLOCKERS) {
    fail('blockers_malformed', { count: value.length, limit: CONTEXT_OPERATION_MAX_BLOCKERS });
  }
  const codes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !BLOCKER_PATTERN.test(entry)) {
      fail('blockers_malformed', { at: codes.length });
    }
    if (!codes.includes(entry)) codes.push(entry);
  }
  return Object.freeze(codes);
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    fail('timestamp_malformed', { field: CONTEXT_OPERATION_JOURNAL_FIELD.startedAt });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Journal record
// ---------------------------------------------------------------------------

export interface ContextOperationJournal {
  readonly schema: typeof CONTEXT_OPERATION_JOURNAL_SCHEMA;
  readonly operationId: string;
  /** Snapshot hash the current pointer held when the operation began; `null` when nothing was current. */
  readonly baseSnapshotHash: string | null;
  readonly targetSnapshotHash: string;
  readonly phase: ContextOperationPhase;
  /** Workspace-relative POSIX path of the staged index. */
  readonly tempIndex: string;
  /** Whole-file checksum, set once the temp index is written and verified. */
  readonly indexChecksum: string | null;
  readonly fragmentManifestHash: string | null;
  readonly configFingerprint: string;
  readonly sourceFingerprint: string;
  /** Informational only. No recovery decision may read this field. */
  readonly startedAt: string;
  readonly blockers: readonly string[];
}

export interface ContextOperationIdentity {
  readonly baseSnapshotHash: string | null;
  readonly targetSnapshotHash: string;
  readonly configFingerprint: string;
  readonly sourceFingerprint: string;
}

/**
 * Content-addressed operation id.
 *
 * Deterministic so that re-running the same compile after a crash lands on the
 * same id and the same temp path — resume becomes a lookup instead of a guess,
 * and a repeated operation is idempotent by construction. A digest also cannot
 * carry a path or a secret, which is what §1.4 requires of this field.
 */
export function deriveContextOperationId(identity: ContextOperationIdentity): string {
  const material = [
    identity.baseSnapshotHash ?? '-',
    identity.targetSnapshotHash,
    identity.configFingerprint,
    identity.sourceFingerprint,
  ].join('\n');
  return sha256(material).slice(0, 32);
}

export interface ContextOperationJournalInput {
  readonly operationId?: string | undefined;
  readonly baseSnapshotHash: string | null;
  readonly targetSnapshotHash: string;
  readonly configFingerprint: string;
  readonly sourceFingerprint: string;
  readonly tempIndex: string;
  readonly phase?: ContextOperationPhase | undefined;
  readonly indexChecksum?: string | null | undefined;
  readonly fragmentManifestHash?: string | null | undefined;
  readonly startedAt: string;
  readonly blockers?: readonly string[] | undefined;
}

export function buildContextOperationJournal(input: ContextOperationJournalInput): ContextOperationJournal {
  const identity: ContextOperationIdentity = {
    baseSnapshotHash: requireOptionalHash(input.baseSnapshotHash, CONTEXT_OPERATION_JOURNAL_FIELD.baseSnapshotHash),
    targetSnapshotHash: requireHash(input.targetSnapshotHash, CONTEXT_OPERATION_JOURNAL_FIELD.targetSnapshotHash),
    configFingerprint: requireHash(input.configFingerprint, CONTEXT_OPERATION_JOURNAL_FIELD.configFingerprint),
    sourceFingerprint: requireHash(input.sourceFingerprint, CONTEXT_OPERATION_JOURNAL_FIELD.sourceFingerprint),
  };
  const operationId = input.operationId ?? deriveContextOperationId(identity);
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    fail('operation_id_malformed', { field: CONTEXT_OPERATION_JOURNAL_FIELD.operationId });
  }
  const phase = input.phase ?? 'prepared';
  if (!isContextOperationPhase(phase)) fail('phase_unknown', { field: CONTEXT_OPERATION_JOURNAL_FIELD.phase });

  return Object.freeze({
    schema: CONTEXT_OPERATION_JOURNAL_SCHEMA,
    operationId,
    baseSnapshotHash: identity.baseSnapshotHash,
    targetSnapshotHash: identity.targetSnapshotHash,
    phase,
    tempIndex: requireTempIndex(input.tempIndex),
    indexChecksum: requireOptionalHash(input.indexChecksum, CONTEXT_OPERATION_JOURNAL_FIELD.indexChecksum),
    fragmentManifestHash: requireOptionalHash(
      input.fragmentManifestHash,
      CONTEXT_OPERATION_JOURNAL_FIELD.fragmentManifestHash,
    ),
    configFingerprint: identity.configFingerprint,
    sourceFingerprint: identity.sourceFingerprint,
    startedAt: requireTimestamp(input.startedAt),
    blockers: requireBlockers(input.blockers),
  });
}

/**
 * Strict decode of an on-disk journal. Every field is re-validated even though
 * this process wrote it: the file survives crashes, editors, and half-flushed
 * writes, so on the way back in it is untrusted input.
 */
export function parseContextOperationJournal(raw: unknown): ContextOperationJournal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('journal_not_object', {});
  const record = raw as Record<string, unknown>;
  if (record.schema !== CONTEXT_OPERATION_JOURNAL_SCHEMA) {
    fail('schema_mismatch', { field: CONTEXT_OPERATION_JOURNAL_FIELD.schema });
  }
  if (!isContextOperationPhase(record.phase)) {
    fail('phase_unknown', { field: CONTEXT_OPERATION_JOURNAL_FIELD.phase });
  }
  const operationId = record.operationId;
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
    fail('operation_id_malformed', { field: CONTEXT_OPERATION_JOURNAL_FIELD.operationId });
  }
  return Object.freeze({
    schema: CONTEXT_OPERATION_JOURNAL_SCHEMA,
    operationId,
    baseSnapshotHash: requireOptionalHash(record.baseSnapshotHash, CONTEXT_OPERATION_JOURNAL_FIELD.baseSnapshotHash),
    targetSnapshotHash: requireHash(record.targetSnapshotHash, CONTEXT_OPERATION_JOURNAL_FIELD.targetSnapshotHash),
    phase: record.phase,
    tempIndex: requireTempIndex(record.tempIndex),
    indexChecksum: requireOptionalHash(record.indexChecksum, CONTEXT_OPERATION_JOURNAL_FIELD.indexChecksum),
    fragmentManifestHash: requireOptionalHash(
      record.fragmentManifestHash,
      CONTEXT_OPERATION_JOURNAL_FIELD.fragmentManifestHash,
    ),
    configFingerprint: requireHash(record.configFingerprint, CONTEXT_OPERATION_JOURNAL_FIELD.configFingerprint),
    sourceFingerprint: requireHash(record.sourceFingerprint, CONTEXT_OPERATION_JOURNAL_FIELD.sourceFingerprint),
    startedAt: requireTimestamp(record.startedAt),
    blockers: requireBlockers(record.blockers),
  });
}

export interface ContextOperationJournalPatch {
  readonly indexChecksum?: string | null | undefined;
  readonly fragmentManifestHash?: string | null | undefined;
  readonly blockers?: readonly string[] | undefined;
}

/**
 * Move the operation forward. Backwards and in-place phase writes are refused:
 * a journal that can go back to `merged` after `committed` would tell the next
 * compile to rebuild over a generation that is already current.
 */
export function advanceContextOperationPhase(
  journal: ContextOperationJournal,
  phase: ContextOperationPhase,
  patch: ContextOperationJournalPatch = {},
): ContextOperationJournal {
  if (!isContextOperationPhase(phase)) fail('phase_unknown', { field: CONTEXT_OPERATION_JOURNAL_FIELD.phase });
  const from = contextOperationPhaseRank(journal.phase);
  const to = contextOperationPhaseRank(phase);
  if (to <= from) fail('phase_regression', { from, to });
  return buildContextOperationJournal({
    operationId: journal.operationId,
    baseSnapshotHash: journal.baseSnapshotHash,
    targetSnapshotHash: journal.targetSnapshotHash,
    configFingerprint: journal.configFingerprint,
    sourceFingerprint: journal.sourceFingerprint,
    tempIndex: journal.tempIndex,
    phase,
    indexChecksum: patch.indexChecksum === undefined ? journal.indexChecksum : patch.indexChecksum,
    fragmentManifestHash:
      patch.fragmentManifestHash === undefined ? journal.fragmentManifestHash : patch.fragmentManifestHash,
    startedAt: journal.startedAt,
    blockers: patch.blockers ?? journal.blockers,
  });
}

/** Record a blocker without moving the phase; the operation stays where it failed. */
export function recordContextOperationBlockers(
  journal: ContextOperationJournal,
  codes: readonly string[],
): ContextOperationJournal {
  return buildContextOperationJournal({
    operationId: journal.operationId,
    baseSnapshotHash: journal.baseSnapshotHash,
    targetSnapshotHash: journal.targetSnapshotHash,
    configFingerprint: journal.configFingerprint,
    sourceFingerprint: journal.sourceFingerprint,
    tempIndex: journal.tempIndex,
    phase: journal.phase,
    indexChecksum: journal.indexChecksum,
    fragmentManifestHash: journal.fragmentManifestHash,
    startedAt: journal.startedAt,
    blockers: [...journal.blockers, ...codes].slice(0, CONTEXT_OPERATION_MAX_BLOCKERS),
  });
}
