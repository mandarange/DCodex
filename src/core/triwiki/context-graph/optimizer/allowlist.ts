/**
 * The editable surface of the tuning loop, stated once.
 *
 * Two lists exist here and they are not symmetric. `CONTEXT_GRAPH_TUNABLE_FILES`
 * is what a candidate may propose changing. `CONTEXT_GRAPH_MEASUREMENT_*` is the
 * benchmark itself — corpus, fixtures, metrics, floors, scorer — and naming any
 * of it is not a rejection but an integrity violation, because a loop that can
 * move the bar it is measured against is not measuring anything.
 *
 * Classification is fail-closed: an unrecognised, absolute, or escaping path is
 * `forbidden`, never `tunable`.
 */
import { isWorkspaceRelativePosixPath } from '../paths.js';
import { CONTEXT_GRAPH_TUNING_TARGETS, type ContextGraphPatchTargetClass, type ContextGraphTuningTarget } from './types.js';

/** Workspace-relative POSIX source path for each tuning target. */
export const CONTEXT_GRAPH_TUNING_TARGET_FILES: Readonly<Record<ContextGraphTuningTarget, string>> = {
  'ranking-config': 'src/core/triwiki/context-graph/query/ranking-config.ts',
  profiles: 'src/core/triwiki/context-graph/profiles.ts'
};

export const CONTEXT_GRAPH_TUNABLE_FILES: readonly string[] = CONTEXT_GRAPH_TUNING_TARGETS.map(
  (target) => CONTEXT_GRAPH_TUNING_TARGET_FILES[target]
).sort();

/** Files that define what "better" means. Touching one voids the measurement. */
export const CONTEXT_GRAPH_MEASUREMENT_FILES: readonly string[] = ['config/context-graph-benchmark.json'];

/**
 * Directory prefixes owned by the measurement. The compiled mirror is listed as
 * well: swapping the built scorer is the same violation as swapping the source.
 */
export const CONTEXT_GRAPH_MEASUREMENT_PREFIXES: readonly string[] = [
  'src/core/triwiki/context-graph/benchmark/',
  'dist/core/triwiki/context-graph/benchmark/'
];

const TUNABLE_SET: ReadonlySet<string> = new Set(CONTEXT_GRAPH_TUNABLE_FILES);
const MEASUREMENT_SET: ReadonlySet<string> = new Set(CONTEXT_GRAPH_MEASUREMENT_FILES);

/** Strips a leading `./` and trailing slashes; does not resolve, so nothing escapes by normalization. */
export function normalizeCandidatePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!trimmed) return null;
  if (!isWorkspaceRelativePosixPath(trimmed)) return null;
  return trimmed;
}

/**
 * Classify a path a candidate names. Measurement wins over tunable so a path that
 * somehow satisfied both would still be reported as the more severe class.
 */
export function classifyContextGraphPatchTarget(value: unknown): ContextGraphPatchTargetClass {
  const normalized = normalizeCandidatePath(value);
  if (normalized === null) return 'forbidden';
  if (MEASUREMENT_SET.has(normalized)) return 'measurement';
  for (const prefix of CONTEXT_GRAPH_MEASUREMENT_PREFIXES) {
    if (normalized.startsWith(prefix)) return 'measurement';
  }
  if (TUNABLE_SET.has(normalized)) return 'tunable';
  return 'forbidden';
}

/** Target name for an allowlisted file path, or `null` when the path is not tunable. */
export function contextGraphTuningTargetForFile(value: unknown): ContextGraphTuningTarget | null {
  const normalized = normalizeCandidatePath(value);
  if (normalized === null) return null;
  for (const target of CONTEXT_GRAPH_TUNING_TARGETS) {
    if (CONTEXT_GRAPH_TUNING_TARGET_FILES[target] === normalized) return target;
  }
  return null;
}

export function contextGraphTuningTargetFile(target: ContextGraphTuningTarget): string {
  return CONTEXT_GRAPH_TUNING_TARGET_FILES[target];
}

/** Every path the loop fingerprints for drift: the tunable surface plus the measurement. */
export function contextGraphGuardedFiles(): readonly string[] {
  return [...CONTEXT_GRAPH_TUNABLE_FILES, ...CONTEXT_GRAPH_MEASUREMENT_FILES].sort();
}
