import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  ensureDir,
  nowIso,
  readJson,
  readText,
  sha256,
  writeJsonAtomic,
  writeTextAtomic
} from '../fsx.js';
import { withFileLock } from '../locks/file-lock.js';
import { guardedRename, guardedRm, guardContextForRoute } from '../safety/mutation-guard.js';
import { createRequestedScopeContract } from '../safety/requested-scope-contract.js';
import {
  inspectTriwikiAgentsMdBlocks,
  removeTriwikiAgentsMdBlocks
} from './agents-md-projector.js';
import { clearContextGraphSnapshotCache } from './context-graph/query/snapshot-cache.js';

export const TRIWIKI_CLEANUP_RECEIPT_SCHEMA = 'sks.triwiki-cleanup-receipt.v3' as const;
export const TRIWIKI_CLEANUP_RECEIPT_REL = '.sneakoscope/triwiki-cleanup-receipt.json' as const;
export const TRIWIKI_STATE_LOCK_REL = '.sneakoscope/locks/triwiki-state.lock' as const;
export const TRIWIKI_CLEANUP_SWAP_REL = '.sneakoscope/tmp/triwiki-cleanup-current' as const;

interface CleanupTarget {
  key: string;
  rel: string;
  category: 'wiki' | 'memory' | 'graph_cache' | 'projection' | 'graph_report' | 'transient';
}

/**
 * Active recall/index surfaces and obsolete TriWiki staging generations only.
 * Source, ordinary documentation, missions, evidence, and proof history are not
 * cleanup targets.
 */
export const TRIWIKI_ACTIVE_TARGETS: readonly CleanupTarget[] = Object.freeze([
  { key: 'wiki', rel: '.sneakoscope/wiki', category: 'wiki' },
  { key: 'memory', rel: '.sneakoscope/memory', category: 'memory' },
  { key: 'context_graph_cache', rel: '.sneakoscope/cache/context-graph', category: 'graph_cache' },
  { key: 'code_pack_freshness_cache', rel: '.sneakoscope/cache/code-pack-head-freshness.json', category: 'graph_cache' },
  { key: 'generated_agents_projection', rel: '.sneakoscope/context/AGENTS.generated.md', category: 'projection' },
  { key: 'context_graph_benchmark_report', rel: '.sneakoscope/reports/context-graph-benchmark.json', category: 'graph_report' },
  { key: 'context_graph_experiment_log', rel: '.sneakoscope/reports/context-graph-experiments.jsonl', category: 'graph_report' },
  { key: 'context_graph_optimizer_reports', rel: '.sneakoscope/reports/context-graph-optimizer', category: 'graph_report' },
  { key: 'legacy_cleanup_quarantine', rel: '.sneakoscope/quarantine/triwiki-cleanup', category: 'transient' },
  { key: 'legacy_align_staging', rel: '.sneakoscope/quarantine/triwiki-align-staging', category: 'transient' },
  { key: 'legacy_align_previous', rel: '.sneakoscope/quarantine/triwiki-align-previous', category: 'transient' },
  { key: 'align_staging', rel: '.sneakoscope/tmp/triwiki-align', category: 'transient' },
  { key: 'cleanup_current_swap', rel: TRIWIKI_CLEANUP_SWAP_REL, category: 'transient' }
]);

const PRESERVED_AUDIT_SURFACES = Object.freeze([
  '.sneakoscope/missions',
  '.sneakoscope/triwiki/proof-bank',
  '.sneakoscope/evidence',
  'project source code',
  'ordinary project documentation'
]);

export interface TriWikiBlankState {
  schema: 'sks.triwiki-blank-state.v1';
  blank: boolean;
  active_targets: Array<{ key: string; path: string; type: 'file' | 'directory' | 'symlink' | 'other' }>;
  projected_agents_blocks: string[];
  preserved_audit_surfaces: string[];
}

export interface TriWikiCleanupPlanTarget {
  key: string;
  path: string;
  category: CleanupTarget['category'];
  exists: boolean;
  files: number;
  directories: number;
  bytes: number;
  digest: string;
}

export interface TriWikiCleanupPlan {
  schema: 'sks.triwiki-cleanup-plan.v3';
  ok: boolean;
  generated_at: string;
  mode: 'active_triwiki_blank_state';
  risk: 'R3';
  requires_apply: true;
  destructive: true;
  retained_backup: false;
  blank_before: boolean;
  targets: TriWikiCleanupPlanTarget[];
  projected_agents_blocks: string[];
  projection_hashes: Record<string, string>;
  totals: { targets: number; files: number; directories: number; bytes: number };
  state_digest: string;
  preserved: string[];
  blockers: string[];
}

export interface TriWikiCleanupTargetReceipt {
  key: string;
  source_path: string;
  type: 'file' | 'directory' | 'other';
  digest: string;
}

export interface TriWikiCleanupProjectionReceipt {
  source_path: string;
  before_sha256: string;
  after_sha256: string;
}

export interface TriWikiCleanupReceipt {
  schema: typeof TRIWIKI_CLEANUP_RECEIPT_SCHEMA;
  ok: boolean;
  generated_at: string;
  cleanup_id: string;
  root_binding_sha256: string;
  mode: 'active_triwiki_blank_state';
  risk: 'R3';
  destructive: true;
  retained_backup: false;
  temporary_swap_removed: boolean;
  blank_verified: boolean;
  prior_state_digest: string;
  deleted_target_count: number;
  removed_projection_count: number;
  files_deleted: number;
  directories_deleted: number;
  bytes_deleted: number;
  target_receipts: TriWikiCleanupTargetReceipt[];
  projection_receipts: TriWikiCleanupProjectionReceipt[];
  preserved_audit_surfaces: string[];
  idempotent_reuse: boolean;
  blockers: string[];
}

interface TreeStats {
  files: number;
  directories: number;
  bytes: number;
  rows: string[];
  digest: string;
  blockers: string[];
}

export const TRIWIKI_CLEANUP_SCAN_LIMITS = Object.freeze({
  maxEntries: 100_000,
  maxDepth: 256,
  maxBytes: 16 * 1024 * 1024 * 1024,
  maxFileBytes: 1024 * 1024 * 1024,
  timeoutMs: 5 * 60_000
});

interface CleanupScanBudget {
  startedAtMs: number;
  entries: number;
  bytes: number;
}

function createCleanupScanBudget(): CleanupScanBudget {
  return { startedAtMs: Date.now(), entries: 0, bytes: 0 };
}

function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function relativePosix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function targetType(stat: fs.Stats): 'file' | 'directory' | 'symlink' | 'other' {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(target);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function removeEmptyDirectory(guard: ReturnType<typeof cleanupGuard>, directory: string): Promise<void> {
  const stat = await lstatOrNull(directory);
  if (!stat?.isDirectory()) return;
  if ((await fsp.readdir(directory)).length > 0) return;
  await guardedRm(guard, directory, { recursive: true, force: false });
}

async function hashFile(file: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function inspectTree(
  absolute: string,
  relative: string,
  budget: CleanupScanBudget = createCleanupScanBudget()
): Promise<TreeStats> {
  const total: TreeStats = { files: 0, directories: 0, bytes: 0, rows: [], digest: '', blockers: [] };
  const stack: Array<{ absolute: string; relative: string; depth: number }> = [{ absolute, relative, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (Date.now() - budget.startedAtMs > TRIWIKI_CLEANUP_SCAN_LIMITS.timeoutMs) {
      total.blockers.push(`cleanup_scan_timeout_exceeded:${current.relative}`);
      break;
    }
    if (current.depth > TRIWIKI_CLEANUP_SCAN_LIMITS.maxDepth) {
      total.blockers.push(`cleanup_scan_depth_limit_exceeded:${current.relative}`);
      break;
    }
    if (budget.entries >= TRIWIKI_CLEANUP_SCAN_LIMITS.maxEntries) {
      total.blockers.push(`cleanup_scan_entry_limit_exceeded:${current.relative}`);
      break;
    }

    const stat = await fsp.lstat(current.absolute);
    budget.entries += 1;
    if (stat.isSymbolicLink()) {
      const linkTarget = await fsp.readlink(current.absolute);
      const linkBytes = Buffer.byteLength(linkTarget);
      if (budget.bytes + linkBytes > TRIWIKI_CLEANUP_SCAN_LIMITS.maxBytes) {
        total.blockers.push(`cleanup_scan_byte_limit_exceeded:${current.relative}`);
        break;
      }
      budget.bytes += linkBytes;
      total.files += 1;
      total.bytes += linkBytes;
      total.rows.push(`link\u0000${current.relative}\u0000${sha256(linkTarget)}`);
      total.blockers.push(`${current.depth === 0 ? 'cleanup_target' : 'cleanup_nested'}_symlink_refused:${current.relative}`);
      continue;
    }
    if (stat.isFile()) {
      if (stat.size > TRIWIKI_CLEANUP_SCAN_LIMITS.maxFileBytes) {
        total.blockers.push(`cleanup_scan_file_size_limit_exceeded:${current.relative}`);
        break;
      }
      if (budget.bytes + stat.size > TRIWIKI_CLEANUP_SCAN_LIMITS.maxBytes) {
        total.blockers.push(`cleanup_scan_byte_limit_exceeded:${current.relative}`);
        break;
      }
      budget.bytes += stat.size;
      total.files += 1;
      total.bytes += stat.size;
      total.rows.push(`file\u0000${current.relative}\u0000${stat.size}\u0000${await hashFile(current.absolute)}`);
      continue;
    }
    if (!stat.isDirectory()) {
      total.rows.push(`other\u0000${current.relative}`);
      continue;
    }

    total.directories += 1;
    total.rows.push(`dir\u0000${current.relative}`);
    const remainingEntries = TRIWIKI_CLEANUP_SCAN_LIMITS.maxEntries - budget.entries;
    const childNames: string[] = [];
    const directory = await fsp.opendir(current.absolute);
    for await (const entry of directory) {
      childNames.push(entry.name);
      if (childNames.length > remainingEntries) {
        total.blockers.push(`cleanup_scan_entry_limit_exceeded:${current.relative}`);
        break;
      }
    }
    if (total.blockers.length > 0) break;
    childNames.sort((left, right) => left.localeCompare(right));
    for (let index = childNames.length - 1; index >= 0; index -= 1) {
      const childName = childNames[index]!;
      stack.push({
        absolute: path.join(current.absolute, childName),
        relative: `${current.relative}/${childName}`,
        depth: current.depth + 1
      });
    }
  }

  total.digest = sha256(total.rows.join('\n'));
  return total;
}

async function rootBinding(root: string): Promise<string> {
  return sha256(await fsp.realpath(path.resolve(root)));
}

function cleanupGuard(root: string) {
  const contract = createRequestedScopeContract({
    route: '$sks-cleanup',
    userRequest: 'Permanently delete the reviewed active TriWiki surfaces and leave a blank active state',
    projectRoot: root
  });
  return guardContextForRoute(root, contract, 'blank active TriWiki without retaining an old generation');
}

export async function withTriWikiStateLock<T>(rootInput: string, run: () => Promise<T>): Promise<T> {
  const root = path.resolve(rootInput);
  return withFileLock({
    lockPath: path.join(root, TRIWIKI_STATE_LOCK_REL),
    timeoutMs: 30_000,
    staleMs: 10 * 60_000
  }, run);
}

export async function inspectTriWikiBlankState(rootInput: string): Promise<TriWikiBlankState> {
  const root = path.resolve(rootInput);
  const activeTargets: TriWikiBlankState['active_targets'] = [];
  for (const target of TRIWIKI_ACTIVE_TARGETS) {
    const stat = await lstatOrNull(path.join(root, target.rel));
    if (stat) activeTargets.push({ key: target.key, path: target.rel, type: targetType(stat) });
  }
  const projected = (await inspectTriwikiAgentsMdBlocks(root)).map((file) => relativePosix(root, file));
  return {
    schema: 'sks.triwiki-blank-state.v1',
    blank: activeTargets.length === 0 && projected.length === 0,
    active_targets: activeTargets,
    projected_agents_blocks: projected,
    preserved_audit_surfaces: [...PRESERVED_AUDIT_SURFACES]
  };
}

export async function planTriWikiCleanup(rootInput: string): Promise<TriWikiCleanupPlan> {
  const root = path.resolve(rootInput);
  const blockers: string[] = [];
  const targets: TriWikiCleanupPlanTarget[] = [];
  const digestRows: string[] = [];
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const scanBudget = createCleanupScanBudget();
  for (const target of TRIWIKI_ACTIVE_TARGETS) {
    const absolute = path.join(root, target.rel);
    if (!insideRoot(root, absolute)) {
      blockers.push(`cleanup_target_outside_root:${target.rel}`);
      continue;
    }
    const stat = await lstatOrNull(absolute);
    if (!stat) {
      targets.push({ key: target.key, path: target.rel, category: target.category, exists: false, files: 0, directories: 0, bytes: 0, digest: sha256('missing') });
      continue;
    }
    const tree = await inspectTree(absolute, target.rel, scanBudget);
    blockers.push(...tree.blockers);
    files += tree.files;
    directories += tree.directories;
    bytes += tree.bytes;
    digestRows.push(...tree.rows);
    targets.push({ key: target.key, path: target.rel, category: target.category, exists: true, files: tree.files, directories: tree.directories, bytes: tree.bytes, digest: tree.digest });
  }
  const projected = await inspectTriwikiAgentsMdBlocks(root);
  const projectionHashes: Record<string, string> = {};
  for (const file of projected) {
    const relative = relativePosix(root, file);
    const contents = String(await readText(file, '') || '');
    projectionHashes[relative] = sha256(contents);
    digestRows.push(`projection\u0000${relative}\u0000${projectionHashes[relative]}`);
  }
  return {
    schema: 'sks.triwiki-cleanup-plan.v3',
    ok: blockers.length === 0,
    generated_at: nowIso(),
    mode: 'active_triwiki_blank_state',
    risk: 'R3',
    requires_apply: true,
    destructive: true,
    retained_backup: false,
    blank_before: !targets.some((target) => target.exists) && projected.length === 0,
    targets,
    projected_agents_blocks: projected.map((file) => relativePosix(root, file)),
    projection_hashes: projectionHashes,
    totals: { targets: targets.filter((target) => target.exists).length, files, directories, bytes },
    state_digest: sha256(digestRows.sort().join('\n')),
    preserved: [...PRESERVED_AUDIT_SURFACES],
    blockers
  };
}

async function reusableBlankReceipt(root: string): Promise<TriWikiCleanupReceipt | null> {
  const receipt = await readJson<TriWikiCleanupReceipt | null>(path.join(root, TRIWIKI_CLEANUP_RECEIPT_REL), null);
  if (!receipt || receipt.schema !== TRIWIKI_CLEANUP_RECEIPT_SCHEMA || receipt.ok !== true) return null;
  if (receipt.root_binding_sha256 !== await rootBinding(root)) return null;
  if (receipt.retained_backup !== false || receipt.temporary_swap_removed !== true) return null;
  return { ...receipt, idempotent_reuse: true };
}

export async function applyTriWikiCleanup(rootInput: string): Promise<TriWikiCleanupReceipt> {
  const root = path.resolve(rootInput);
  return withTriWikiStateLock(root, async () => {
    const plan = await planTriWikiCleanup(root);
    if (!plan.ok) throw new Error(`triwiki_cleanup_plan_blocked:${plan.blockers.join(',')}`);
    if (plan.blank_before) {
      const existing = await reusableBlankReceipt(root);
      if (existing) return existing;
    }

    const cleanupId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    // One fixed, inventoried swap namespace makes an interrupted irreversible
    // delete visible to the next plan/receipt validation. A retry removes that
    // owned remainder before using the same namespace for the new transaction.
    const swapRel = TRIWIKI_CLEANUP_SWAP_REL;
    const swapRoot = path.join(root, swapRel);
    if (!insideRoot(root, swapRoot)) throw new Error('triwiki_cleanup_swap_outside_root');
    const guard = cleanupGuard(root);
    const moved: Array<{ from: string; to: string }> = [];
    const targetReceipts: TriWikiCleanupTargetReceipt[] = [];
    const projectionReceipts: TriWikiCleanupProjectionReceipt[] = [];
    const projectionOriginals = new Map<string, string>();
    let commitStarted = false;
    const currentScanBudget = createCleanupScanBudget();
    const swappedScanBudget = createCleanupScanBudget();

    try {
      const staleSwap = plan.targets.find((target) => target.key === 'cleanup_current_swap' && target.exists);
      if (staleSwap) {
        const staleSwapStat = await lstatOrNull(swapRoot);
        if (!staleSwapStat) throw new Error(`triwiki_cleanup_cas_missing:${staleSwap.path}`);
        if (staleSwapStat.isSymbolicLink()) throw new Error(`triwiki_cleanup_target_symlink_refused:${staleSwap.path}`);
        const current = await inspectTree(swapRoot, staleSwap.path, currentScanBudget);
        if (current.blockers.length > 0) throw new Error(`triwiki_cleanup_cas_blocked:${current.blockers.join(',')}`);
        if (current.digest !== staleSwap.digest) throw new Error(`triwiki_cleanup_cas_mismatch:${staleSwap.path}`);
        await guardedRm(guard, swapRoot, { recursive: true, force: true });
        if (await lstatOrNull(swapRoot)) throw new Error('triwiki_cleanup_stale_swap_not_removed');
        targetReceipts.push({
          key: staleSwap.key,
          source_path: staleSwap.path,
          type: staleSwapStat.isDirectory() ? 'directory' : staleSwapStat.isFile() ? 'file' : 'other',
          digest: staleSwap.digest
        });
      }

      for (const target of plan.targets.filter((row) => row.exists && row.key !== 'cleanup_current_swap')) {
        const from = path.join(root, target.path);
        const stat = await lstatOrNull(from);
        if (!stat) throw new Error(`triwiki_cleanup_cas_missing:${target.path}`);
        if (stat.isSymbolicLink()) throw new Error(`triwiki_cleanup_target_symlink_refused:${target.path}`);
        const current = await inspectTree(from, target.path, currentScanBudget);
        if (current.blockers.length > 0) throw new Error(`triwiki_cleanup_cas_blocked:${current.blockers.join(',')}`);
        if (current.digest !== target.digest) throw new Error(`triwiki_cleanup_cas_mismatch:${target.path}`);
        const to = path.join(swapRoot, 'targets', target.key);
        await ensureDir(path.dirname(to));
        await guardedRename(guard, from, to);
        moved.push({ from, to });
        const swapped = await inspectTree(to, target.path, swappedScanBudget);
        if (swapped.blockers.length > 0) throw new Error(`triwiki_cleanup_swap_blocked:${swapped.blockers.join(',')}`);
        if (swapped.digest !== target.digest) throw new Error(`triwiki_cleanup_swap_hash_mismatch:${target.path}`);
        targetReceipts.push({
          key: target.key,
          source_path: target.path,
          type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
          digest: target.digest
        });
      }

      for (const relative of plan.projected_agents_blocks) {
        const file = path.join(root, relative);
        const contents = String(await readText(file, '') || '');
        if (sha256(contents) !== plan.projection_hashes[relative]) throw new Error(`triwiki_cleanup_projection_cas_mismatch:${relative}`);
        projectionOriginals.set(file, contents);
      }
      const removed = await removeTriwikiAgentsMdBlocks(root);
      const removedSet = new Set(removed.map((file) => relativePosix(root, file)));
      for (const [file, before] of projectionOriginals) {
        const relative = relativePosix(root, file);
        if (!removedSet.has(relative)) throw new Error(`triwiki_cleanup_projection_not_removed:${relative}`);
        projectionReceipts.push({
          source_path: relative,
          before_sha256: sha256(before),
          after_sha256: sha256(String(await readText(file, '') || ''))
        });
      }

      commitStarted = true;
      if (await lstatOrNull(swapRoot)) await guardedRm(guard, swapRoot, { recursive: true, force: true });
      if (await lstatOrNull(swapRoot)) throw new Error('triwiki_cleanup_temporary_swap_not_removed');
      await removeEmptyDirectory(guard, path.dirname(swapRoot));
      const blank = await inspectTriWikiBlankState(root);
      if (!blank.blank) {
        throw new Error(`triwiki_cleanup_blank_verification_failed:${blank.active_targets.map((row) => row.path).concat(blank.projected_agents_blocks).join(',')}`);
      }
      clearContextGraphSnapshotCache();
      const receipt: TriWikiCleanupReceipt = {
        schema: TRIWIKI_CLEANUP_RECEIPT_SCHEMA,
        ok: true,
        generated_at: nowIso(),
        cleanup_id: cleanupId,
        root_binding_sha256: await rootBinding(root),
        mode: 'active_triwiki_blank_state',
        risk: 'R3',
        destructive: true,
        retained_backup: false,
        temporary_swap_removed: true,
        blank_verified: true,
        prior_state_digest: plan.state_digest,
        deleted_target_count: targetReceipts.length,
        removed_projection_count: projectionReceipts.length,
        files_deleted: plan.totals.files,
        directories_deleted: plan.totals.directories,
        bytes_deleted: plan.totals.bytes,
        target_receipts: targetReceipts,
        projection_receipts: projectionReceipts,
        preserved_audit_surfaces: [...PRESERVED_AUDIT_SURFACES],
        idempotent_reuse: false,
        blockers: []
      };
      await writeJsonAtomic(path.join(root, TRIWIKI_CLEANUP_RECEIPT_REL), receipt);
      return receipt;
    } catch (error) {
      if (commitStarted) throw error;
      const rollbackFailures: string[] = [];
      for (const [file, contents] of projectionOriginals) {
        try {
          await writeTextAtomic(file, contents);
        } catch (restoreError) {
          rollbackFailures.push(`projection:${relativePosix(root, file)}:${String(restoreError)}`);
        }
      }
      for (const entry of [...moved].reverse()) {
        try {
          if (await lstatOrNull(entry.to)) {
            await ensureDir(path.dirname(entry.from));
            await guardedRename(guard, entry.to, entry.from);
          }
        } catch (restoreError) {
          rollbackFailures.push(`target:${relativePosix(root, entry.from)}:${String(restoreError)}`);
        }
      }
      if (await lstatOrNull(swapRoot)) {
        try {
          await guardedRm(guard, swapRoot, { recursive: true, force: true });
        } catch (cleanupError) {
          rollbackFailures.push(`swap:${relativePosix(root, swapRoot)}:${String(cleanupError)}`);
        }
      }
      if (rollbackFailures.length) throw new Error(`triwiki_cleanup_failed:${String(error)};rollback_failed:${rollbackFailures.join('|')}`);
      throw error;
    }
  });
}

export async function validateTriWikiCleanupReceipt(rootInput: string): Promise<{
  ok: boolean;
  receipt: TriWikiCleanupReceipt | null;
  blank: TriWikiBlankState;
  blockers: string[];
}> {
  const root = path.resolve(rootInput);
  const receipt = await readJson<TriWikiCleanupReceipt | null>(path.join(root, TRIWIKI_CLEANUP_RECEIPT_REL), null);
  const blank = await inspectTriWikiBlankState(root);
  const blockers: string[] = [];
  if (!receipt || receipt.schema !== TRIWIKI_CLEANUP_RECEIPT_SCHEMA) blockers.push('triwiki_cleanup_receipt_missing');
  if (receipt && receipt.root_binding_sha256 !== await rootBinding(root)) blockers.push('triwiki_cleanup_receipt_root_mismatch');
  if (receipt && receipt.ok !== true) blockers.push('triwiki_cleanup_receipt_not_ok');
  if (receipt && receipt.blank_verified !== true) blockers.push('triwiki_cleanup_receipt_blank_not_verified');
  if (receipt && receipt.retained_backup !== false) blockers.push('triwiki_cleanup_backup_retained');
  if (receipt && receipt.temporary_swap_removed !== true) blockers.push('triwiki_cleanup_temporary_swap_not_removed');
  if (!blank.blank) blockers.push('triwiki_active_state_not_blank');
  return { ok: blockers.length === 0, receipt, blank, blockers };
}
