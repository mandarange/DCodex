/**
 * Working-tree guard.
 *
 * The loop's central claim is that an experiment is in-memory only. That claim is
 * checked rather than asserted: the tunable files and the whole measurement
 * surface are hashed before the first experiment and after every one of them, and
 * any difference aborts the run.
 *
 * The fingerprint is content-addressed and workspace-relative, so it records
 * *that* a file changed without recording what it contains or where it lives on
 * the machine.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { contextGraphGuardedFiles, CONTEXT_GRAPH_MEASUREMENT_PREFIXES } from './allowlist.js';
import type { ContextGraphSurfaceFile, ContextGraphSurfaceFingerprint } from './types.js';

/** Bound on the walk so a pathological tree cannot turn the guard into a scan. */
export const CONTEXT_GRAPH_GUARD_FILE_LIMIT = 512;

const MISSING = 'absent';

function hashFile(absolute: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  } catch {
    return MISSING;
  }
}

function walkSources(root: string, relativeDir: string, into: Set<string>): void {
  if (into.size >= CONTEXT_GRAPH_GUARD_FILE_LIMIT) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (into.size >= CONTEXT_GRAPH_GUARD_FILE_LIMIT) return;
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      walkSources(root, relative, into);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.json')) continue;
    into.add(relative);
  }
}

/** Workspace-relative POSIX paths the guard watches, sorted and de-duplicated. */
export function contextGraphGuardedPaths(root: string): readonly string[] {
  const out = new Set<string>(contextGraphGuardedFiles());
  for (const prefix of CONTEXT_GRAPH_MEASUREMENT_PREFIXES) {
    if (!prefix.startsWith('src/')) continue;
    walkSources(root, prefix.replace(/\/+$/, ''), out);
  }
  return [...out].sort();
}

export function fingerprintContextGraphTuningSurface(root: string): ContextGraphSurfaceFingerprint {
  const files: ContextGraphSurfaceFile[] = contextGraphGuardedPaths(root).map((relative) => ({
    path: relative,
    sha256: hashFile(path.join(root, ...relative.split('/')))
  }));
  const digest = crypto.createHash('sha256');
  for (const file of files) {
    digest.update(file.path);
    digest.update('\0');
    digest.update(file.sha256);
    digest.update('\n');
  }
  return { files, digest: digest.digest('hex') };
}

/**
 * Difference between two fingerprints as a sorted list of `<path>:<reason>`
 * markers. Empty means the experiment left the working tree exactly as it found it.
 */
export function contextGraphSurfaceDrift(
  before: ContextGraphSurfaceFingerprint,
  after: ContextGraphSurfaceFingerprint
): readonly string[] {
  if (before.digest === after.digest) return [];
  const beforeByPath = new Map(before.files.map((file) => [file.path, file.sha256] as const));
  const afterByPath = new Map(after.files.map((file) => [file.path, file.sha256] as const));
  const drift = new Set<string>();
  for (const [file, hash] of beforeByPath) {
    const now = afterByPath.get(file);
    if (now === undefined) drift.add(`${file}:removed`);
    else if (now !== hash) drift.add(`${file}:${hash === MISSING ? 'created' : now === MISSING ? 'deleted' : 'mutated'}`);
  }
  for (const file of afterByPath.keys()) {
    if (!beforeByPath.has(file)) drift.add(`${file}:added`);
  }
  if (!drift.size) drift.add('digest_changed');
  return [...drift].sort();
}

/** True when the guarded surface is byte-identical to the recorded fingerprint. */
export function contextGraphSurfaceUnchanged(
  before: ContextGraphSurfaceFingerprint,
  after: ContextGraphSurfaceFingerprint
): boolean {
  return contextGraphSurfaceDrift(before, after).length === 0;
}
