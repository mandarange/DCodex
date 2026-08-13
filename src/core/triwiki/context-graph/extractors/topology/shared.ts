/**
 * Shared accumulation state for the topology extractor.
 *
 * Nodes and edges are collected in maps keyed by their contract id so a relation
 * observed twice merges instead of duplicating, and every write goes through one
 * place that enforces the node/edge budgets and the provenance requirement.
 */
import fs from 'node:fs';
import type {
  ContextGraphEdge,
  ContextGraphEdgeConfidence,
  ContextGraphEdgeType,
  ContextGraphExtractionLimits,
  ContextGraphLintIssue,
  ContextGraphMetadata,
  ContextGraphNode,
  ContextGraphNodeKind,
  ContextGraphRisk,
  ContextGraphSkip,
  ContextGraphSkipReason
} from '../../contracts.js';
import { sha256 } from '../../../../fsx.js';
import { lintError } from '../../contracts.js';
import { contextGraphEdgeId, contextGraphNodeId } from '../../ids.js';
import { ContextGraphPathError, isWorkspaceRelativePosixPath, resolveInsideWorkspace } from '../../paths.js';
import type { FileInventory } from './globs.js';

export const TOPOLOGY_EXTRACTOR_ID = 'topology';
export const TOPOLOGY_EXTRACTOR_REVISION = '1.1.0';

/**
 * Bounds that keep one over-wide manifest entry from flooding the snapshot.
 *
 * `TOPOLOGY_GLOB_MATCH_CAP` is a representation-granularity bound, not a
 * completeness bound: a cache-input/check glob matching more files than this is
 * kept whole as raw `cacheInputs`/`checkScripts` metadata on the gate node —
 * all-or-nothing, never a partial edge set — and reported as a non-fatal
 * `excluded` skip. Measured basis (this repo, 2026-08-13, 162-gate manifest,
 * 3411-file inventory): 238 distinct cache-input patterns, 224 expand to <= 48
 * files; the 14 wider ones are directory globs (`src/**` = 2368 matches) whose
 * per-file edges are ranking noise by design.
 *
 * The per-gate caps bound the total edges one gate may emit. Unlike the glob
 * cap they would cut mid-expansion, so reaching one is real truncation: it
 * records a fatal `cap_reached` skip (Align fails closed) instead of silently
 * dropping edges. Sized from the same measurement with headroom: affected_by
 * max = 74 inventory files on one gate (`migration:upgrade-safety`) -> 256
 * (3.4x); verified_by max = 40 (`test:commands-regression`) -> 96 (2.4x).
 */
export const TOPOLOGY_GLOB_MATCH_CAP = 48;
export const TOPOLOGY_GATE_AFFECTED_CAP = 256;
export const TOPOLOGY_GATE_VERIFIED_CAP = 96;

export interface TopologyContext {
  readonly root: string;
  readonly observedAt: string;
  readonly limits: ContextGraphExtractionLimits;
  /** wall-clock budget; phases stop rather than overrun a compile */
  readonly deadline: number;
  readonly files: FileInventory;
  /**
   * Code source inventory membership (`walkCodeInventory(root).files[].rel`).
   * `file` nodes may only reference members: Align's exact-file-coverage
   * invariant equates snapshot file nodes with this set, so a file node for any
   * other path (a manifest cache input such as `package.json`, `AGENTS.md`, or
   * `.codex/config.toml`) poisons every subsequent Align run.
   */
  readonly sourcePaths: ReadonlySet<string>;
  readonly nodes: Map<string, ContextGraphNode>;
  readonly edges: Map<string, ContextGraphEdge>;
  readonly issues: ContextGraphLintIssue[];
  readonly skipped: ContextGraphSkip[];
  readonly inputHashes: Record<string, string>;
  /** workspace path -> installed/checkout classification declared by a manifest */
  readonly fileClassification: Map<string, string>;
  readonly skipKeys: Set<string>;
}

export interface TopologyFileRead {
  readonly text: string;
  readonly hash: string;
}

export function createTopologyContext(params: {
  root: string;
  observedAt: string;
  limits: ContextGraphExtractionLimits;
  files: FileInventory;
  sourcePaths: ReadonlySet<string>;
  startedAt: number;
}): TopologyContext {
  const timeout = Number.isFinite(params.limits.timeoutMs) && params.limits.timeoutMs > 0 ? params.limits.timeoutMs : 0;
  return {
    root: params.root,
    observedAt: params.observedAt,
    limits: params.limits,
    deadline: params.startedAt + timeout,
    files: params.files,
    sourcePaths: params.sourcePaths,
    nodes: new Map(),
    edges: new Map(),
    issues: [],
    skipped: [],
    inputHashes: {},
    fileClassification: new Map(),
    skipKeys: new Set()
  };
}

export function topologyExpired(ctx: TopologyContext): boolean {
  return Date.now() > ctx.deadline;
}

/** Rough context cost of a node; the code extractor replaces it for file nodes. */
export function estimateTokenCost(parts: readonly string[]): number {
  let total = 0;
  for (const part of parts) total += part.length;
  return Math.max(1, Math.ceil(total / 4));
}

export function recordSkip(
  ctx: TopologyContext,
  skipPath: string,
  reason: ContextGraphSkipReason,
  detail?: string
): void {
  const key = `${skipPath}${reason}${detail ?? ''}`;
  if (ctx.skipKeys.has(key)) return;
  ctx.skipKeys.add(key);
  ctx.skipped.push({ path: skipPath, reason, ...(detail === undefined ? {} : { detail }) });
}

export function topologyLintError(
  ctx: TopologyContext,
  code: Parameters<typeof lintError>[0],
  message: string,
  extra: { nodeId?: string; edgeId?: string; path?: string } = {}
): void {
  ctx.issues.push(lintError(code, message, { ...extra, extractor: TOPOLOGY_EXTRACTOR_ID }));
}

export interface TopologyNodeInput {
  readonly id: string;
  readonly kind: ContextGraphNodeKind;
  readonly label: string;
  readonly path?: string | undefined;
  readonly line?: number | undefined;
  readonly contentHash?: string | undefined;
  readonly trust: number;
  readonly risk: ContextGraphRisk;
  readonly tokenCost: number;
  readonly metadata: ContextGraphMetadata;
  /** manifest path blamed when the node budget rejects this node */
  readonly sourcePath: string;
}

export function addNode(ctx: TopologyContext, input: TopologyNodeInput): boolean {
  const existing = ctx.nodes.get(input.id);
  if (existing) {
    if (existing.kind !== input.kind) {
      topologyLintError(
        ctx,
        'duplicate_node_conflict',
        `node ${input.id} is claimed as both ${existing.kind} and ${input.kind}`,
        { nodeId: input.id, path: input.sourcePath }
      );
      return false;
    }
    return true;
  }
  if (ctx.nodes.size >= ctx.limits.maxNodes) {
    recordSkip(ctx, input.sourcePath, 'cap_reached', 'node budget reached');
    return false;
  }
  if (input.path !== undefined && !isWorkspaceRelativePosixPath(input.path)) {
    topologyLintError(ctx, 'absolute_or_escaping_path', `node ${input.id} carries a non workspace-relative path`, {
      nodeId: input.id,
      path: input.sourcePath
    });
    return false;
  }
  ctx.nodes.set(input.id, {
    id: input.id,
    kind: input.kind,
    label: input.label,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.line === undefined ? {} : { locator: { line: input.line } }),
    ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
    trust: input.trust,
    freshness: 'fresh',
    risk: input.risk,
    tokenCost: input.tokenCost,
    metadata: input.metadata
  });
  return true;
}

export interface TopologyEdgeInput {
  readonly from: string;
  readonly to: string;
  readonly type: ContextGraphEdgeType;
  readonly confidence: ContextGraphEdgeConfidence;
  /** workspace-relative path of the manifest that evidences the relation */
  readonly path: string;
  readonly hash: string;
  readonly line?: number | undefined;
}

export function addEdge(ctx: TopologyContext, input: TopologyEdgeInput): boolean {
  if (!ctx.nodes.has(input.from) || !ctx.nodes.has(input.to)) {
    topologyLintError(
      ctx,
      'dangling_edge',
      `${input.type} edge ${input.from} -> ${input.to} has an unresolved endpoint`,
      { path: input.path }
    );
    return false;
  }
  if (!input.path || !input.hash || !isWorkspaceRelativePosixPath(input.path)) {
    topologyLintError(ctx, 'edge_without_provenance', `${input.type} edge ${input.from} -> ${input.to} has no usable provenance`);
    return false;
  }
  const id = contextGraphEdgeId({ from: input.from, to: input.to, type: input.type });
  if (ctx.edges.has(id)) return true;
  if (ctx.edges.size >= ctx.limits.maxEdges) {
    recordSkip(ctx, input.path, 'cap_reached', 'edge budget reached');
    return false;
  }
  ctx.edges.set(id, {
    id,
    from: input.from,
    to: input.to,
    type: input.type,
    confidence: input.confidence,
    provenance: {
      path: input.path,
      ...(input.line === undefined ? {} : { line: input.line }),
      hash: input.hash,
      extractor: TOPOLOGY_EXTRACTOR_ID
    },
    observedAt: ctx.observedAt
  });
  return true;
}

/**
 * File nodes stay deliberately thin: the code extractor emits the same ids with
 * real symbol/hash detail, and the compiler merges the two by id.
 *
 * Membership in the code source inventory is a hard precondition: a manifest may
 * cite any workspace path (cache inputs such as `package.json` or `AGENTS.md`),
 * but only inventory members exist as `file` nodes. Everything else stays
 * represented where the manifest put it — e.g. the gate node's `cacheInputs`
 * metadata — so no relation is invented and Align's exact-file-coverage
 * invariant keeps holding by construction.
 */
export function ensureFileNode(ctx: TopologyContext, relativePath: string, role: string, sourcePath: string): string | null {
  if (!isWorkspaceRelativePosixPath(relativePath)) return null;
  if (!ctx.sourcePaths.has(relativePath)) return null;
  const id = contextGraphNodeId({ kind: 'file', path: relativePath });
  const classification = ctx.fileClassification.get(relativePath);
  const metadata: ContextGraphMetadata = {
    source: TOPOLOGY_EXTRACTOR_ID,
    role,
    ...(classification === undefined ? {} : { runtimeClassification: classification })
  };
  const added = addNode(ctx, {
    id,
    kind: 'file',
    label: relativePath.slice(relativePath.lastIndexOf('/') + 1) || relativePath,
    path: relativePath,
    trust: 0.9,
    risk: 'low',
    tokenCost: estimateTokenCost([relativePath]),
    metadata,
    sourcePath
  });
  return added ? id : null;
}

/**
 * Read a workspace file for manifest parsing. A file that exists but cannot be
 * used is always reported: an unusable manifest must never look like an absent
 * one, because that is how a topology silently disappears from the graph.
 */
export function readWorkspaceText(ctx: TopologyContext, relativePath: string): TopologyFileRead | null {
  let absolute: string | null = null;
  try {
    absolute = resolveInsideWorkspace(ctx.root, relativePath);
  } catch (error) {
    if (error instanceof ContextGraphPathError) {
      recordSkip(ctx, relativePath, 'symlink_escape', 'manifest resolves outside the workspace');
      topologyLintError(ctx, 'symlink_escape', `${relativePath} resolves outside the workspace`, { path: relativePath });
      return null;
    }
    throw error;
  }
  if (!absolute) {
    recordSkip(ctx, relativePath, 'excluded', 'not present in this workspace');
    return null;
  }
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) {
      recordSkip(ctx, relativePath, 'unreadable', 'not a regular file');
      topologyLintError(ctx, 'invalid_node_field', `${relativePath} is not a regular file`, { path: relativePath });
      return null;
    }
    if (stat.size > ctx.limits.maxFileBytes) {
      recordSkip(ctx, relativePath, 'oversized', 'manifest exceeds the extraction byte limit');
      topologyLintError(ctx, 'invalid_node_field', `${relativePath} exceeds the extraction byte limit`, { path: relativePath });
      return null;
    }
    const buffer = fs.readFileSync(absolute);
    const hash = sha256(buffer);
    ctx.inputHashes[relativePath] = hash;
    return { text: buffer.toString('utf8'), hash };
  } catch {
    recordSkip(ctx, relativePath, 'unreadable', 'manifest could not be read');
    topologyLintError(ctx, 'invalid_node_field', `${relativePath} could not be read`, { path: relativePath });
    return null;
  }
}

/** First line (1-based) on which each captured identifier appears. */
export function mapIdentifierLines(text: string, pattern: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const match = pattern.exec(line);
    const captured = match?.[1];
    if (!captured || out.has(captured)) continue;
    out.set(captured, index + 1);
  }
  return out;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function readStringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

export function readStringArrayField(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) if (typeof entry === 'string' && entry) out.push(entry);
  return out;
}

export function readNumberField(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Canonical id guard: the graph id for a manifest entity must reproduce the
 * manifest's own id verbatim, otherwise the graph has quietly renamed it.
 */
export function isCanonicalId(prefix: string, rawId: string, generatedId: string): boolean {
  return generatedId === `${prefix}:${rawId}`;
}
