import fs from 'node:fs';
import path from 'node:path';
import type { TriWikiProofCard } from './triwiki-proof-card.js';
import { TRIWIKI_PROOF_CARD_SCHEMA, classifyTriWikiProofCardSchema, isReusableTriWikiProofCard } from './triwiki-proof-card.js';
import { triWikiProofIndexPath, updateTriWikiProofIndexEntry } from './triwiki-proof-bank-index.js';

export const TRIWIKI_PROOF_BANK_SCHEMA = 'sks.triwiki-proof-bank.v1';

export interface TriWikiProofBankLookup {
  root: string;
  subjectType?: 'gates' | 'gate-packs' | 'modules' | 'pipelines';
  subjectId: string;
  cacheKey: string;
}

export interface TriWikiProofBankStatus {
  schema: typeof TRIWIKI_PROOF_BANK_SCHEMA;
  ok: boolean;
  root: string;
  proof_count: number;
  reusable_count: number;
  invalidated_count: number;
  corrupt_backups: number;
}

export function triWikiProofBankDir(root: string): string {
  return path.join(root, '.sneakoscope', 'triwiki', 'proof-bank');
}

export function writeTriWikiProofCard(root: string, card: TriWikiProofCard, subjectType = pluralSubject(card.subject_type)): string {
  const dir = path.join(triWikiProofBankDir(root), subjectType, safeId(card.subject_id));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeId(card.proof_id)}.json`);
  const written = withSubjectLock(root, subjectType, card.subject_id, () => {
    atomicWriteJson(file, card);
    return file;
  });
  // Keep the reverse index current so summary and graph extraction never have to
  // walk the whole proof bank. Deliberately without `bootstrap`: seeding here
  // would let a missing or corrupted manifest turn every subsequent proof write
  // into a full directory walk, which is the cost the index exists to remove.
  // A missing index is reported through the update's own status and seeded by
  // the explicit maintenance path (`sks align run`). Failing to index
  // must never lose the proof card that is already durably written.
  updateTriWikiProofIndexEntry(root, card, written);
  return written;
}

export function readReusableTriWikiProofCard(input: TriWikiProofBankLookup): { hit: boolean; card: TriWikiProofCard | null; path: string | null; invalidation_reasons: string[] } {
  const dir = path.join(triWikiProofBankDir(input.root), input.subjectType || 'gates', safeId(input.subjectId));
  if (!fs.existsSync(dir)) return { hit: false, card: null, path: null, invalidation_reasons: ['proof_dir_missing'] };
  const reasons: string[] = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const absolute = path.join(dir, file);
    const card = readProofCard(absolute);
    if (!card) {
      backupCorruptProof(absolute);
      reasons.push(`corrupt:${file}`);
      continue;
    }
    const schemaClass = classifyTriWikiProofCardSchema(card);
    if (schemaClass === 'legacy_proof_card_schema') {
      reasons.push(`legacy_proof_card_schema:${file}`);
      continue;
    }
    if (card.cache_key !== input.cacheKey) {
      reasons.push(`cache_key_mismatch:${file}`);
      continue;
    }
    if (isReusableTriWikiProofCard(card)) return { hit: true, card, path: absolute, invalidation_reasons: [] };
    reasons.push(`not_reusable:${file}`);
  }
  return { hit: false, card: null, path: null, invalidation_reasons: reasons.length ? reasons : ['proof_not_found'] };
}

export function markTriWikiProofInvalidated(root: string, subjectId: string, proofId: string, reason: string, subjectType = 'gates'): boolean {
  const file = path.join(triWikiProofBankDir(root), subjectType, safeId(subjectId), `${safeId(proofId)}.json`);
  const card = readProofCard(file);
  if (!card) return false;
  const next: TriWikiProofCard = {
    ...card,
    reusable: false,
    invalidation_reasons: [...new Set([...(card.invalidation_reasons || []), reason])]
  };
  atomicWriteJson(file, next);
  return true;
}

export function summarizeTriWikiProofBank(root: string): TriWikiProofBankStatus {
  const base = triWikiProofBankDir(root);
  const indexFile = triWikiProofIndexPath(root);
  let proofCount = 0;
  let reusableCount = 0;
  let invalidatedCount = 0;
  let corruptBackups = 0;
  if (fs.existsSync(base)) {
    for (const file of walkJson(base)) {
      if (file === indexFile) continue;
      if (file.includes('.corrupt-')) {
        corruptBackups += 1;
        continue;
      }
      const card = readProofCard(file);
      if (!card) {
        backupCorruptProof(file);
        corruptBackups += 1;
        continue;
      }
      proofCount += 1;
      if (isReusableTriWikiProofCard(card)) reusableCount += 1;
      if (card.reusable !== true || (card.invalidation_reasons || []).length > 0) invalidatedCount += 1;
    }
  }
  return {
    schema: TRIWIKI_PROOF_BANK_SCHEMA,
    ok: true,
    root,
    proof_count: proofCount,
    reusable_count: reusableCount,
    invalidated_count: invalidatedCount,
    corrupt_backups: corruptBackups
  };
}

function readProofCard(file: string): TriWikiProofCard | null {
  try {
    if (!fs.existsSync(file)) return null;
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as TriWikiProofCard;
    return json.schema === TRIWIKI_PROOF_CARD_SCHEMA ? json : null;
  } catch {
    return null;
  }
}

function backupCorruptProof(file: string): void {
  if (!fs.existsSync(file)) return;
  const backup = `${file}.corrupt-${Date.now()}.bak`;
  fs.renameSync(file, backup);
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(temp, 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
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

function withSubjectLock<T>(root: string, subjectType: string, subjectId: string, fn: () => T): T {
  const lockDir = path.join(triWikiProofBankDir(root), '.locks', subjectType);
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, `${safeId(subjectId)}.lock`);
  const staleAfterMs = 30_000;
  const started = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, `${JSON.stringify({ schema: 'sks.triwiki-proof-bank-lock.v1', pid: process.pid, acquired_at: new Date().toISOString(), stale_after_ms: staleAfterMs }, null, 2)}\n`);
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (isLockStale(lockFile, staleAfterMs)) {
        try { fs.rmSync(lockFile, { force: true }); } catch {}
        continue;
      }
      if (Date.now() - started > staleAfterMs * 2) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lockFile, { force: true }); } catch {}
  }
}

function isLockStale(file: string, staleAfterMs: number): boolean {
  try {
    const stat = fs.statSync(file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
    const alive = typeof raw.pid === 'number' && pidAlive(raw.pid);
    return !alive || Date.now() - stat.mtimeMs > staleAfterMs;
  } catch {
    try {
      const stat = fs.statSync(file);
      return Date.now() - stat.mtimeMs > staleAfterMs;
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

function walkJson(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(absolute);
    }
  }
  return out.sort();
}

function pluralSubject(value: string): string {
  if (value === 'gate') return 'gates';
  if (value === 'gate-pack') return 'gate-packs';
  if (value === 'module') return 'modules';
  return 'pipelines';
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}
