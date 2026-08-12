/**
 * Atomic snapshot storage.
 *
 * Three invariants hold here:
 *   1. A write is a rename, so a crash mid-write leaves the previous artifact
 *      byte-intact rather than a half-written one.
 *   2. No previous generation is retained on disk. A corrupt current snapshot has
 *      nothing to silently resolve to — it surfaces a blocker naming the repair
 *      command instead. `previousSnapshotHash` still names the generation being
 *      replaced, because a hash is what every consumer actually wanted; the
 *      63 MB byte-identical second copy that used to back it had no reader in the
 *      entire history of this module, so `context-graph.prev.json` is now a
 *      retired artifact that a commit reclaims rather than rewrites.
 *   3. Nothing written here carries an absolute path: artifact identity is always
 *      expressed workspace-relative.
 */
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, sha256, writeJsonAtomic } from '../../../fsx.js';
import {
  CONTEXT_GRAPH_CORRUPT_ERROR,
  CONTEXT_GRAPH_META_SCHEMA,
  CONTEXT_GRAPH_MISSING_ERROR,
  CONTEXT_GRAPH_REPAIR_COMMAND,
  validateContextGraphSnapshot,
  type ContextGraphLintIssue,
  type ContextGraphMeta,
  type ContextGraphSnapshot
} from '../contracts.js';
import {
  contextGraphMetaPath,
  contextGraphPrevSnapshotPath,
  contextGraphSnapshotPath
} from '../paths.js';
import { withEvidenceWriterLock, type EvidenceWriterLockReceipt } from './evidence-write-lock.js';

export type ContextGraphArtifactStatus = 'ok' | 'missing' | 'corrupt';

export type ContextGraphArtifactErrorCode =
  | typeof CONTEXT_GRAPH_MISSING_ERROR
  | typeof CONTEXT_GRAPH_CORRUPT_ERROR;

export interface ContextGraphSnapshotLoad {
  status: ContextGraphArtifactStatus;
  snapshot: ContextGraphSnapshot | null;
  issues: ContextGraphLintIssue[];
  /** Operator-facing blocker naming the repair command; `null` when the artifact is usable. */
  blocker: string | null;
  errorCode: ContextGraphArtifactErrorCode | null;
  repairCommand: typeof CONTEXT_GRAPH_REPAIR_COMMAND;
  /** Workspace-relative artifact path, safe to print. */
  artifact: string;
}

export interface ContextGraphMetaLoad {
  status: ContextGraphArtifactStatus;
  meta: ContextGraphMeta | null;
  blocker: string | null;
  errorCode: ContextGraphArtifactErrorCode | null;
  repairCommand: typeof CONTEXT_GRAPH_REPAIR_COMMAND;
  artifact: string;
}

function relative(root: string, absolute: string): string {
  return path.relative(path.resolve(root), absolute).split(path.sep).join('/');
}

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function missingSnapshot(artifact: string): ContextGraphSnapshotLoad {
  return {
    status: 'missing',
    snapshot: null,
    issues: [],
    blocker: `${artifact} does not exist. Run \`${CONTEXT_GRAPH_REPAIR_COMMAND}\` to build it.`,
    errorCode: CONTEXT_GRAPH_MISSING_ERROR,
    repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND,
    artifact
  };
}

function corruptSnapshot(artifact: string, detail: string, issues: ContextGraphLintIssue[]): ContextGraphSnapshotLoad {
  return {
    status: 'corrupt',
    snapshot: null,
    issues,
    blocker: `${artifact} is unusable (${detail}). Run \`${CONTEXT_GRAPH_REPAIR_COMMAND}\` to rebuild it; the previous generation is not substituted automatically.`,
    errorCode: CONTEXT_GRAPH_CORRUPT_ERROR,
    repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND,
    artifact
  };
}

async function loadSnapshotFile(root: string, file: string): Promise<ContextGraphSnapshotLoad> {
  const artifact = relative(root, file);
  const raw = await readTextOrNull(file);
  if (raw === null) return missingSnapshot(artifact);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return corruptSnapshot(artifact, 'invalid JSON', []);
  }
  const validation = validateContextGraphSnapshot(parsed);
  if (!validation.ok) {
    return corruptSnapshot(artifact, 'failed structural validation', validation.issues);
  }
  return {
    status: 'ok',
    snapshot: parsed as ContextGraphSnapshot,
    issues: validation.issues,
    blocker: null,
    errorCode: null,
    repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND,
    artifact
  };
}

/**
 * Current snapshot. Missing and corrupt are distinct, explicit statuses, and
 * there is no other generation on disk for either one to fall back to.
 */
export function readContextGraphSnapshot(root: string): Promise<ContextGraphSnapshotLoad> {
  return loadSnapshotFile(root, contextGraphSnapshotPath(root));
}

function isMeta(value: unknown): value is ContextGraphMeta {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Partial<ContextGraphMeta>;
  return (
    meta.schema === CONTEXT_GRAPH_META_SCHEMA
    && typeof meta.snapshotHash === 'string'
    && Boolean(meta.snapshotHash)
    && typeof meta.cacheKey === 'string'
    && Boolean(meta.cacheKeyParts)
    && typeof meta.cacheKeyParts === 'object'
    && Boolean(meta.inputHashes)
    && typeof meta.inputHashes === 'object'
  );
}

export async function readContextGraphMeta(root: string): Promise<ContextGraphMetaLoad> {
  const file = contextGraphMetaPath(root);
  const artifact = relative(root, file);
  const raw = await readTextOrNull(file);
  const base = { repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND, artifact } as const;
  if (raw === null) {
    return {
      ...base,
      status: 'missing',
      meta: null,
      blocker: `${artifact} does not exist. Run \`${CONTEXT_GRAPH_REPAIR_COMMAND}\` to build it.`,
      errorCode: CONTEXT_GRAPH_MISSING_ERROR
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isMeta(parsed)) {
    return {
      ...base,
      status: 'corrupt',
      meta: null,
      blocker: `${artifact} is unusable. Run \`${CONTEXT_GRAPH_REPAIR_COMMAND}\` to rebuild it.`,
      errorCode: CONTEXT_GRAPH_CORRUPT_ERROR
    };
  }
  return { ...base, status: 'ok', meta: parsed, blocker: null, errorCode: null };
}

/**
 * Hash of the snapshot currently on disk, or `null` when there is none (or it is
 * unreadable). Lets a compiler record `previousSnapshotHash` in its meta without
 * writing the artifact twice.
 */
export async function readContextGraphSnapshotHash(root: string): Promise<string | null> {
  const raw = await readTextOrNull(contextGraphSnapshotPath(root));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const hash = (parsed as { snapshotHash?: unknown } | null)?.snapshotHash;
    return typeof hash === 'string' && hash ? hash : null;
  } catch {
    return null;
  }
}

export interface WriteContextGraphSnapshotInput {
  root: string;
  snapshot: ContextGraphSnapshot;
  meta: ContextGraphMeta;
}

export interface WriteContextGraphSnapshotResult {
  wrote: boolean;
  previousSnapshotHash: string | null;
  /** `true` when this commit reclaimed a retired `context-graph.prev.json` left by an older build. */
  reclaimedRetiredPrevious: boolean;
  artifact: string;
}

export interface StagedContextGraphCommitInput extends WriteContextGraphSnapshotInput {
  projectId: string;
  expectedCurrentFileHash: string | null;
  waitMs?: number;
  beforeReplace?: () => Promise<void> | void;
}

export type StagedContextGraphCommitResult =
  | {
      status: 'committed';
      wrote: true;
      previousSnapshotHash: string | null;
      reclaimedRetiredPrevious: boolean;
      artifact: string;
      currentFileHash: string;
      lock: EvidenceWriterLockReceipt;
    }
  | {
      status: 'conflict' | 'invalid_staging';
      wrote: false;
      blocker: 'context_graph_user_provenance_conflict' | 'context_graph_staging_invalid';
      artifact: string;
    };

/**
 * Commit a snapshot + meta pair. The hash of the generation being replaced is
 * read first (only when the current file is itself readable, so a corrupt current
 * file names no predecessor), then the snapshot is written, then the meta. A crash
 * between the two leaves a detectable snapshot/meta mismatch, which
 * `contextGraphStatus()` reports as corrupt rather than serving.
 */
export async function writeContextGraphSnapshot(
  input: WriteContextGraphSnapshotInput
): Promise<WriteContextGraphSnapshotResult> {
  const expectedCurrentFileHash = await contextGraphCurrentFileHash(input.root);
  const committed = await stageAndCommitContextGraphSnapshot({
    ...input,
    projectId: input.meta.cacheKeyParts.workspaceIdentity,
    expectedCurrentFileHash
  });
  if (committed.status !== 'committed') throw new Error(committed.blocker);
  return committed;
}

export async function contextGraphCurrentFileHash(root: string): Promise<string | null> {
  const raw = await readTextOrNull(contextGraphSnapshotPath(root));
  return raw === null ? null : sha256(raw);
}

/**
 * Delete the retired `context-graph.prev.json`.
 *
 * Builds before this one rotated the outgoing snapshot into a second file that
 * nothing ever read back, so every workspace compiled by an older build is
 * carrying a byte-identical duplicate of a ~63 MB artifact. Stopping the write
 * alone would leave that duplicate on disk indefinitely — it is gitignored, and
 * the wiki retention sweep only reaches it under age or count pressure — so the
 * commit that would once have overwritten it removes it instead.
 *
 * Best-effort by construction: the current snapshot is already committed by the
 * time this runs, and the file being removed is a duplicate of it, so a failure
 * to reclaim disk can never be a reason to fail a compile.
 */
async function reclaimRetiredPrevSnapshot(root: string): Promise<boolean> {
  const retired = contextGraphPrevSnapshotPath(root);
  try {
    const stat = await fsp.lstat(retired);
    if (!stat.isFile()) return false;
    await fsp.rm(retired, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function stageAndCommitContextGraphSnapshot(
  input: StagedContextGraphCommitInput
): Promise<StagedContextGraphCommitResult> {
  const { root, snapshot, meta } = input;
  const snapshotFile = contextGraphSnapshotPath(root);
  const artifact = relative(root, snapshotFile);
  const stagingDir = path.join(path.dirname(snapshotFile), `.context-graph.staging-${process.pid}-${randomUUID()}`);
  const stagedSnapshot = path.join(stagingDir, 'context-graph.json');
  const stagedMeta = path.join(stagingDir, 'context-graph.meta.json');
  await ensureDir(stagingDir);
  try {
    await writeJsonAtomic(stagedSnapshot, snapshot);
    await writeJsonAtomic(stagedMeta, meta);
    const validation = validateContextGraphSnapshot(JSON.parse(await fsp.readFile(stagedSnapshot, 'utf8')) as unknown);
    const stagedMetaValue = JSON.parse(await fsp.readFile(stagedMeta, 'utf8')) as ContextGraphMeta;
    const referenceValid = stagedMetaValue.schema === CONTEXT_GRAPH_META_SCHEMA
      && stagedMetaValue.snapshotHash === snapshot.snapshotHash
      && stagedMetaValue.nodeCount === snapshot.nodeCount
      && stagedMetaValue.edgeCount === snapshot.edgeCount;
    if (!validation.ok || !referenceValid) {
      return { status: 'invalid_staging', wrote: false, blocker: 'context_graph_staging_invalid', artifact };
    }

    return await withEvidenceWriterLock({
      root,
      projectId: input.projectId,
      ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
      run: async (lock): Promise<StagedContextGraphCommitResult> => {
        const currentRaw = await readTextOrNull(snapshotFile);
        const currentFileHash = currentRaw === null ? null : sha256(currentRaw);
        if (currentFileHash !== input.expectedCurrentFileHash) {
          return { status: 'conflict', wrote: false, blocker: 'context_graph_user_provenance_conflict', artifact };
        }
        let previousSnapshotHash: string | null = null;
        if (currentRaw !== null) {
          try {
            const parsed = JSON.parse(currentRaw) as { snapshotHash?: unknown };
            if (typeof parsed.snapshotHash === 'string' && parsed.snapshotHash) {
              previousSnapshotHash = parsed.snapshotHash;
            }
          } catch {
            // A corrupt current generation names no predecessor.
          }
        }
        await input.beforeReplace?.();
        await fsp.rename(stagedSnapshot, snapshotFile);
        await fsp.rename(stagedMeta, contextGraphMetaPath(root));
        return {
          status: 'committed', wrote: true, previousSnapshotHash, artifact,
          reclaimedRetiredPrevious: await reclaimRetiredPrevSnapshot(root),
          currentFileHash: sha256(await fsp.readFile(snapshotFile, 'utf8')), lock
        };
      }
    });
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
