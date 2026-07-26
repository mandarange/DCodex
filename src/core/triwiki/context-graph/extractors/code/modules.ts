/**
 * Module boundaries inferred from the real file inventory.
 *
 * A module is a directory, not a guess about intent: the id is the workspace
 * relative directory itself, so `src/core/a` and a top-level `core-a` can never
 * collapse into the same node the way a dash-flattened id would.
 */
import { contextGraphNodeId } from '../../ids.js';
import type { CodeGraphSink } from './builders.js';
import type { CodeSourceFileRecord } from './types.js';

/** Directory depth a module boundary is cut at, per source root convention. */
const SOURCE_ROOTS: ReadonlySet<string> = new Set(['src', 'source', 'lib']);
const SOURCE_ROOT_DEPTH = 3;
const PLAIN_DEPTH = 2;
/** Repository-root files belong to this synthetic module. */
export const ROOT_MODULE_DIR = '.';

export interface ModuleBoundary {
  moduleId: string;
  dir: string;
  nodeId: string;
  files: string[];
}

/** Directory that owns `relativePath`, capped so a deep tree does not become one module per folder. */
export function moduleDirForPath(relativePath: string): string {
  const parts = relativePath.split('/');
  const dirParts = parts.slice(0, -1);
  if (!dirParts.length) return ROOT_MODULE_DIR;
  const head = dirParts[0] ?? '';
  const depth = SOURCE_ROOTS.has(head) ? SOURCE_ROOT_DEPTH : PLAIN_DEPTH;
  return dirParts.slice(0, Math.min(depth, dirParts.length)).join('/');
}

function moduleLabel(dir: string): string {
  if (dir === ROOT_MODULE_DIR) return 'root';
  const parts = dir.split('/');
  const head = parts[0] ?? '';
  const trimmed = SOURCE_ROOTS.has(head) && parts.length > 1 ? parts.slice(1) : parts;
  return trimmed.join('-') || dir;
}

/** One boundary per owning directory, sorted by directory for a stable walk. */
export function inferModuleBoundaries(relativePaths: readonly string[]): ModuleBoundary[] {
  const byDir = new Map<string, string[]>();
  for (const rel of relativePaths) {
    const dir = moduleDirForPath(rel);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(rel);
    else byDir.set(dir, [rel]);
  }
  const boundaries: ModuleBoundary[] = [];
  for (const [dir, files] of byDir) {
    boundaries.push({
      moduleId: dir,
      dir,
      nodeId: contextGraphNodeId({ kind: 'module', moduleId: dir }),
      files: files.sort()
    });
  }
  return boundaries.sort((left, right) => (left.dir < right.dir ? -1 : left.dir > right.dir ? 1 : 0));
}

/** Base cost of holding a module card in context, before its files are pulled in. */
function moduleTokenCost(fileCount: number): number {
  return 8 + fileCount * 2;
}

export function buildModuleNodes(sink: CodeGraphSink, boundaries: readonly ModuleBoundary[]): void {
  for (const boundary of boundaries) {
    const capPath = boundary.files[0] ?? boundary.dir;
    sink.addNode(
      {
        id: boundary.nodeId,
        kind: 'module',
        label: moduleLabel(boundary.dir),
        ...(boundary.dir === ROOT_MODULE_DIR ? {} : { path: boundary.dir }),
        // Boundaries are inferred from directory layout, not declared by the repository.
        trust: 0.8,
        risk: 'low',
        tokenCost: moduleTokenCost(boundary.files.length),
        metadata: { dir: boundary.dir, fileCount: boundary.files.length }
      },
      capPath
    );
  }
}

/**
 * `module contains file` for every scanned file. Provenance points at the file
 * itself, which is the observation that put it in the module.
 */
export function buildModuleContainsEdges(
  sink: CodeGraphSink,
  boundaries: readonly ModuleBoundary[],
  fileNodeIdByRel: ReadonlyMap<string, string>,
  byRel: ReadonlyMap<string, CodeSourceFileRecord>
): void {
  for (const boundary of boundaries) {
    for (const rel of boundary.files) {
      const fileNodeId = fileNodeIdByRel.get(rel);
      const record = byRel.get(rel);
      if (!fileNodeId || !record) continue;
      sink.addEdge({
        from: boundary.nodeId,
        to: fileNodeId,
        type: 'contains',
        confidence: 'exact',
        path: rel,
        hash: record.hash
      });
    }
  }
}
