/**
 * Atomic snapshot storage.
 *
 * Three invariants hold here:
 *   1. A write is a rename, so a crash mid-write leaves the previous artifact
 *      byte-intact rather than a half-written one.
 *   2. Exactly one previous generation is kept, and it is only ever returned when
 *      a caller explicitly asks for it. A corrupt current snapshot NEVER silently
 *      resolves to the previous one — it surfaces a blocker naming the repair
 *      command instead.
 *   3. Nothing written here carries an absolute path: artifact identity is always
 *      expressed workspace-relative.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic, writeTextAtomic } from '../../../fsx.js';
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

/** Current snapshot. Missing and corrupt are distinct, explicit statuses; neither falls back to prev. */
export function readContextGraphSnapshot(root: string): Promise<ContextGraphSnapshotLoad> {
  return loadSnapshotFile(root, contextGraphSnapshotPath(root));
}

/** Previous generation, only ever returned to a caller that asked for it by name. */
export function readContextGraphPrevSnapshot(root: string): Promise<ContextGraphSnapshotLoad> {
  return loadSnapshotFile(root, contextGraphPrevSnapshotPath(root));
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
  rotatedPrevious: boolean;
  artifact: string;
}

/**
 * Commit a snapshot + meta pair. The current generation is rotated to
 * `context-graph.prev.json` first (only when it is itself readable, so a corrupt
 * current file cannot destroy a good previous one), then the snapshot is written,
 * then the meta. A crash between the two leaves a detectable snapshot/meta
 * mismatch, which `contextGraphStatus()` reports as corrupt rather than serving.
 */
export async function writeContextGraphSnapshot(
  input: WriteContextGraphSnapshotInput
): Promise<WriteContextGraphSnapshotResult> {
  const { root, snapshot, meta } = input;
  const snapshotFile = contextGraphSnapshotPath(root);
  const artifact = relative(root, snapshotFile);
  const currentRaw = await readTextOrNull(snapshotFile);
  let previousSnapshotHash: string | null = null;
  let rotatedPrevious = false;

  if (currentRaw !== null) {
    let currentHash: string | null = null;
    try {
      const parsed: unknown = JSON.parse(currentRaw);
      const hash = (parsed as { snapshotHash?: unknown } | null)?.snapshotHash;
      currentHash = typeof hash === 'string' && hash ? hash : null;
    } catch {
      currentHash = null;
    }
    // A corrupt current file is left where it is rather than promoted to prev:
    // overwriting a good previous generation with garbage helps nobody.
    if (currentHash) {
      previousSnapshotHash = currentHash;
      await writeTextAtomic(contextGraphPrevSnapshotPath(root), currentRaw);
      rotatedPrevious = true;
    }
  }

  await writeJsonAtomic(snapshotFile, snapshot);
  await writeJsonAtomic(contextGraphMetaPath(root), meta);
  return { wrote: true, previousSnapshotHash, rotatedPrevious, artifact };
}
