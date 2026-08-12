/**
 * Content-addressed storage for source fragments.
 *
 * This is the other half of retiring the JSON runtime store: the manifest says
 * *which* fragments may be reused, and this store is where their contents come
 * from. An incremental build therefore reads only the fragments it kept, never a
 * whole-graph snapshot it then has to diff.
 *
 * Every load is re-addressed before it is trusted. A cached fragment is the one
 * input that stands in for work that did not run, so a payload whose recomputed
 * content hash does not match the manifest entry that named it is discarded and
 * the source is re-extracted. That turns a corrupt or truncated cache file into
 * a slower build rather than a wrong graph.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeTextAtomic } from '../../../fsx.js';
import type { FragmentManifestEntry } from './fragment-manifest-schema.js';
import {
  parseSourceFragment,
  sourceFragmentContentHash,
  type ContextGraphSourceFragment,
} from './source-fragment.js';

const FRAGMENT_SEGMENTS = ['.sneakoscope', 'cache', 'context-graph', 'source-fragments'] as const;

export function sourceFragmentStoreDir(root: string): string {
  return path.join(root, ...FRAGMENT_SEGMENTS);
}

/** Two-level fan-out: one flat directory of tens of thousands of entries is hostile to every filesystem. */
export function sourceFragmentPath(root: string, fragmentHash: string): string {
  return path.join(sourceFragmentStoreDir(root), fragmentHash.slice(0, 2), `${fragmentHash}.json`);
}

export interface SourceFragmentStore {
  /** `null` for any miss, corruption, or identity mismatch — never a repair in place. */
  load(entry: FragmentManifestEntry): Promise<ContextGraphSourceFragment | null>;
  save(fragment: ContextGraphSourceFragment): Promise<void>;
}

function matchesEntry(fragment: ContextGraphSourceFragment, entry: FragmentManifestEntry): boolean {
  return (
    fragment.extractor === entry.extractor
    && fragment.extractorRevision === entry.extractorRevision
    && fragment.sourcePath === entry.sourcePath
    && fragment.sourceHash === entry.sourceHash
    && fragment.nodes.length === entry.nodeCount
    && fragment.edges.length === entry.edgeCount
  );
}

export function fileSourceFragmentStore(root: string): SourceFragmentStore {
  return {
    async load(entry: FragmentManifestEntry): Promise<ContextGraphSourceFragment | null> {
      let text: string;
      try {
        text = await fsp.readFile(sourceFragmentPath(root, entry.fragmentHash), 'utf8');
      } catch {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return null;
      }
      const fragment = parseSourceFragment(parsed);
      if (!fragment || !matchesEntry(fragment, entry)) return null;
      // The address is recomputed rather than assumed: the file name only proves
      // where the bytes were filed, not what they say.
      return sourceFragmentContentHash(fragment) === entry.fragmentHash ? fragment : null;
    },

    async save(fragment: ContextGraphSourceFragment): Promise<void> {
      const target = sourceFragmentPath(root, sourceFragmentContentHash(fragment));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await writeTextAtomic(target, `${JSON.stringify(fragment)}\n`);
    },
  };
}

/**
 * Drop every payload the new manifest does not name.
 *
 * Retention is by reachability rather than by age: the store is content-addressed
 * and an unreferenced payload can never be reached again, while an mtime-based
 * bound would eventually evict a fragment the current manifest still points at
 * and turn a no-op build into a full one.
 */
export async function pruneSourceFragmentStore(
  root: string,
  referenced: ReadonlySet<string>,
): Promise<number> {
  const base = sourceFragmentStoreDir(root);
  let buckets: string[];
  try {
    buckets = await fsp.readdir(base);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const bucket of buckets.sort()) {
    const dir = path.join(base, bucket);
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      if (referenced.has(name.slice(0, -'.json'.length))) continue;
      try {
        await fsp.rm(path.join(dir, name), { force: true });
        removed += 1;
      } catch {
        // A payload that could not be removed is still unreferenced; the next
        // prune retries it and nothing reads it in the meantime.
      }
    }
  }
  return removed;
}
