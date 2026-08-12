/**
 * Where the fragment manifest lives, and what a damaged one means.
 *
 * The manifest sits under `.sneakoscope/cache/`, not under the published
 * `wiki/context-graph/` store, and that placement is the policy: it is
 * compile-side bookkeeping that only ever decides *how much work to skip*.
 * Losing it costs a full rebuild; trusting a damaged one would cost a wrong
 * graph. So — unlike the operation journal, where an unreadable file is a hard
 * blocker — an unreadable manifest reads as `unreadable` and the planner turns
 * that into a full rebuild without failing the compile.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeTextAtomic } from '../../../fsx.js';
import {
  parseContextFragmentManifest,
  serializeContextFragmentManifest,
  type ContextFragmentManifest,
} from './fragment-manifest.js';

const MANIFEST_SEGMENTS = ['.sneakoscope', 'cache', 'context-graph'] as const;
export const CONTEXT_FRAGMENT_MANIFEST_FILE = 'fragment-manifest.json' as const;

export function contextFragmentManifestDir(root: string): string {
  return path.join(root, ...MANIFEST_SEGMENTS);
}

export function contextFragmentManifestPath(root: string): string {
  return path.join(contextFragmentManifestDir(root), CONTEXT_FRAGMENT_MANIFEST_FILE);
}

/** Workspace-relative because it is the form that may be written into a receipt. */
export function contextFragmentManifestRelative(): string {
  return `${MANIFEST_SEGMENTS.join('/')}/${CONTEXT_FRAGMENT_MANIFEST_FILE}`;
}

export type FragmentManifestReadStatus = 'ok' | 'absent' | 'unreadable';

export interface FragmentManifestReadResult {
  readonly status: FragmentManifestReadStatus;
  readonly manifest: ContextFragmentManifest | null;
}

export async function readContextFragmentManifest(root: string): Promise<FragmentManifestReadResult> {
  let text: string;
  try {
    text = await fsp.readFile(contextFragmentManifestPath(root), 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'absent', manifest: null };
    return { status: 'unreadable', manifest: null };
  }
  try {
    return { status: 'ok', manifest: parseContextFragmentManifest(JSON.parse(text)) };
  } catch {
    return { status: 'unreadable', manifest: null };
  }
}

export async function writeContextFragmentManifest(
  root: string,
  manifest: ContextFragmentManifest,
): Promise<ContextFragmentManifest> {
  // Re-validated on the way out so a caller-constructed object cannot put an
  // absolute path or an out-of-order entry list into the file.
  const validated = parseContextFragmentManifest(JSON.parse(serializeContextFragmentManifest(manifest)));
  await fsp.mkdir(contextFragmentManifestDir(root), { recursive: true });
  await writeTextAtomic(contextFragmentManifestPath(root), `${serializeContextFragmentManifest(validated)}\n`);
  return validated;
}

export async function removeContextFragmentManifest(root: string): Promise<void> {
  await fsp.rm(contextFragmentManifestPath(root), { force: true });
}
