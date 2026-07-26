/**
 * Node/edge construction, cap accounting and path safety for the code extractor.
 *
 * Every write goes through here so that three invariants hold in one place: no
 * edge without usable provenance, no edge whose endpoints are missing, and no
 * absolute or escaping path anywhere in the fragment.
 */
import type {
  ContextGraphEdge,
  ContextGraphEdgeConfidence,
  ContextGraphEdgeType,
  ContextGraphExtractionLimits,
  ContextGraphLintIssue,
  ContextGraphLocator,
  ContextGraphMetadata,
  ContextGraphNode,
  ContextGraphNodeKind,
  ContextGraphRisk,
  ContextGraphSkip
} from '../../contracts.js';
import { lintError } from '../../contracts.js';
import { compareContextGraphIds, contextGraphEdgeId } from '../../ids.js';
import { isWorkspaceRelativePosixPath } from '../../paths.js';
import { CODE_GRAPH_EXTRACTOR_ID } from './types.js';

export interface CodeNodeInput {
  id: string;
  kind: ContextGraphNodeKind;
  label: string;
  path?: string | undefined;
  contentHash?: string | undefined;
  locator?: ContextGraphLocator | undefined;
  trust: number;
  risk: ContextGraphRisk;
  tokenCost: number;
  metadata: ContextGraphMetadata;
}

export interface CodeEdgeInput {
  from: string;
  to: string;
  type: ContextGraphEdgeType;
  confidence: ContextGraphEdgeConfidence;
  /** workspace-relative POSIX path of the file the relation was observed in */
  path: string;
  /** sha256 of that file's bytes */
  hash: string;
  line?: number | undefined;
}

export interface CodeGraphSinkResult {
  nodes: ContextGraphNode[];
  edges: ContextGraphEdge[];
  issues: ContextGraphLintIssue[];
  skipped: ContextGraphSkip[];
}

export class CodeGraphSink {
  private readonly nodes = new Map<string, ContextGraphNode>();
  private readonly edges = new Map<string, ContextGraphEdge>();
  private readonly skips: ContextGraphSkip[] = [];
  private readonly skipKeys = new Set<string>();
  private readonly issues: ContextGraphLintIssue[] = [];
  private nodeCapReported = false;
  private edgeCapReported = false;

  constructor(
    private readonly limits: ContextGraphExtractionLimits,
    private readonly observedAt: string
  ) {}

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.size;
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  /** `false` when the node cap refused the write; an existing id counts as success. */
  addNode(input: CodeNodeInput, capPath: string): boolean {
    if (this.nodes.has(input.id)) return true;
    if (input.path !== undefined && !isWorkspaceRelativePosixPath(input.path)) {
      this.issues.push(
        lintError('absolute_or_escaping_path', `node ${input.id} carries a non workspace-relative path`, {
          nodeId: input.id,
          extractor: CODE_GRAPH_EXTRACTOR_ID
        })
      );
      return false;
    }
    if (this.nodes.size >= this.limits.maxNodes) {
      if (!this.nodeCapReported) {
        this.nodeCapReported = true;
        this.addSkip({ path: capPath, reason: 'cap_reached', detail: `maxNodes=${this.limits.maxNodes} reached` });
      }
      return false;
    }
    const node: ContextGraphNode = {
      id: input.id,
      kind: input.kind,
      label: input.label,
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.locator === undefined ? {} : { locator: input.locator }),
      ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
      trust: input.trust,
      freshness: 'fresh',
      risk: input.risk,
      tokenCost: input.tokenCost,
      metadata: input.metadata
    };
    this.nodes.set(node.id, node);
    return true;
  }

  /**
   * Add one edge. Endpoints must already exist as nodes and provenance must be a
   * workspace-relative path with a real content hash, otherwise nothing is written.
   */
  addEdge(input: CodeEdgeInput): boolean {
    if (!this.nodes.has(input.from) || !this.nodes.has(input.to)) return false;
    if (!input.path || !isWorkspaceRelativePosixPath(input.path) || !input.hash) {
      this.issues.push(
        lintError('edge_without_provenance', `refused a ${input.type} edge without usable provenance`, {
          extractor: CODE_GRAPH_EXTRACTOR_ID
        })
      );
      return false;
    }
    const id = contextGraphEdgeId({ from: input.from, to: input.to, type: input.type });
    if (this.edges.has(id)) return true;
    if (this.edges.size >= this.limits.maxEdges) {
      if (!this.edgeCapReported) {
        this.edgeCapReported = true;
        this.addSkip({ path: input.path, reason: 'cap_reached', detail: `maxEdges=${this.limits.maxEdges} reached` });
      }
      return false;
    }
    const line = typeof input.line === 'number' && Number.isFinite(input.line) && input.line > 0 ? Math.trunc(input.line) : undefined;
    this.edges.set(id, {
      id,
      from: input.from,
      to: input.to,
      type: input.type,
      confidence: input.confidence,
      provenance: {
        path: input.path,
        ...(line === undefined ? {} : { line }),
        hash: input.hash,
        extractor: CODE_GRAPH_EXTRACTOR_ID
      },
      observedAt: this.observedAt
    });
    return true;
  }

  addSkip(skip: ContextGraphSkip): void {
    if (!isWorkspaceRelativePosixPath(skip.path)) return;
    const key = `${skip.path}\u0000${skip.reason}\u0000${skip.detail ?? ''}`;
    if (this.skipKeys.has(key)) return;
    this.skipKeys.add(key);
    this.skips.push(skip);
  }

  addIssue(issue: ContextGraphLintIssue): void {
    this.issues.push(issue);
  }

  /**
   * A symbol node exists to be the endpoint of a relation. One that is neither
   * exported (so no other file can import it) nor touched by any edge other than
   * its own `contains` carries no information the graph can traverse — on this
   * repository that is 11k of 18k symbols and roughly a quarter of the artifact.
   * Dropping them takes their `contains` edge with them so nothing dangles.
   */
  private pruneUnreachableSymbols(): void {
    const reachable = new Set<string>();
    for (const edge of this.edges.values()) {
      if (edge.type === 'contains') continue;
      reachable.add(edge.from);
      reachable.add(edge.to);
    }
    const dropped = new Set<string>();
    for (const [id, node] of this.nodes) {
      if (node.kind !== 'symbol') continue;
      if (node.metadata.exported === true || reachable.has(id)) continue;
      dropped.add(id);
      this.nodes.delete(id);
    }
    if (!dropped.size) return;
    for (const [id, edge] of this.edges) {
      if (dropped.has(edge.from) || dropped.has(edge.to)) this.edges.delete(id);
    }
  }

  /** Sorted, deduplicated fragment payload. Identical input yields an identical result. */
  result(): CodeGraphSinkResult {
    this.pruneUnreachableSymbols();
    const nodes = [...this.nodes.values()].sort((left, right) => compareContextGraphIds(left.id, right.id));
    const edges = [...this.edges.values()].sort((left, right) => compareContextGraphIds(left.id, right.id));
    const skipped = [...this.skips].sort(
      (left, right) => compareContextGraphIds(left.path, right.path) || compareContextGraphIds(left.reason, right.reason) || compareContextGraphIds(left.detail ?? '', right.detail ?? '')
    );
    const issues = [...this.issues].sort(
      (left, right) => compareContextGraphIds(left.code, right.code) || compareContextGraphIds(left.message, right.message)
    );
    return { nodes, edges, issues, skipped };
  }
}

/** Fan-in derived risk: a widely imported file has a larger blast radius when it changes. */
export function riskFromFanIn(fanIn: number, isTest: boolean): ContextGraphRisk {
  if (isTest) return 'low';
  if (fanIn >= 5) return 'high';
  if (fanIn >= 2) return 'medium';
  return 'low';
}
