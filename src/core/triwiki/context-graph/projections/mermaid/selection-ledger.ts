/**
 * Projection selection ledger — selected = emitted ∪ aggregated ∪ omitted.
 */
import { byCodePoint } from '../../architecture/contracts.js';
import type { ProjectionAccounting, ProjectionOmission, ProjectionOmissionReason } from './contracts.js';

export class SelectionLedger {
  private readonly selectedNodes = new Set<string>();
  private readonly emittedNodes = new Set<string>();
  private readonly omittedNodes: ProjectionOmission[] = [];
  private readonly aggregatedNodes = new Map<string, string[]>();
  private readonly selectedEdges = new Set<string>();
  private readonly emittedEdges = new Set<string>();
  private readonly omittedEdges: ProjectionOmission[] = [];
  private readonly aggregatedEdges = new Map<string, string[]>();

  selectNode(id: string): void {
    this.selectedNodes.add(id);
  }

  emitNode(id: string): void {
    this.selectedNodes.add(id);
    this.emittedNodes.add(id);
  }

  omitNode(id: string, reason: ProjectionOmissionReason, detail?: string): void {
    this.selectedNodes.add(id);
    const omission: ProjectionOmission =
      detail === undefined
        ? { id, reason }
        : { id, reason, detail };
    this.omittedNodes.push(Object.freeze(omission));
  }

  aggregateNodes(aggregateId: string, memberIds: readonly string[]): void {
    this.selectedNodes.add(aggregateId);
    for (const id of memberIds) this.selectedNodes.add(id);
    this.emittedNodes.add(aggregateId);
    this.aggregatedNodes.set(aggregateId, [...memberIds].sort(byCodePoint));
  }

  selectEdge(id: string): void {
    this.selectedEdges.add(id);
  }

  emitEdge(id: string): void {
    this.selectedEdges.add(id);
    this.emittedEdges.add(id);
  }

  omitEdge(id: string, reason: ProjectionOmissionReason, detail?: string): void {
    this.selectedEdges.add(id);
    const omission: ProjectionOmission =
      detail === undefined
        ? { id, reason }
        : { id, reason, detail };
    this.omittedEdges.push(Object.freeze(omission));
  }

  aggregateEdges(aggregateId: string, memberIds: readonly string[]): void {
    this.selectedEdges.add(aggregateId);
    for (const id of memberIds) this.selectedEdges.add(id);
    this.emittedEdges.add(aggregateId);
    this.aggregatedEdges.set(aggregateId, [...memberIds].sort(byCodePoint));
  }

  toAccounting(): ProjectionAccounting {
    return Object.freeze({
      selectedNodeIds: Object.freeze([...this.selectedNodes].sort(byCodePoint)),
      emittedNodeIds: Object.freeze([...this.emittedNodes].sort(byCodePoint)),
      aggregatedNodeMembers: Object.freeze(
        Object.fromEntries(
          [...this.aggregatedNodes.entries()]
            .sort(([left], [right]) => byCodePoint(left, right))
            .map(([key, value]) => [key, Object.freeze(value)])
        )
      ),
      omittedNodes: Object.freeze(
        [...this.omittedNodes].sort((left, right) => byCodePoint(left.id, right.id))
      ),
      selectedEdgeIds: Object.freeze([...this.selectedEdges].sort(byCodePoint)),
      emittedEdgeIds: Object.freeze([...this.emittedEdges].sort(byCodePoint)),
      aggregatedEdgeMembers: Object.freeze(
        Object.fromEntries(
          [...this.aggregatedEdges.entries()]
            .sort(([left], [right]) => byCodePoint(left, right))
            .map(([key, value]) => [key, Object.freeze(value)])
        )
      ),
      omittedEdges: Object.freeze(
        [...this.omittedEdges].sort((left, right) => byCodePoint(left.id, right.id))
      )
    });
  }

  assertBalanced(): void {
    const accounting = this.toAccounting();
    const nodeCovered = new Set<string>([
      ...accounting.emittedNodeIds,
      ...Object.values(accounting.aggregatedNodeMembers).flat(),
      ...accounting.omittedNodes.map((entry) => entry.id)
    ]);
    for (const id of accounting.selectedNodeIds) {
      if (!nodeCovered.has(id) && !accounting.emittedNodeIds.includes(id)) {
        // emitted aggregate ids are in emitted; members are in aggregated members
        if (!Object.prototype.hasOwnProperty.call(accounting.aggregatedNodeMembers, id)) {
          throw new Error(`projection_node_unaccounted: ${id}`);
        }
      }
    }
    const edgeCovered = new Set<string>([
      ...accounting.emittedEdgeIds,
      ...Object.values(accounting.aggregatedEdgeMembers).flat(),
      ...accounting.omittedEdges.map((entry) => entry.id)
    ]);
    for (const id of accounting.selectedEdgeIds) {
      if (!edgeCovered.has(id) && !Object.prototype.hasOwnProperty.call(accounting.aggregatedEdgeMembers, id)) {
        throw new Error(`projection_edge_unaccounted: ${id}`);
      }
    }
  }
}
