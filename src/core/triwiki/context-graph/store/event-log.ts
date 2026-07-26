/**
 * Bounded append-only compile log.
 *
 * Rows are built field by field from a closed vocabulary of hashes, counts and
 * codes: no paths beyond workspace-relative ones, no prose, no tool output, no
 * environment values. `appendJsonlBounded` keeps the file from growing without
 * limit, so the log can be left on in normal operation.
 */
import { appendJsonlBounded } from '../../../fsx.js';
import { contextGraphEventLogPath } from '../paths.js';

export const CONTEXT_GRAPH_EVENT_SCHEMA = 'sks.context-graph-event.v1' as const;
export const CONTEXT_GRAPH_EVENT_LOG_MAX_BYTES = 2 * 1024 * 1024;

export const CONTEXT_GRAPH_EVENT_TYPES = [
  'compile.started',
  'compile.committed',
  'compile.blocked',
  'compile.lock_contended',
  'compile.unchanged',
  'snapshot.corrupt',
  'snapshot.missing'
] as const;

export type ContextGraphEventType = (typeof CONTEXT_GRAPH_EVENT_TYPES)[number];

export interface ContextGraphEventInput {
  type: ContextGraphEventType;
  at: string;
  cacheKey?: string | undefined;
  snapshotHash?: string | undefined;
  previousSnapshotHash?: string | null | undefined;
  nodeCount?: number | undefined;
  edgeCount?: number | undefined;
  errorCount?: number | undefined;
  warningCount?: number | undefined;
  durationMs?: number | undefined;
  /** Machine code only (a lint code, a stale reason, `lock_held`); never free text. */
  reason?: string | undefined;
  incremental?: boolean | undefined;
}

export interface ContextGraphEvent {
  schema: typeof CONTEXT_GRAPH_EVENT_SCHEMA;
  ts: string;
  type: ContextGraphEventType;
  cache_key?: string;
  snapshot_hash?: string;
  previous_snapshot_hash?: string | null;
  node_count?: number;
  edge_count?: number;
  error_count?: number;
  warning_count?: number;
  duration_ms?: number;
  reason?: string;
  incremental?: boolean;
}

function code(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().slice(0, 64);
  return /^[A-Za-z0-9_.:-]+$/.test(trimmed) ? trimmed : 'unspecified';
}

export function buildContextGraphEvent(input: ContextGraphEventInput): ContextGraphEvent {
  const reason = code(input.reason);
  return {
    schema: CONTEXT_GRAPH_EVENT_SCHEMA,
    ts: input.at,
    type: input.type,
    ...(input.cacheKey === undefined ? {} : { cache_key: input.cacheKey }),
    ...(input.snapshotHash === undefined ? {} : { snapshot_hash: input.snapshotHash }),
    ...(input.previousSnapshotHash === undefined
      ? {}
      : { previous_snapshot_hash: input.previousSnapshotHash }),
    ...(input.nodeCount === undefined ? {} : { node_count: input.nodeCount }),
    ...(input.edgeCount === undefined ? {} : { edge_count: input.edgeCount }),
    ...(input.errorCount === undefined ? {} : { error_count: input.errorCount }),
    ...(input.warningCount === undefined ? {} : { warning_count: input.warningCount }),
    ...(input.durationMs === undefined ? {} : { duration_ms: input.durationMs }),
    ...(reason === undefined ? {} : { reason }),
    ...(input.incremental === undefined ? {} : { incremental: input.incremental })
  };
}

/** Best-effort: a log write must never fail a compile that already committed. */
export async function appendContextGraphEvent(root: string, input: ContextGraphEventInput): Promise<boolean> {
  try {
    await appendJsonlBounded(
      contextGraphEventLogPath(root),
      buildContextGraphEvent(input),
      CONTEXT_GRAPH_EVENT_LOG_MAX_BYTES
    );
    return true;
  } catch {
    return false;
  }
}
