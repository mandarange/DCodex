/**
 * Write-scope conflict detection for the candidate adapter.
 *
 * This deliberately calls the production advisory path
 * (`narutoContextGraphAdviceFromIndex`) rather than re-deriving conflicts from
 * the snapshot. Measuring a benchmark-only reimplementation would tell us
 * nothing about whether Naruto is actually protected from two slices writing the
 * same file — the whole point of the conflict floor.
 *
 * The slice plan is fixture input, so the harness reads it the way a parent
 * would read a candidate wave plan.
 */
import fs from 'node:fs';
import path from 'node:path';
import { narutoContextGraphAdviceFromIndex } from '../../../../naruto/context-graph-advisor.js';
import type { ContextGraphIndex } from '../../graph-index.js';
import type { ContextGraphBenchmarkConflict } from '../types.js';

export const SLICE_PLAN_REL = '.sneakoscope/naruto/slice-plan.json';

interface SlicePlanRow {
  readonly id: string;
  readonly writeScope: readonly string[];
}

function readSlicePlan(root: string): SlicePlanRow[] {
  const file = path.join(root, SLICE_PLAN_REL);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const slices = (parsed as { slices?: unknown } | null)?.slices;
  if (!Array.isArray(slices)) return [];
  const out: SlicePlanRow[] = [];
  for (const raw of slices) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { id?: unknown; writeScope?: unknown; write_scope?: unknown };
    const id = typeof row.id === 'string' ? row.id : '';
    const scopeRaw = Array.isArray(row.writeScope) ? row.writeScope : Array.isArray(row.write_scope) ? row.write_scope : [];
    const writeScope = scopeRaw.filter((value): value is string => typeof value === 'string');
    if (!id || !writeScope.length) continue;
    out.push({ id, writeScope });
  }
  return out.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * Conflicts the Naruto advisory would report for this workspace's declared
 * slices. Returns an empty list when the workspace declares no plan, which is
 * the honest answer rather than an invented one.
 */
export function detectWriteScopeConflicts(
  root: string,
  index: ContextGraphIndex,
  task: string
): ContextGraphBenchmarkConflict[] {
  const slices = readSlicePlan(root);
  if (slices.length < 2) return [];
  const advice = narutoContextGraphAdviceFromIndex(index, {
    root,
    task,
    slices: slices.map((slice) => ({ id: slice.id, writePaths: [...slice.writeScope] })),
    graphStatus: 'fresh'
  });
  const byPath = new Map<string, Set<string>>();
  for (const pair of advice.pairs) {
    if (pair.parallel_safe) continue;
    for (const shared of pair.shared_paths) {
      const bucket = byPath.get(shared) ?? new Set<string>();
      bucket.add(pair.left_slice_id);
      bucket.add(pair.right_slice_id);
      byPath.set(shared, bucket);
    }
  }
  return [...byPath.entries()]
    .map(([conflictPath, slicesForPath]) => ({ path: conflictPath, slices: [...slicesForPath].sort() }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
