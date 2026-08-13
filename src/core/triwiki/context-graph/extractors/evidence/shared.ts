/**
 * Shared plumbing for the TriWiki evidence extractor.
 *
 * Nothing here reads unbounded input and nothing here spawns a process: every
 * filesystem touch goes through the Context Graph path guard, is size-capped by
 * the injected extraction limits, and is recorded either as an input hash or as
 * an explicit skip so a missing artifact can never look like an empty success.
 */
import fs from 'node:fs';
import { sha256 } from '../../../../fsx.js';
import {
  emptyContextGraphFragment,
  type ContextGraphEdgeConfidence,
  type ContextGraphEdgeType,
  type ContextGraphExtractionLimits,
  type ContextGraphFragment,
  type ContextGraphLintIssue,
  type ContextGraphNode,
  type ContextGraphRisk,
  type ContextGraphSkip,
  type ContextGraphSkipReason
} from '../../contracts.js';
import { compareContextGraphIds, contextGraphEdgeId, contextGraphNodeId } from '../../ids.js';
import { ContextGraphPathError, resolveInsideWorkspace } from '../../paths.js';
import { safeText } from './redaction.js';

export const EVIDENCE_EXTRACTOR_ID = 'triwiki-evidence';
export const EVIDENCE_EXTRACTOR_REVISION = '1.1.0';

export const CONTEXT_PACK_REL = '.sneakoscope/wiki/context-pack.json';
export const PROOF_BANK_REL = '.sneakoscope/triwiki/proof-bank';
export const PROOF_INDEX_REL = '.sneakoscope/triwiki/proof-bank/index.json';

/** How the proof set was discovered; recorded on every proof node. */
export type ProofDiscoveryMode = 'index' | 'scan' | 'absent';

export interface EvidenceContext {
  readonly root: string;
  readonly observedAt: string;
  /** `null` when `observedAt` is unparseable; expiry then resolves to "unknown", never "fresh". */
  readonly now: Date | null;
  readonly limits: ContextGraphExtractionLimits;
  /**
   * Code source inventory membership (`walkCodeInventory(root).files[].rel`).
   * Cited or pinned paths outside it (`AGENTS.md`, `.codex/config.toml`,
   * `package-lock.json`, …) keep their `source` node — that is where their
   * freshness lives — but never mint a backing `file` node, because Align's
   * exact-file-coverage invariant equates snapshot file nodes with this set.
   */
  readonly sourcePaths: ReadonlySet<string>;
}

export function evidenceContext(input: {
  root: string;
  observedAt: string;
  limits: ContextGraphExtractionLimits;
  sourcePaths: ReadonlySet<string>;
}): EvidenceContext {
  const parsed = Date.parse(input.observedAt);
  return {
    root: input.root,
    observedAt: input.observedAt,
    now: Number.isFinite(parsed) ? new Date(parsed) : null,
    limits: input.limits,
    sourcePaths: input.sourcePaths
  };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function asFiniteNumber(value: unknown): number | null {
  const candidate = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(candidate) ? candidate : null;
}

export function asStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    const single = asString(value);
    return single ? [single] : [];
  }
  const out: string[] = [];
  for (const entry of asArray(value)) {
    const text = asString(entry);
    if (text) out.push(text);
  }
  return out;
}

export function round4(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
}

/** Bounded token estimate; never derived from a value we would not store. */
export function tokenEstimate(charCount: number, cap = 4000): number {
  const safe = Number.isFinite(charCount) && charCount > 0 ? charCount : 0;
  return Math.max(1, Math.min(cap, Math.ceil(safe / 4)));
}

export function graphRiskFromBand(value: unknown): ContextGraphRisk {
  switch (asString(value)?.toLowerCase()) {
    case 'low':
      return 'low';
    case 'high':
    case 'critical':
      return 'high';
    default:
      return 'medium';
  }
}

export function isRemoteCitation(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

export interface WorkspaceFileRead {
  rel: string;
  bytes: Buffer;
  hash: string;
}

export type WorkspaceReadResult =
  | { ok: true; value: WorkspaceFileRead }
  | { ok: false; skip: ContextGraphSkip };

function skip(path: string, reason: ContextGraphSkipReason, detail?: string): ContextGraphSkip {
  return { path, reason, ...(detail === undefined ? {} : { detail }) };
}

/** Stat a workspace-relative entry without following a symlink out of the workspace. */
export function statWorkspaceEntry(root: string, rel: string): fs.Stats | null {
  try {
    const absolute = resolveInsideWorkspace(root, rel);
    if (!absolute) return null;
    return fs.statSync(absolute);
  } catch {
    return null;
  }
}

/** Read a workspace-relative file with a hard byte cap. Never follows an escaping symlink. */
export function readWorkspaceFile(root: string, rel: string, maxBytes: number): WorkspaceReadResult {
  let absolute: string | null;
  try {
    absolute = resolveInsideWorkspace(root, rel);
  } catch (error) {
    const reason: ContextGraphSkipReason =
      error instanceof ContextGraphPathError && error.code === 'symlink_escape' ? 'symlink_escape' : 'unreadable';
    return { ok: false, skip: skip(rel, reason) };
  }
  if (!absolute) return { ok: false, skip: skip(rel, 'unreadable', 'missing') };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return { ok: false, skip: skip(rel, 'unreadable') };
  }
  if (!stat.isFile()) return { ok: false, skip: skip(rel, 'excluded', 'not_a_file') };
  if (stat.size > maxBytes) return { ok: false, skip: skip(rel, 'oversized', `${stat.size}`) };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absolute);
  } catch {
    return { ok: false, skip: skip(rel, 'unreadable') };
  }
  return { ok: true, value: { rel, bytes, hash: sha256(bytes) } };
}

export interface EvidenceNodeDraft {
  id: string;
  kind: ContextGraphNode['kind'];
  label: string;
  path?: string;
  contentHash?: string;
  trust: number;
  freshness: ContextGraphNode['freshness'];
  risk: ContextGraphRisk;
  tokenCost: number;
  metadata: ContextGraphNode['metadata'];
}

export interface EvidenceEdgeDraft {
  from: string;
  to: string;
  type: ContextGraphEdgeType;
  confidence: ContextGraphEdgeConfidence;
  provenancePath: string;
  provenanceHash: string;
  provenanceLine?: number;
}

/**
 * Accumulator that enforces the node/edge caps, keeps identity unique, and makes
 * every emitted edge carry provenance back at a real workspace-relative path.
 */
export class EvidenceFragmentBuilder {
  readonly fragment: ContextGraphFragment;

  private readonly limits: ContextGraphExtractionLimits;
  private readonly observedAt: string;
  private readonly nodeIds = new Set<string>();
  private readonly edgeIds = new Set<string>();
  private readonly capNoted = new Set<string>();

  constructor(limits: ContextGraphExtractionLimits, observedAt: string) {
    this.fragment = emptyContextGraphFragment(EVIDENCE_EXTRACTOR_ID, EVIDENCE_EXTRACTOR_REVISION);
    this.limits = limits;
    this.observedAt = observedAt;
  }

  hasNode(id: string): boolean {
    return this.nodeIds.has(id);
  }

  addNode(draft: EvidenceNodeDraft, origin: string): boolean {
    if (this.nodeIds.has(draft.id)) return true;
    if (this.fragment.nodes.length >= this.limits.maxNodes) {
      this.noteCap(origin, 'node_cap_reached');
      return false;
    }
    this.nodeIds.add(draft.id);
    this.fragment.nodes.push({
      id: draft.id,
      kind: draft.kind,
      label: draft.label || draft.id,
      ...(draft.path === undefined ? {} : { path: draft.path }),
      ...(draft.contentHash === undefined ? {} : { contentHash: draft.contentHash }),
      trust: round4(draft.trust),
      freshness: draft.freshness,
      risk: draft.risk,
      tokenCost: Math.max(0, Math.trunc(draft.tokenCost)),
      metadata: draft.metadata
    });
    return true;
  }

  addEdge(draft: EvidenceEdgeDraft): boolean {
    if (!draft.provenancePath || !draft.provenanceHash) return false;
    const id = contextGraphEdgeId({ from: draft.from, to: draft.to, type: draft.type });
    if (this.edgeIds.has(id)) return true;
    if (this.fragment.edges.length >= this.limits.maxEdges) {
      this.noteCap(draft.provenancePath, 'edge_cap_reached');
      return false;
    }
    this.edgeIds.add(id);
    this.fragment.edges.push({
      id,
      from: draft.from,
      to: draft.to,
      type: draft.type,
      confidence: draft.confidence,
      provenance: {
        path: draft.provenancePath,
        ...(draft.provenanceLine === undefined ? {} : { line: draft.provenanceLine }),
        hash: draft.provenanceHash,
        extractor: EVIDENCE_EXTRACTOR_ID
      },
      observedAt: this.observedAt
    });
    return true;
  }

  addIssue(issue: ContextGraphLintIssue): void {
    this.fragment.issues.push(issue);
  }

  addSkip(entry: ContextGraphSkip): void {
    this.fragment.skipped.push(entry);
  }

  addInputHash(rel: string, hash: string): void {
    this.fragment.inputHashes[rel] = hash;
  }

  noteCap(origin: string, detail: string): void {
    const key = `${origin} ${detail}`;
    if (this.capNoted.has(key)) return;
    this.capNoted.add(key);
    this.addSkip(skip(origin, 'cap_reached', detail));
  }
}

/**
 * Risk domains are registered while claims/proofs are walked and materialized once
 * at the end so each node can carry a truthful member count.
 */
export class RiskDomainRegistry {
  private readonly counts = new Map<string, number>();
  private readonly risks = new Map<string, ContextGraphRisk>();
  private readonly labels = new Map<string, string>();

  note(domain: string, risk: ContextGraphRisk): string | null {
    const label = safeText(domain, 80);
    if (!label) return null;
    const id = contextGraphNodeId({ kind: 'risk_domain', domain: label });
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    this.labels.set(id, label);
    const previous = this.risks.get(id);
    if (!previous || riskRank(risk) > riskRank(previous)) this.risks.set(id, risk);
    return id;
  }

  flush(builder: EvidenceFragmentBuilder, origin: string): void {
    for (const id of [...this.counts.keys()].sort(compareContextGraphIds)) {
      const label = this.labels.get(id) ?? id;
      builder.addNode(
        {
          id,
          kind: 'risk_domain',
          label,
          trust: 0.6,
          freshness: 'unknown',
          risk: this.risks.get(id) ?? 'medium',
          tokenCost: tokenEstimate(label.length, 64),
          metadata: { domain: label, member_count: this.counts.get(id) ?? 0 }
        },
        origin
      );
    }
  }
}

function riskRank(value: ContextGraphRisk): number {
  return value === 'protected' ? 3 : value === 'high' ? 2 : value === 'medium' ? 1 : 0;
}

function compareSkips(left: ContextGraphSkip, right: ContextGraphSkip): number {
  return (
    compareContextGraphIds(left.path, right.path) ||
    compareContextGraphIds(left.reason, right.reason) ||
    compareContextGraphIds(left.detail ?? '', right.detail ?? '')
  );
}

function compareIssues(left: ContextGraphLintIssue, right: ContextGraphLintIssue): number {
  return (
    compareContextGraphIds(left.code, right.code) ||
    compareContextGraphIds(left.nodeId ?? '', right.nodeId ?? '') ||
    compareContextGraphIds(left.edgeId ?? '', right.edgeId ?? '') ||
    compareContextGraphIds(left.path ?? '', right.path ?? '') ||
    compareContextGraphIds(left.message, right.message)
  );
}

/** Drop edges whose endpoints did not survive the guard, then sort everything. */
export function finalizeEvidenceFragment(fragment: ContextGraphFragment): ContextGraphFragment {
  const nodeIds = new Set(fragment.nodes.map((node) => node.id));
  const edges = fragment.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .sort((left, right) => compareContextGraphIds(left.id, right.id));
  const nodes = [...fragment.nodes].sort((left, right) => compareContextGraphIds(left.id, right.id));
  return {
    ...fragment,
    nodes,
    edges,
    issues: [...fragment.issues].sort(compareIssues),
    skipped: [...fragment.skipped].sort(compareSkips)
  };
}
