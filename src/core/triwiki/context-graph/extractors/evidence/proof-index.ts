/**
 * Bounded discovery of the TriWiki proof bank.
 *
 * Preferred path: the proof index manifest at
 * `.sneakoscope/triwiki/proof-bank/index.json`. When it is present the manifest
 * alone drives discovery — zero proof-card reads on the hot path — and every
 * resulting relation is marked `manifest` confidence because the hashes are
 * declared rather than observed.
 *
 * Fallback: a depth- and count-bounded directory read. Never a recursive walk
 * without a budget, never a process spawn.
 */
import fs from 'node:fs';
import { sha256 } from '../../../../fsx.js';
import type { ContextGraphSkip } from '../../contracts.js';
import { resolveInsideWorkspace, tryNormalizeGraphPath } from '../../paths.js';
import type { TriWikiProofCard } from '../../../triwiki-proof-card.js';
import {
  PROOF_BANK_REL,
  PROOF_INDEX_REL,
  asArray,
  asRecord,
  asString,
  asStringList,
  readWorkspaceFile,
  statWorkspaceEntry,
  type EvidenceContext,
  type ProofDiscoveryMode
} from './shared.js';

export const TRIWIKI_PROOF_INDEX_SCHEMA = 'sks.triwiki-proof-index.v1';

/** Shape written by the proof-index worker; read-only here. */
export interface TriWikiProofIndexEntry {
  proof_id: string;
  subject_type: string;
  subject_id: string;
  cache_key: string;
  reusable: boolean;
  expires_at: string | null;
  path: string;
  hash: string;
  invalidation_reasons: string[];
}

export interface TriWikiProofIndexFile {
  schema: typeof TRIWIKI_PROOF_INDEX_SCHEMA;
  proofs: TriWikiProofIndexEntry[];
}

export interface ProofRecord {
  proofId: string;
  subjectType: string;
  subjectId: string;
  /** workspace-relative POSIX path of the proof card */
  rel: string;
  /** sha256 used for edge provenance: observed in scan mode, declared in index mode */
  hash: string;
  cacheKey: string | null;
  reusable: boolean | null;
  expiresAt: string | null;
  invalidationReasons: string[];
  cardPresent: boolean;
  corrupt: boolean;
  card: TriWikiProofCard | null;
}

export interface ProofDiscovery {
  mode: ProofDiscoveryMode;
  records: ProofRecord[];
  skipped: ContextGraphSkip[];
  inputHashes: Record<string, string>;
  truncated: boolean;
}

const MAX_PROOF_RECORDS = 512;
const MAX_SCAN_DEPTH = 4;
const SCAN_EXCLUDED_DIRS: ReadonlySet<string> = new Set(['.locks', 'node_modules', '.git']);

type ProofIndexRead = { ok: true; discovery: ProofDiscovery } | { ok: false; skipped: ContextGraphSkip[] };

export function discoverProofRecords(ctx: EvidenceContext): ProofDiscovery {
  const indexed = readProofIndex(ctx);
  if (indexed.ok) return indexed.discovery;
  const scanned = scanProofBank(ctx);
  return { ...scanned, skipped: [...indexed.skipped, ...scanned.skipped] };
}

function insideProofBank(rel: string): boolean {
  return rel === PROOF_BANK_REL || rel.startsWith(`${PROOF_BANK_REL}/`);
}

function readProofIndex(ctx: EvidenceContext): ProofIndexRead {
  const read = readWorkspaceFile(ctx.root, PROOF_INDEX_REL, ctx.limits.maxFileBytes);
  if (!read.ok) return { ok: false, skipped: [] };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(read.value.bytes.toString('utf8'));
  } catch {
    parsed = null;
  }
  const file = asRecord(parsed);
  if (!file || file.schema !== TRIWIKI_PROOF_INDEX_SCHEMA) {
    return { ok: false, skipped: [{ path: PROOF_INDEX_REL, reason: 'unreadable', detail: 'proof_index_schema_mismatch' }] };
  }
  const records: ProofRecord[] = [];
  const skipped: ContextGraphSkip[] = [];
  let truncated = false;
  const limit = Math.min(MAX_PROOF_RECORDS, Math.max(0, ctx.limits.maxFiles));
  for (const entry of asArray(file.proofs)) {
    if (records.length >= limit) {
      truncated = true;
      break;
    }
    const row = asRecord(entry);
    if (!row) continue;
    const proofId = asString(row.proof_id);
    const subjectId = asString(row.subject_id);
    const declaredPath = asString(row.path);
    const hash = asString(row.hash);
    if (!proofId || !subjectId || !declaredPath || !hash) continue;
    const rel = tryNormalizeGraphPath(ctx.root, declaredPath);
    if (!rel || !insideProofBank(rel)) {
      skipped.push({ path: PROOF_INDEX_REL, reason: 'excluded', detail: `proof_path_outside_proof_bank:${proofId}` });
      continue;
    }
    records.push({
      proofId,
      subjectType: asString(row.subject_type) ?? 'unknown',
      subjectId,
      rel,
      hash,
      cacheKey: asString(row.cache_key),
      reusable: typeof row.reusable === 'boolean' ? row.reusable : null,
      expiresAt: asString(row.expires_at),
      invalidationReasons: asStringList(row.invalidation_reasons),
      cardPresent: statWorkspaceEntry(ctx.root, rel) !== null,
      corrupt: false,
      card: null
    });
  }
  if (truncated) skipped.push({ path: PROOF_INDEX_REL, reason: 'cap_reached', detail: 'proof_index_entry_cap' });
  return {
    ok: true,
    discovery: {
      mode: 'index',
      records: sortRecords(records),
      skipped,
      inputHashes: { [PROOF_INDEX_REL]: read.value.hash },
      truncated
    }
  };
}

function scanProofBank(ctx: EvidenceContext): ProofDiscovery {
  const bankStat = statWorkspaceEntry(ctx.root, PROOF_BANK_REL);
  if (!bankStat || !bankStat.isDirectory()) {
    return {
      mode: 'absent',
      records: [],
      skipped: [{ path: PROOF_BANK_REL, reason: 'unreadable', detail: 'proof_bank_missing' }],
      inputHashes: {},
      truncated: false
    };
  }
  const skipped: ContextGraphSkip[] = [];
  const files = listProofFiles(ctx, skipped);
  const records: ProofRecord[] = [];
  const inputHashes: Record<string, string> = {};
  for (const rel of files.paths) {
    const read = readWorkspaceFile(ctx.root, rel, ctx.limits.maxFileBytes);
    if (!read.ok) {
      skipped.push(read.skip);
      continue;
    }
    inputHashes[rel] = read.value.hash;
    const record = decodeProofCard(rel, read.value.bytes, read.value.hash);
    if (record) records.push(record);
  }
  return { mode: 'scan', records: sortRecords(records), skipped, inputHashes, truncated: files.truncated };
}

function decodeProofCard(rel: string, bytes: Buffer, hash: string): ProofRecord | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    parsed = null;
  }
  const card = asRecord(parsed);
  const proofId = card ? asString(card.proof_id) : null;
  if (!card || !proofId) {
    return {
      proofId: `corrupt-${sha256(rel).slice(0, 16)}`,
      subjectType: 'unknown',
      subjectId: 'unknown',
      rel,
      hash,
      cacheKey: null,
      reusable: false,
      expiresAt: null,
      invalidationReasons: ['corrupt_proof_card'],
      cardPresent: true,
      corrupt: true,
      card: null
    };
  }
  return {
    proofId,
    subjectType: asString(card.subject_type) ?? 'unknown',
    subjectId: asString(card.subject_id) ?? 'unknown',
    rel,
    hash,
    cacheKey: asString(card.cache_key),
    reusable: typeof card.reusable === 'boolean' ? card.reusable : null,
    expiresAt: asString(card.expires_at),
    invalidationReasons: asStringList(card.invalidation_reasons),
    cardPresent: true,
    corrupt: false,
    card: card as unknown as TriWikiProofCard
  };
}

interface ProofFileListing {
  paths: string[];
  truncated: boolean;
}

/** Breadth-first, depth-capped, count-capped listing. Deterministic (sorted) at every level. */
function listProofFiles(ctx: EvidenceContext, skipped: ContextGraphSkip[]): ProofFileListing {
  const limit = Math.min(MAX_PROOF_RECORDS, Math.max(0, ctx.limits.maxFiles));
  const out: string[] = [];
  let truncated = false;
  const queue: Array<{ rel: string; depth: number }> = [{ rel: PROOF_BANK_REL, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth > MAX_SCAN_DEPTH) {
      truncated = true;
      continue;
    }
    let entries: fs.Dirent[];
    try {
      const absolute = resolveInsideWorkspace(ctx.root, current.rel);
      if (!absolute) continue;
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      skipped.push({ path: current.rel, reason: 'unreadable', detail: 'proof_dir_unreadable' });
      continue;
    }
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const rel = `${current.rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SCAN_EXCLUDED_DIRS.has(entry.name)) continue;
        queue.push({ rel, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;
      if (entry.name.includes('.corrupt-')) continue;
      if (rel === PROOF_INDEX_REL) continue;
      if (out.length >= limit) {
        truncated = true;
        break;
      }
      out.push(rel);
    }
    if (truncated) break;
  }
  if (truncated) skipped.push({ path: PROOF_BANK_REL, reason: 'cap_reached', detail: 'proof_scan_cap' });
  return { paths: out.sort(), truncated };
}

function sortRecords(records: readonly ProofRecord[]): ProofRecord[] {
  return [...records].sort((left, right) => {
    if (left.rel !== right.rel) return left.rel < right.rel ? -1 : 1;
    return left.proofId < right.proofId ? -1 : left.proofId > right.proofId ? 1 : 0;
  });
}
