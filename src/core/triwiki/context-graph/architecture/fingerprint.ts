import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../json/canonical.js';
import { sha256 } from '../../../fsx.js';
import type { WorktreeFingerprint, WorktreePathFingerprint } from './contracts.js';
import { byCodePoint } from './contracts.js';

export function hashCanonical(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Exclude generatedAt and other volatile fields from hash input. */
export function hashWithoutKeys(value: Record<string, unknown>, omit: readonly string[]): string {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(byCodePoint)) {
    if (omit.includes(key)) continue;
    copy[key] = value[key];
  }
  return hashCanonical(copy);
}

export function sealBaselinePayload(canonicalPayloadHash: string): string {
  return sha256(`sks.architecture-baseline.v1\n${canonicalPayloadHash}`);
}

export function buildWorktreeFingerprint(input: {
  rootId: string;
  head: string | null;
  paths: readonly WorktreePathFingerprint[];
}): WorktreeFingerprint {
  const paths = [...input.paths].sort((a, b) => byCodePoint(a.path, b.path));
  const fingerprintHash = hashCanonical({
    rootId: input.rootId,
    head: input.head,
    paths
  });
  const dirtyPaths = Object.freeze(
    paths.filter((entry) => entry.kind !== 'missing').map((entry) => entry.path)
  );
  return Object.freeze({
    rootId: input.rootId,
    head: input.head,
    repositoryHead: input.head,
    paths: Object.freeze(paths),
    fingerprintHash,
    hash: fingerprintHash,
    dirtyPaths
  });
}

export function emptyWorktreeFingerprint(rootId: string, head: string | null = null): WorktreeFingerprint {
  return buildWorktreeFingerprint({ rootId, head, paths: [] });
}

export function shortHash(value: string, length = 12): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/** Diff two worktree path inventories into ChangedPathRecord-like rows. */
export function diffWorktreePaths(
  before: readonly WorktreePathFingerprint[],
  after: readonly WorktreePathFingerprint[]
): ReadonlyArray<{ readonly path: string; readonly change: 'added' | 'removed' | 'content' | 'type' | 'mode' }> {
  const beforeMap = new Map(before.map((entry) => [entry.path, entry]));
  const afterMap = new Map(after.map((entry) => [entry.path, entry]));
  const paths = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const out: Array<{ path: string; change: 'added' | 'removed' | 'content' | 'type' | 'mode' }> = [];
  for (const path of [...paths].sort(byCodePoint)) {
    const left = beforeMap.get(path);
    const right = afterMap.get(path);
    if (!left && right) {
      out.push({ path, change: 'added' });
      continue;
    }
    if (left && !right) {
      out.push({ path, change: 'removed' });
      continue;
    }
    if (!left || !right) continue;
    if (left.kind !== right.kind) {
      out.push({ path, change: 'type' });
      continue;
    }
    if (left.sha256 !== right.sha256) {
      out.push({ path, change: 'content' });
      continue;
    }
    if (left.executable !== right.executable) {
      out.push({ path, change: 'mode' });
    }
  }
  return Object.freeze(out);
}
