/**
 * Repair for the TriWiki proof index manifest.
 *
 * This module owns the ONLY full walk of the proof bank. The read, summary and
 * update paths never fall back to it: a missing or corrupt manifest is reported
 * as `index_missing` / `index_corrupt` naming this entry point, and an operator
 * (or an explicit opt-in on the update path) decides when the walk happens.
 *
 * Repair is read-only with respect to proof cards. It never quarantines,
 * rewrites or deletes a card; the single file it writes is the manifest.
 */
import path from 'node:path';
import { TRIWIKI_PROOF_CARD_SCHEMA } from './triwiki-proof-card.js';
import type { TriWikiProofCard } from './triwiki-proof-card.js';
import {
  PROOF_BANK_REL,
  PROOF_INDEX_REL,
  TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT,
  buildTriWikiProofIndexRecord,
  compareTriWikiProofIndexRecords,
  loadTriWikiProofIndexDocument,
  nodeTriWikiProofIndexFs,
  triWikiProofBankRoot,
  withTriWikiProofIndexLock,
  writeTriWikiProofIndexDocument,
  type TriWikiProofIndexFs,
  type TriWikiProofIndexRecord,
  type TriWikiProofIndexStatus
} from './triwiki-proof-bank-index-store.js';

const EXCLUDED_DIRS: ReadonlySet<string> = new Set(['.locks', 'node_modules', '.git']);

export interface TriWikiProofIndexRebuild {
  records: TriWikiProofIndexRecord[];
  scanned_files: number;
  corrupt_card_count: number;
  skipped_count: number;
}

export interface TriWikiProofIndexRepairResult {
  schema: 'sks.triwiki-proof-index-repair.v1';
  ok: boolean;
  index_path: string;
  previous_status: TriWikiProofIndexStatus;
  scanned_files: number;
  indexed_count: number;
  corrupt_card_count: number;
  skipped_count: number;
  repair_entry_point: typeof TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT;
}

export interface TriWikiProofIndexRepairOptions {
  fs?: TriWikiProofIndexFs | undefined;
}

/**
 * Walk the proof bank and derive the manifest rows from disk. Pure: no lock, no
 * write. `updateTriWikiProofIndexEntry` reuses this while already holding the
 * manifest lock, which is why the locking wrapper is a separate function.
 */
export function rebuildTriWikiProofIndexRecords(
  root: string,
  options: TriWikiProofIndexRepairOptions = {}
): TriWikiProofIndexRebuild {
  const facade = options.fs ?? nodeTriWikiProofIndexFs;
  const base = triWikiProofBankRoot(root);
  const bankStat = facade.statSync(base);
  if (!bankStat || !bankStat.isDirectory()) {
    return { records: [], scanned_files: 0, corrupt_card_count: 0, skipped_count: 0 };
  }
  const records: TriWikiProofIndexRecord[] = [];
  let scanned = 0;
  let corrupt = 0;
  let skipped = 0;
  for (const rel of listProofCardPaths(root, facade)) {
    scanned += 1;
    let bytes: Buffer;
    try {
      bytes = facade.readFileSync(path.join(root, ...rel.split('/')));
    } catch {
      skipped += 1;
      continue;
    }
    const card = decodeProofCard(bytes);
    if (!card) {
      corrupt += 1;
      continue;
    }
    records.push(buildTriWikiProofIndexRecord({ rel, card, bytes }));
  }
  return {
    records: records.sort(compareTriWikiProofIndexRecords),
    scanned_files: scanned,
    corrupt_card_count: corrupt,
    skipped_count: skipped
  };
}

/**
 * Rebuild the manifest from disk and commit it atomically under the manifest
 * lock. A corrupt manifest is overwritten rather than quarantined: the manifest
 * is fully derived from the proof cards, so the damaged bytes carry no evidence
 * that the rebuild does not recover.
 */
export function repairTriWikiProofIndex(
  root: string,
  options: TriWikiProofIndexRepairOptions = {}
): TriWikiProofIndexRepairResult {
  const facade = options.fs ?? nodeTriWikiProofIndexFs;
  const previous = loadTriWikiProofIndexDocument(root, facade).status;
  return withTriWikiProofIndexLock(root, () => {
    const rebuilt = rebuildTriWikiProofIndexRecords(root, { fs: facade });
    writeTriWikiProofIndexDocument(root, rebuilt.records);
    return {
      schema: 'sks.triwiki-proof-index-repair.v1',
      ok: true,
      index_path: PROOF_INDEX_REL,
      previous_status: previous,
      scanned_files: rebuilt.scanned_files,
      indexed_count: rebuilt.records.length,
      corrupt_card_count: rebuilt.corrupt_card_count,
      skipped_count: rebuilt.skipped_count,
      repair_entry_point: TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT
    } satisfies TriWikiProofIndexRepairResult;
  });
}

function decodeProofCard(bytes: Buffer): TriWikiProofCard | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const card = parsed as Partial<TriWikiProofCard>;
  if (card.schema !== TRIWIKI_PROOF_CARD_SCHEMA) return null;
  if (typeof card.proof_id !== 'string' || !card.proof_id) return null;
  if (typeof card.subject_id !== 'string' || !card.subject_id) return null;
  if (typeof card.cache_key !== 'string' || !card.cache_key) return null;
  return card as TriWikiProofCard;
}

/** Deterministic (sorted at every level) depth-first listing of proof-card paths. */
function listProofCardPaths(root: string, facade: TriWikiProofIndexFs): string[] {
  const out: string[] = [];
  const stack: string[] = [PROOF_BANK_REL];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    let entries: TriWikiProofIndexDirentList;
    try {
      entries = facade.readdirSync(path.join(root, ...current.split('/')));
    } catch {
      continue;
    }
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const rel = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) stack.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;
      if (entry.name.includes('.corrupt-')) continue;
      if (entry.name.startsWith('.')) continue;
      if (rel === PROOF_INDEX_REL) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

type TriWikiProofIndexDirentList = ReturnType<TriWikiProofIndexFs['readdirSync']>;
