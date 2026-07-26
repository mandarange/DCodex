import path from 'node:path'
import crypto from 'node:crypto'
import { appendJsonl, ensureDir, nowIso } from '../fsx.js'
import { PACKAGE_VERSION } from '../version.js'

// Append-only journal of config/runtime migrations performed during an upgrade
// or `sks doctor --fix`. Every config mutation is recorded with a before/after
// content hash and the backup path so the change is auditable and reversible.
export const MIGRATION_JOURNAL_SCHEMA = 'sks.migration-journal.v1'

export interface MigrationEventInput {
  step: string
  target: string
  before?: string | null
  after?: string | null
  beforeHash?: string | null
  afterHash?: string | null
  backupPath?: string | null
  changed?: boolean
  rollbackAvailable?: boolean
  operatorAction?: string | null
  note?: string | null
}

export interface MigrationEvent {
  ts: string
  migration: string
  step: string
  target: string
  before_hash: string | null
  after_hash: string | null
  backup_path: string | null
  changed: boolean
  rollback_available: boolean
  operator_action?: string
  note?: string
}

export function hashConfigText(text: unknown): string {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex')
}

export function buildMigrationEvent(input: MigrationEventInput): MigrationEvent {
  const beforeHash = input.beforeHash ?? (input.before != null ? hashConfigText(input.before) : null)
  const afterHash = input.afterHash ?? (input.after != null ? hashConfigText(input.after) : null)
  const changed = input.changed ?? (beforeHash != null && afterHash != null ? beforeHash !== afterHash : Boolean(input.backupPath))
  const rollbackAvailable = input.rollbackAvailable ?? Boolean(input.backupPath)
  const event: MigrationEvent = {
    ts: nowIso(),
    migration: PACKAGE_VERSION,
    step: input.step,
    target: input.target,
    before_hash: beforeHash,
    after_hash: afterHash,
    backup_path: input.backupPath ?? null,
    changed,
    rollback_available: rollbackAvailable
  }
  if (input.operatorAction) event.operator_action = input.operatorAction
  if (input.note) event.note = input.note
  return event
}

export function migrationJournalPath(root: string, opts: { missionId?: string } = {}): string {
  const base = opts.missionId
    ? path.join(root, '.sneakoscope', 'missions', opts.missionId)
    : path.join(root, '.sneakoscope', 'reports')
  // The journal is identified by MIGRATION_JOURNAL_SCHEMA, and each event carries the
  // package version that wrote it, so the filename does not need a version in it.
  return path.join(base, 'migration-journal.jsonl')
}

/**
 * Append migration events to the journal. Returns the journal path and the
 * built events. A mutation event that recorded no backup is flagged so callers
 * can surface an operator action (rollback unavailable).
 */
export async function appendMigrationEvents(
  root: string,
  events: MigrationEventInput[],
  opts: { missionId?: string } = {}
): Promise<{ schema: string; journal_path: string; events: MigrationEvent[]; event_count: number; mutations_without_rollback: number }> {
  const journalPath = migrationJournalPath(root, opts)
  await ensureDir(path.dirname(journalPath))
  const built = events.map(buildMigrationEvent)
  for (const event of built) await appendJsonl(journalPath, event)
  const mutationsWithoutRollback = built.filter((event) => event.changed && !event.rollback_available).length
  return {
    schema: MIGRATION_JOURNAL_SCHEMA,
    journal_path: journalPath,
    events: built,
    event_count: built.length,
    mutations_without_rollback: mutationsWithoutRollback
  }
}
