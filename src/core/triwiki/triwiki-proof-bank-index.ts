/**
 * The TriWiki proof index: a manifest the proof writes keep current so the proof
 * bank summary and the Context Graph evidence extractor stop walking the whole
 * proof directory on every call.
 *
 * The manifest lives at `.sneakoscope/triwiki/proof-bank/index.json` and matches
 * the shape the evidence extractor already reads. Two rules govern it:
 *
 *  1. Nothing on the read/summary/update path walks the proof directory. A
 *     missing or corrupt manifest yields an explicit `index_missing` /
 *     `index_corrupt` status naming `repairTriWikiProofIndex(root)`; it never
 *     degrades silently into a scan whose result would look like a healthy one.
 *  2. Health is never re-implemented here. `isReusableTriWikiProofCard` and
 *     `classifyTriWikiProofCardSchema` remain the only authorities, reached
 *     through the manifest's `result` / `schema_class` fidelity fields.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TriWikiProofCard } from './triwiki-proof-card.js';
import {
  PROOF_INDEX_REL,
  TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT,
  buildTriWikiProofIndexRecord,
  loadTriWikiProofIndexDocument,
  nodeTriWikiProofIndexFs,
  triWikiProofCardRelPath,
  triWikiProofIndexPath,
  triWikiProofIndexRecordIsIndeterminate,
  triWikiProofIndexRecordIsReusable,
  withTriWikiProofIndexLock,
  writeTriWikiProofIndexDocument,
  type TriWikiProofIndexFs,
  type TriWikiProofIndexRecord,
  type TriWikiProofIndexStatus
} from './triwiki-proof-bank-index-store.js';
import { rebuildTriWikiProofIndexRecords } from './triwiki-proof-bank-index-repair.js';

export {
  PROOF_BANK_REL,
  PROOF_INDEX_REL,
  TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT,
  TRIWIKI_PROOF_INDEX_SCHEMA,
  compareTriWikiProofIndexRecords,
  nodeTriWikiProofIndexFs,
  serializeTriWikiProofIndexDocument,
  triWikiProofIndexPath,
  triWikiProofIndexRecordIsReusable
} from './triwiki-proof-bank-index-store.js';
export type {
  TriWikiProofIndexDirent,
  TriWikiProofIndexDocument,
  TriWikiProofIndexFs,
  TriWikiProofIndexRecord,
  TriWikiProofIndexSchemaClass,
  TriWikiProofIndexStatus
} from './triwiki-proof-bank-index-store.js';
export { rebuildTriWikiProofIndexRecords, repairTriWikiProofIndex } from './triwiki-proof-bank-index-repair.js';
export type { TriWikiProofIndexRebuild, TriWikiProofIndexRepairResult } from './triwiki-proof-bank-index-repair.js';

export const TRIWIKI_PROOF_INDEX_READ_SCHEMA = 'sks.triwiki-proof-index-read.v1';
export const TRIWIKI_PROOF_INDEX_SUMMARY_SCHEMA = 'sks.triwiki-proof-bank-index-summary.v1';
export const TRIWIKI_PROOF_INDEX_UPDATE_SCHEMA = 'sks.triwiki-proof-index-update.v1';

export interface TriWikiProofIndexReadOptions {
  fs?: TriWikiProofIndexFs | undefined;
}

export interface TriWikiProofIndexRead {
  schema: typeof TRIWIKI_PROOF_INDEX_READ_SCHEMA;
  ok: boolean;
  status: TriWikiProofIndexStatus;
  /** Workspace-relative POSIX path of the manifest; safe to print. Absolute paths never appear on this surface. */
  index_path: string;
  entries: TriWikiProofIndexRecord[];
  entry_count: number;
  repair_entry_point: typeof TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT;
  /** Machine-readable cause code, never prose and never a path outside the workspace. */
  detail: string | null;
}

/**
 * Read the manifest. Filesystem cost is exactly one file read: no directory is
 * listed, no proof card is opened.
 */
export function readTriWikiProofIndex(root: string, options: TriWikiProofIndexReadOptions = {}): TriWikiProofIndexRead {
  const facade = options.fs ?? nodeTriWikiProofIndexFs;
  const parsed = loadTriWikiProofIndexDocument(root, facade);
  return {
    schema: TRIWIKI_PROOF_INDEX_READ_SCHEMA,
    ok: parsed.status === 'ok',
    status: parsed.status,
    index_path: PROOF_INDEX_REL,
    entries: parsed.entries,
    entry_count: parsed.entries.length,
    repair_entry_point: TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT,
    detail: parsed.detail
  };
}

export interface TriWikiProofBankIndexedSummaryOptions extends TriWikiProofIndexReadOptions {
  /** Injected clock so expiry-driven counts stay reproducible under test. */
  now?: Date | undefined;
  /** `stat` each indexed card to count manifest rows whose file is gone. Off by default. */
  verifyPresence?: boolean | undefined;
}

export interface TriWikiProofBankIndexedSummary {
  schema: typeof TRIWIKI_PROOF_INDEX_SUMMARY_SCHEMA;
  ok: boolean;
  status: TriWikiProofIndexStatus;
  index_path: string;
  proof_count: number;
  reusable_count: number;
  invalidated_count: number;
  /** Rows written without `result`/`schema_class`: counted, never assumed healthy. */
  indeterminate_count: number;
  /** `null` unless `verifyPresence` was requested. */
  missing_card_count: number | null;
  repair_entry_point: typeof TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT;
  detail: string | null;
}

/**
 * Index-first proof bank summary. Unlike `summarizeTriWikiProofBank`, this never
 * walks the proof directory; when the manifest cannot be trusted it says so and
 * points at the repair entry point instead of quietly scanning.
 */
export function summarizeTriWikiProofBankIndexed(
  root: string,
  options: TriWikiProofBankIndexedSummaryOptions = {}
): TriWikiProofBankIndexedSummary {
  const facade = options.fs ?? nodeTriWikiProofIndexFs;
  const read = readTriWikiProofIndex(root, { fs: facade });
  const now = options.now ?? new Date();
  let reusable = 0;
  let invalidated = 0;
  let indeterminate = 0;
  let missingCards = 0;
  for (const entry of read.entries) {
    if (triWikiProofIndexRecordIsReusable(entry, now)) reusable += 1;
    if (entry.reusable !== true || entry.invalidation_reasons.length > 0) invalidated += 1;
    if (triWikiProofIndexRecordIsIndeterminate(entry)) indeterminate += 1;
    if (options.verifyPresence) {
      const stat = facade.statSync(absoluteFromRel(root, entry.path));
      if (!stat || !stat.isFile()) missingCards += 1;
    }
  }
  return {
    schema: TRIWIKI_PROOF_INDEX_SUMMARY_SCHEMA,
    ok: read.ok,
    status: read.status,
    index_path: PROOF_INDEX_REL,
    proof_count: read.entry_count,
    reusable_count: reusable,
    invalidated_count: invalidated,
    indeterminate_count: indeterminate,
    missing_card_count: options.verifyPresence ? missingCards : null,
    repair_entry_point: TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT,
    detail: read.detail
  };
}

export type TriWikiProofIndexUpdateStatus =
  | TriWikiProofIndexStatus
  | 'path_outside_proof_bank'
  | 'proof_card_unreadable';

export interface TriWikiProofIndexUpdateOptions {
  /**
   * What to do when the manifest is missing or corrupt.
   *  - `none` (default): refuse, report the status, leave the file untouched.
   *  - `repair`: rebuild from disk first. This is the opt-in that permits a walk;
   *    it is never taken implicitly.
   */
  bootstrap?: 'none' | 'repair' | undefined;
  fs?: TriWikiProofIndexFs | undefined;
}

export interface TriWikiProofIndexUpdate {
  schema: typeof TRIWIKI_PROOF_INDEX_UPDATE_SCHEMA;
  ok: boolean;
  status: TriWikiProofIndexUpdateStatus;
  index_path: string;
  entry: TriWikiProofIndexRecord | null;
  entry_count: number;
  /** True when the manifest had to be rebuilt from disk before the merge. */
  bootstrapped: boolean;
  repair_entry_point: typeof TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT;
  detail: string | null;
}

/**
 * Record (or replace) the manifest row for a proof card that was just written.
 * Called after `writeTriWikiProofCard`; safe to call again for the same card, and
 * safe under concurrent writers because the merge happens under the manifest lock
 * and the commit is an atomic rename.
 *
 * `file` is the absolute path the proof writer returned. It must resolve inside
 * the proof bank; only its workspace-relative POSIX form is ever stored.
 */
export function updateTriWikiProofIndexEntry(
  root: string,
  card: TriWikiProofCard,
  file: string,
  options: TriWikiProofIndexUpdateOptions = {}
): TriWikiProofIndexUpdate {
  const facade = options.fs ?? nodeTriWikiProofIndexFs;
  const rel = triWikiProofCardRelPath(root, file);
  if (!rel) return updateFailure('path_outside_proof_bank', 'proof_card_path_outside_proof_bank');
  let bytes: Buffer;
  try {
    bytes = facade.readFileSync(file);
  } catch {
    return updateFailure('proof_card_unreadable', 'proof_card_unreadable');
  }
  const record = buildTriWikiProofIndexRecord({ rel, card, bytes });
  const bootstrap = options.bootstrap ?? 'none';
  return withTriWikiProofIndexLock(root, () => {
    const current = loadTriWikiProofIndexDocument(root, facade);
    let entries: TriWikiProofIndexRecord[];
    let bootstrapped = false;
    if (current.status === 'ok') {
      entries = current.entries;
    } else if (bootstrap === 'repair') {
      entries = rebuildTriWikiProofIndexRecords(root, { fs: facade }).records;
      bootstrapped = true;
    } else {
      return updateFailure(current.status, current.detail);
    }
    const merged = entries.filter((entry) => entry.path !== record.path);
    merged.push(record);
    writeTriWikiProofIndexDocument(root, merged);
    return {
      schema: TRIWIKI_PROOF_INDEX_UPDATE_SCHEMA,
      ok: true,
      status: 'ok',
      index_path: PROOF_INDEX_REL,
      entry: record,
      entry_count: merged.length,
      bootstrapped,
      repair_entry_point: TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT,
      detail: null
    } satisfies TriWikiProofIndexUpdate;
  });
}

/** True when the manifest file exists on disk, without parsing or walking it. */
export function triWikiProofIndexExists(root: string): boolean {
  try {
    return fs.statSync(triWikiProofIndexPath(root)).isFile();
  } catch {
    return false;
  }
}

function absoluteFromRel(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

function updateFailure(status: TriWikiProofIndexUpdateStatus, detail: string | null): TriWikiProofIndexUpdate {
  return {
    schema: TRIWIKI_PROOF_INDEX_UPDATE_SCHEMA,
    ok: false,
    status,
    index_path: PROOF_INDEX_REL,
    entry: null,
    entry_count: 0,
    bootstrapped: false,
    repair_entry_point: TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT,
    detail
  };
}
