import fsp from 'node:fs/promises';
import path from 'node:path';
import { exists, nowIso, sha256, writeJsonAtomic } from '../fsx.js';
import { allocateWorkerWorktree } from '../git/git-worktree-manager.js';
import { gitOutputLine, runGitCommand } from '../git/git-worktree-runner.js';
import type { SksLoopNode, SksLoopOwnerScope, SksLoopPlan } from './loop-schema.js';
import { loopNodeRoot } from './loop-artifacts.js';

export interface LoopWorktreeRecord {
  schema: 'sks.loop-worktree.v1';
  loop_id: string;
  worktree_id: string | null;
  path: string | null;
  branch: string | null;
  base_ref: string | null;
  allocated_at: string;
  cleanup_policy: string;
  blockers: string[];
}

export interface LoopDiffSummary {
  changed_files: string[];
  patch_bytes: number;
  diff_stat: string;
  base_revision: string | null;
  diff_sha256: string;
  blockers: string[];
}

export async function allocateLoopWorktree(input: {
  root: string;
  plan: SksLoopPlan;
  node: SksLoopNode;
  noMutation?: boolean;
}): Promise<LoopWorktreeRecord> {
  const blockers: string[] = [];
  let worktreeId: string | null = null;
  let worktreePath: string | null = null;
  let branch: string | null = null;
  let baseRef: string | null = null;
  if (input.node.worktree.required && !input.noMutation) {
    const gitPresent = await exists(path.join(input.root, '.git'));
    if (!gitPresent) {
      blockers.push('loop_worktree_required_but_git_missing');
    } else {
      const allocation = await allocateWorkerWorktree({
        repoRoot: input.root,
        missionId: input.plan.mission_id,
        workerId: input.node.loop_id,
        slotId: input.node.loop_id,
        generationIndex: 1,
        branchPrefix: input.node.worktree.branch_prefix
      }).catch((err: unknown) => ({ ok: false, blockers: [`loop_worktree_allocate_exception:${err instanceof Error ? err.message : String(err)}`] }));
      if ((allocation as any).ok) {
        worktreeId = (allocation as any).worker_id || input.node.loop_id;
        worktreePath = (allocation as any).worktree_path || null;
        branch = (allocation as any).branch || null;
        baseRef = (allocation as any).base_ref || null;
      } else {
        blockers.push(...stringArray((allocation as any).blockers));
      }
    }
  }
  const record: LoopWorktreeRecord = {
    schema: 'sks.loop-worktree.v1',
    loop_id: input.node.loop_id,
    worktree_id: worktreeId,
    path: worktreePath,
    branch,
    base_ref: baseRef,
    allocated_at: nowIso(),
    cleanup_policy: input.node.worktree.cleanup,
    blockers
  };
  await writeJsonAtomic(path.join(loopNodeRoot(input.root, input.plan.mission_id, input.node.loop_id), 'worktree.json'), record);
  return record;
}

export async function computeLoopDiff(input: {
  root: string;
  worktreePath?: string | null;
  ownerScope: SksLoopOwnerScope;
}): Promise<LoopDiffSummary> {
  const cwd = input.worktreePath || input.root;
  const blockers: string[] = [];
  const names = await runGitCommand(cwd, ['diff', '--name-only', '-z', 'HEAD'], { timeoutMs: 30000 }).catch(() => null);
  const untracked = await runGitCommand(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { timeoutMs: 30000 }).catch(() => null);
  const stat = await runGitCommand(cwd, ['diff', '--stat', 'HEAD'], { timeoutMs: 30000 }).catch(() => null);
  const diff = await runGitCommand(cwd, ['diff', '--binary', '--full-index', 'HEAD'], { timeoutMs: 60000 }).catch(() => null);
  const revision = await runGitCommand(cwd, ['rev-parse', 'HEAD'], { timeoutMs: 30000 }).catch(() => null);
  if (!names?.ok) blockers.push('loop_git_diff_name_only_failed');
  if (!untracked?.ok) blockers.push('loop_git_untracked_scan_failed');
  if (!diff?.ok) blockers.push('loop_git_diff_failed');
  const trackedFiles = nulPaths(names?.stdout || '');
  const untrackedFiles = nulPaths(untracked?.stdout || '');
  const untrackedSnapshot = await snapshotUntrackedFiles(cwd, untrackedFiles);
  blockers.push(...untrackedSnapshot.blockers);
  const changedFiles = [...new Set([...trackedFiles, ...untrackedFiles])].sort();
  blockers.push(...enforceLoopOwnerScope(changedFiles, input.ownerScope));
  const trackedDiff = diff?.stdout || '';
  return {
    changed_files: changedFiles,
    patch_bytes: Buffer.byteLength(trackedDiff) + untrackedSnapshot.bytes,
    diff_stat: stat ? gitOutputLine(stat) || stat.stdout.slice(-4000) : '',
    base_revision: revision?.ok ? revision.stdout.trim() || null : null,
    diff_sha256: `sha256:${sha256(`${trackedDiff}\0${JSON.stringify(untrackedSnapshot.files)}`)}`,
    blockers: [...new Set(blockers)]
  };
}

const MAX_UNTRACKED_SNAPSHOT_BYTES_PER_FILE = 16 * 1024 * 1024;

async function snapshotUntrackedFiles(cwd: string, files: string[]) {
  const snapshots: Array<{ path: string; bytes: number; sha256: string }> = [];
  const blockers: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const absolute = path.resolve(cwd, file);
    if (!absolute.startsWith(`${path.resolve(cwd)}${path.sep}`)) {
      blockers.push(`loop_untracked_path_escape:${file}`);
      continue;
    }
    try {
      const stat = await fsp.lstat(absolute);
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        blockers.push(`loop_untracked_unsupported_type:${file}`);
        continue;
      }
      if (stat.size > MAX_UNTRACKED_SNAPSHOT_BYTES_PER_FILE) {
        blockers.push(`loop_untracked_file_too_large:${file}`);
        continue;
      }
      const content = stat.isSymbolicLink()
        ? Buffer.from(await fsp.readlink(absolute))
        : await fsp.readFile(absolute);
      bytes += content.byteLength;
      snapshots.push({ path: file, bytes: content.byteLength, sha256: sha256(content) });
    } catch {
      blockers.push(`loop_untracked_snapshot_failed:${file}`);
    }
  }
  return { files: snapshots, bytes, blockers };
}

function nulPaths(value: string) {
  return value.split('\0').filter((file) => file.length > 0);
}

export function enforceLoopOwnerScope(changedFiles: string[], ownerScope: SksLoopOwnerScope): string[] {
  const blockers: string[] = [];
  for (const file of changedFiles) {
    if (!isInOwnerScope(file, ownerScope)) blockers.push(`loop_owner_scope_violation:${file}`);
  }
  return blockers;
}

function isInOwnerScope(file: string, ownerScope: SksLoopOwnerScope): boolean {
  const normalized = normalizePath(file);
  if (ownerScope.files.map(normalizePath).includes(normalized)) return true;
  return ownerScope.directories.map(normalizePath).some((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
}

function normalizePath(value: string): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}
