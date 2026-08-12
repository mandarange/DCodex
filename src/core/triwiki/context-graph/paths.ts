/**
 * Workspace-relative POSIX path discipline for the Context Graph.
 *
 * Every path that reaches a node, an edge provenance record, or an artifact has
 * to survive `normalizeGraphPath`: no absolute paths, no `..` escapes, no
 * symlinks that leave the workspace, no home directory anywhere.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CONTEXT_GRAPH_DIR_SEGMENTS = ['.sneakoscope', 'wiki'] as const;

export class ContextGraphPathError extends Error {
  readonly code: 'absolute_or_escaping_path' | 'symlink_escape' | 'empty_path';

  constructor(code: ContextGraphPathError['code'], message: string) {
    super(message);
    this.name = 'ContextGraphPathError';
    this.code = code;
  }
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Normalize `candidate` (absolute or relative) into a workspace-relative POSIX
 * path. Throws `ContextGraphPathError` when the result would leave the root.
 */
export function normalizeGraphPath(root: string, candidate: string): string {
  const raw = String(candidate ?? '').trim();
  if (!raw) throw new ContextGraphPathError('empty_path', 'graph path is empty');
  const absoluteRoot = path.resolve(root);
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(absoluteRoot, raw);
  const relative = path.relative(absoluteRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ContextGraphPathError('absolute_or_escaping_path', `path escapes the workspace: ${toPosix(raw)}`);
  }
  return toPosix(relative);
}

/** Non-throwing variant for extractors that must record a skip instead of failing the compile. */
export function tryNormalizeGraphPath(root: string, candidate: string): string | null {
  try {
    return normalizeGraphPath(root, candidate);
  } catch {
    return null;
  }
}

export function isWorkspaceRelativePosixPath(value: string): boolean {
  if (typeof value !== 'string' || !value) return false;
  if (value.includes('\\')) return false;
  if (path.posix.isAbsolute(value)) return false;
  if (/^[A-Za-z]:\//.test(value)) return false;
  if (value === '..' || value.startsWith('../') || value.includes('/../') || value.endsWith('/..')) return false;
  if (value.startsWith('~')) return false;
  return true;
}

/**
 * Resolve a workspace-relative path while refusing any symlink hop that lands
 * outside the workspace. Returns `null` for a missing file so callers can skip.
 */
export function resolveInsideWorkspace(root: string, relative: string): string | null {
  const absoluteRoot = safeRealpath(path.resolve(root));
  const absolute = path.resolve(absoluteRoot, relative);
  if (!fs.existsSync(absolute)) return null;
  const real = safeRealpath(absolute);
  const rel = path.relative(absoluteRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ContextGraphPathError('symlink_escape', `symlink leaves the workspace: ${toPosix(relative)}`);
  }
  return real;
}

export function isSymlinkEscape(root: string, relative: string): boolean {
  try {
    resolveInsideWorkspace(root, relative);
    return false;
  } catch (error) {
    return error instanceof ContextGraphPathError && error.code === 'symlink_escape';
  }
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

export function contextGraphDir(root: string): string {
  return path.join(root, ...CONTEXT_GRAPH_DIR_SEGMENTS);
}

export function contextGraphSnapshotPath(root: string): string {
  return path.join(contextGraphDir(root), 'context-graph.json');
}

export function contextGraphMetaPath(root: string): string {
  return path.join(contextGraphDir(root), 'context-graph.meta.json');
}

/**
 * Retired artifact. Older builds rotated the outgoing snapshot here and nothing
 * ever read it back, so the path survives for exactly two jobs: reclaiming the
 * duplicate a pre-existing workspace still carries, and keeping the name in the
 * cache-key exclusion set so that duplicate cannot feed the graph's own key.
 */
export function contextGraphPrevSnapshotPath(root: string): string {
  return path.join(contextGraphDir(root), 'context-graph.prev.json');
}

export function contextGraphEventLogPath(root: string): string {
  return path.join(contextGraphDir(root), 'context-graph-events.jsonl');
}

export function contextGraphFragmentCacheDir(root: string): string {
  return path.join(root, '.sneakoscope', 'cache', 'context-graph', 'fragments');
}

export function contextGraphLockPath(root: string): string {
  return path.join(root, '.sneakoscope', 'cache', 'context-graph', 'compile.lock');
}

export function contextGraphBenchmarkReportPath(root: string): string {
  return path.join(root, '.sneakoscope', 'reports', 'context-graph-benchmark.json');
}

export function contextGraphExperimentLogPath(root: string): string {
  return path.join(root, '.sneakoscope', 'reports', 'context-graph-experiments.jsonl');
}

export function contextPackPath(root: string): string {
  return path.join(contextGraphDir(root), 'context-pack.json');
}

/**
 * Artifacts the graph owns; every other repository file stays untouched. The
 * retired prev snapshot is listed because the graph still removes it, not
 * because it still writes it.
 */
export function contextGraphArtifactPaths(root: string): string[] {
  return [
    contextGraphSnapshotPath(root),
    contextGraphMetaPath(root),
    contextGraphPrevSnapshotPath(root),
    contextGraphEventLogPath(root)
  ];
}
