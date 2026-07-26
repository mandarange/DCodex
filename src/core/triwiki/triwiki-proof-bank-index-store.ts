/**
 * Filesystem primitives for the TriWiki proof index manifest.
 *
 * The manifest at `.sneakoscope/triwiki/proof-bank/index.json` is the writer side
 * of the shape the Context Graph evidence extractor already consumes, so the
 * schema constant, the entry contract and the proof-bank location are imported
 * from that contract rather than restated here.
 *
 * Everything in this module is filesystem-only: no process spawn, and no
 * directory walk — the single sanctioned walk lives in the repair module. Every
 * `path` that reaches a manifest row is workspace-relative POSIX; an absolute
 * path, a home path or an escape out of the proof bank is rejected, never stored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../fsx.js';
import { tryNormalizeGraphPath } from './context-graph/paths.js';
import { PROOF_BANK_REL, PROOF_INDEX_REL } from './context-graph/extractors/evidence/shared.js';
import { TRIWIKI_PROOF_INDEX_SCHEMA } from './context-graph/extractors/evidence/proof-index.js';
import type { TriWikiProofIndexEntry } from './context-graph/extractors/evidence/proof-index.js';
import { TRIWIKI_PROOF_CARD_SCHEMA, classifyTriWikiProofCardSchema, isReusableTriWikiProofCard } from './triwiki-proof-card.js';
import type { TriWikiProofCard, TriWikiProofResult } from './triwiki-proof-card.js';

export { PROOF_BANK_REL, PROOF_INDEX_REL, TRIWIKI_PROOF_INDEX_SCHEMA };

/** Named so a caller that hits a bad manifest is told the exact repair entry point. */
export const TRIWIKI_PROOF_INDEX_REPAIR_ENTRY_POINT = 'repairTriWikiProofIndex(root)' as const;

export type TriWikiProofIndexStatus = 'ok' | 'index_missing' | 'index_corrupt';

export type TriWikiProofIndexSchemaClass = 'current' | 'legacy_proof_card_schema' | 'invalid';

const PROOF_RESULTS: ReadonlySet<string> = new Set(['passed', 'failed', 'skipped', 'blocked']);
const SCHEMA_CLASSES: ReadonlySet<string> = new Set(['current', 'legacy_proof_card_schema', 'invalid']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A manifest row. The required half is the frozen extractor contract; `result`
 * and `schema_class` are optional additions that let index mode reach scan-mode
 * fidelity without reopening a proof card. Readers must tolerate their absence.
 */
export interface TriWikiProofIndexRecord extends TriWikiProofIndexEntry {
  result?: TriWikiProofResult;
  schema_class?: TriWikiProofIndexSchemaClass;
}

export interface TriWikiProofIndexDocument {
  schema: typeof TRIWIKI_PROOF_INDEX_SCHEMA;
  proofs: TriWikiProofIndexRecord[];
}

export interface TriWikiProofIndexDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * The only filesystem surface the read/summary path touches. Injecting it is how
 * a test proves the indexed path performs zero directory reads.
 */
export interface TriWikiProofIndexFs {
  readFileSync(target: string): Buffer;
  statSync(target: string): { isFile(): boolean; isDirectory(): boolean } | null;
  readdirSync(target: string): TriWikiProofIndexDirent[];
}

export const nodeTriWikiProofIndexFs: TriWikiProofIndexFs = {
  readFileSync: (target) => fs.readFileSync(target),
  statSync: (target) => {
    try {
      return fs.statSync(target);
    } catch {
      return null;
    }
  },
  readdirSync: (target) => fs.readdirSync(target, { withFileTypes: true })
};

export function triWikiProofIndexPath(root: string): string {
  return path.join(root, ...PROOF_INDEX_REL.split('/'));
}

export function triWikiProofBankRoot(root: string): string {
  return path.join(root, ...PROOF_BANK_REL.split('/'));
}

/** Workspace-relative POSIX path of a proof card, or `null` when it is not inside the bank. */
export function triWikiProofCardRelPath(root: string, file: string): string | null {
  const rel = tryNormalizeGraphPath(root, file);
  if (!rel || rel === PROOF_INDEX_REL) return null;
  return rel.startsWith(`${PROOF_BANK_REL}/`) ? rel : null;
}

export type TriWikiProofIndexParse =
  | { status: 'ok'; entries: TriWikiProofIndexRecord[]; detail: null }
  | { status: 'index_missing' | 'index_corrupt'; entries: []; detail: string };

/** Read + validate the manifest. Missing and corrupt stay distinct; neither walks. */
export function loadTriWikiProofIndexDocument(root: string, facade: TriWikiProofIndexFs): TriWikiProofIndexParse {
  let bytes: Buffer;
  try {
    bytes = facade.readFileSync(triWikiProofIndexPath(root));
  } catch {
    return { status: 'index_missing', entries: [], detail: 'proof_index_absent' };
  }
  return parseTriWikiProofIndexBytes(bytes);
}

export function parseTriWikiProofIndexBytes(bytes: Buffer): TriWikiProofIndexParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { status: 'index_corrupt', entries: [], detail: 'proof_index_unparseable' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'index_corrupt', entries: [], detail: 'proof_index_not_an_object' };
  }
  const file = parsed as Record<string, unknown>;
  if (file.schema !== TRIWIKI_PROOF_INDEX_SCHEMA) {
    return { status: 'index_corrupt', entries: [], detail: 'proof_index_schema_mismatch' };
  }
  if (!Array.isArray(file.proofs)) {
    return { status: 'index_corrupt', entries: [], detail: 'proof_index_proofs_not_an_array' };
  }
  const entries: TriWikiProofIndexRecord[] = [];
  for (let position = 0; position < file.proofs.length; position += 1) {
    const decoded = decodeRecord(file.proofs[position], position);
    if (!decoded.ok) return { status: 'index_corrupt', entries: [], detail: decoded.detail };
    entries.push(decoded.record);
  }
  return { status: 'ok', entries: entries.sort(compareTriWikiProofIndexRecords), detail: null };
}

type DecodedRecord = { ok: true; record: TriWikiProofIndexRecord } | { ok: false; detail: string };

function decodeRecord(value: unknown, position: number): DecodedRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, detail: `proof_index_entry_not_an_object:${position}` };
  }
  const row = value as Record<string, unknown>;
  const proofId = nonEmptyString(row.proof_id);
  const subjectId = nonEmptyString(row.subject_id);
  const cacheKey = nonEmptyString(row.cache_key);
  const rel = nonEmptyString(row.path);
  const hash = nonEmptyString(row.hash);
  if (!proofId || !subjectId || !cacheKey || !rel || !hash) {
    return { ok: false, detail: `proof_index_entry_incomplete:${position}` };
  }
  if (!SHA256_PATTERN.test(hash)) return { ok: false, detail: `proof_index_entry_hash_invalid:${proofId}` };
  if (rel === PROOF_INDEX_REL || !rel.startsWith(`${PROOF_BANK_REL}/`) || rel.includes('..') || rel.includes('\\')) {
    return { ok: false, detail: `proof_index_entry_path_outside_bank:${proofId}` };
  }
  if (typeof row.reusable !== 'boolean') return { ok: false, detail: `proof_index_entry_reusable_invalid:${proofId}` };
  if (!(row.expires_at === null || typeof row.expires_at === 'string')) {
    return { ok: false, detail: `proof_index_entry_expires_at_invalid:${proofId}` };
  }
  if (!Array.isArray(row.invalidation_reasons) || row.invalidation_reasons.some((item) => typeof item !== 'string')) {
    return { ok: false, detail: `proof_index_entry_invalidation_reasons_invalid:${proofId}` };
  }
  const record: TriWikiProofIndexRecord = {
    proof_id: proofId,
    subject_type: nonEmptyString(row.subject_type) ?? 'unknown',
    subject_id: subjectId,
    cache_key: cacheKey,
    reusable: row.reusable,
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    path: rel,
    hash,
    invalidation_reasons: row.invalidation_reasons.map((item) => String(item))
  };
  if (typeof row.result === 'string' && PROOF_RESULTS.has(row.result)) record.result = row.result as TriWikiProofResult;
  if (typeof row.schema_class === 'string' && SCHEMA_CLASSES.has(row.schema_class)) {
    record.schema_class = row.schema_class as TriWikiProofIndexSchemaClass;
  }
  return { ok: true, record };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Build the manifest row for a proof card. `hash` is the sha256 of the bytes that
 * are actually on disk, because the Context Graph turns it into edge provenance.
 */
export function buildTriWikiProofIndexRecord(input: {
  rel: string;
  card: TriWikiProofCard;
  bytes: Buffer;
}): TriWikiProofIndexRecord {
  const { card, rel, bytes } = input;
  const record: TriWikiProofIndexRecord = {
    proof_id: card.proof_id,
    subject_type: typeof card.subject_type === 'string' && card.subject_type ? card.subject_type : 'unknown',
    subject_id: card.subject_id,
    cache_key: card.cache_key,
    // Raw declared value, matching what scan mode reads off the card. The health
    // verdict is derived from it plus `result`/`schema_class`, never baked in.
    reusable: card.reusable === true,
    expires_at: card.expires_at ?? null,
    path: rel,
    hash: sha256(bytes),
    invalidation_reasons: [...(card.invalidation_reasons ?? [])].map((reason) => String(reason))
  };
  if (typeof card.result === 'string' && PROOF_RESULTS.has(card.result)) record.result = card.result;
  record.schema_class = classifyTriWikiProofCardSchema(card);
  return record;
}

/** Same ordering the evidence extractor applies to its records: path, then proof id, codepoint order. */
export function compareTriWikiProofIndexRecords(left: TriWikiProofIndexRecord, right: TriWikiProofIndexRecord): number {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.proof_id === right.proof_id) return 0;
  return left.proof_id < right.proof_id ? -1 : 1;
}

/**
 * Proof health for a manifest row.
 *
 * The predicate itself stays in `isReusableTriWikiProofCard`; this only feeds it a
 * surrogate carrying the fields it reads. `schema_class` is what the writer
 * observed about the v4.0.1 invalidation material, so a row that is not `current`
 * is refused outright and a row without `result`/`schema_class` is indeterminate
 * rather than optimistically healthy.
 */
export function triWikiProofIndexRecordIsReusable(record: TriWikiProofIndexRecord, now = new Date()): boolean {
  if (record.schema_class !== 'current' || !record.result) return false;
  const surrogate = {
    schema: TRIWIKI_PROOF_CARD_SCHEMA,
    subject_type: 'gate',
    subject_id: record.subject_id,
    cache_key: record.cache_key,
    input_hash: 'indexed',
    implementation_hash: 'indexed',
    gate_impl_hash: 'indexed',
    package_lock_hash: 'indexed',
    release_gates_hash: 'indexed',
    env_allowlist_hash: 'indexed',
    tool_versions: { sks: 'indexed' },
    tool_version: 'indexed',
    fixture_version: 'indexed',
    result: record.result,
    reusable: record.reusable,
    evidence: {},
    invalidation_reasons: record.invalidation_reasons,
    expires_at: record.expires_at,
    proof_id: record.proof_id,
    created_at: 'indexed'
  } satisfies TriWikiProofCard;
  return isReusableTriWikiProofCard(surrogate, now);
}

/** A row is "indeterminate" when the writer did not record the fidelity fields. */
export function triWikiProofIndexRecordIsIndeterminate(record: TriWikiProofIndexRecord): boolean {
  return !record.result || !record.schema_class;
}

export function serializeTriWikiProofIndexDocument(entries: readonly TriWikiProofIndexRecord[]): string {
  const document: TriWikiProofIndexDocument = {
    schema: TRIWIKI_PROOF_INDEX_SCHEMA,
    proofs: [...entries].sort(compareTriWikiProofIndexRecords)
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Atomic manifest write: temp file in the same directory, fsync, rename. */
export function writeTriWikiProofIndexDocument(root: string, entries: readonly TriWikiProofIndexRecord[]): void {
  const file = triWikiProofIndexPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(temp, 'w');
  try {
    fs.writeFileSync(fd, serializeTriWikiProofIndexDocument(entries));
    try {
      fs.fsyncSync(fd);
    } catch {
      // fsync can be unavailable on some virtual filesystems; rename remains atomic.
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

const LOCK_STALE_AFTER_MS = 30_000;

/**
 * Manifest-wide lock, mirroring the proof bank's per-subject lock (exclusive
 * create, pid + mtime staleness, bounded spin). The manifest is a single file
 * shared by every subject, so it needs its own lock rather than a subject one.
 * Not re-entrant: never call this from inside a held lock.
 */
export function withTriWikiProofIndexLock<T>(root: string, fn: () => T): T {
  const lockDir = path.join(triWikiProofBankRoot(root), '.locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, 'index.lock');
  const started = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(
        fd,
        `${JSON.stringify({ schema: 'sks.triwiki-proof-index-lock.v1', pid: process.pid, acquired_at: new Date().toISOString(), stale_after_ms: LOCK_STALE_AFTER_MS }, null, 2)}\n`
      );
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (isLockStale(lockFile)) {
        try {
          fs.rmSync(lockFile, { force: true });
        } catch {
          // Another writer won the reclaim race; retry.
        }
        continue;
      }
      if (Date.now() - started > LOCK_STALE_AFTER_MS * 2) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockFile, { force: true });
    } catch {
      // Best effort: a leftover lock is reclaimed by the staleness check.
    }
  }
}

function isLockStale(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
    const alive = typeof raw.pid === 'number' && pidAlive(raw.pid);
    return !alive || Date.now() - stat.mtimeMs > LOCK_STALE_AFTER_MS;
  } catch {
    try {
      return Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_AFTER_MS;
    } catch {
      return true;
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code || '') : '';
    return code === 'EPERM';
  }
}
