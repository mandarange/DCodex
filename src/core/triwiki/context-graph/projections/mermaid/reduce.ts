/**
 * Budget-aware graph reduction for Mermaid views.
 */
import { byCodePoint, type ArchitectureProfileBudget } from '../../architecture/contracts.js';
import type { ContextGraphEdge, ContextGraphNode } from '../../contracts.js';
import { SelectionLedger } from './selection-ledger.js';

export interface ReducedGraph {
  readonly nodes: readonly ContextGraphNode[];
  readonly edges: readonly ContextGraphEdge[];
  readonly ledger: SelectionLedger;
}

export function reduceForBudget(input: {
  nodes: readonly ContextGraphNode[];
  edges: readonly ContextGraphEdge[];
  budget: ArchitectureProfileBudget;
  protectedNodeIds?: ReadonlySet<string>;
}): ReducedGraph {
  const ledger = new SelectionLedger();
  const protectedIds = input.protectedNodeIds ?? new Set<string>();
  const sortedNodes = [...input.nodes].sort((left, right) => byCodePoint(left.id, right.id));
  for (const node of sortedNodes) ledger.selectNode(node.id);

  const admitted: ContextGraphNode[] = [];
  for (const node of sortedNodes) {
    if (protectedIds.has(node.id)) {
      admitted.push(node);
      ledger.emitNode(node.id);
      continue;
    }
    if (admitted.length >= input.budget.maxNodes) {
      ledger.omitNode(node.id, 'budget_exhausted_after_protected_set');
      continue;
    }
    admitted.push(node);
    ledger.emitNode(node.id);
  }
  const admittedIds = new Set(admitted.map((node) => node.id));
  const sortedEdges = [...input.edges].sort((left, right) => byCodePoint(left.id, right.id));
  const admittedEdges: ContextGraphEdge[] = [];
  for (const edge of sortedEdges) {
    ledger.selectEdge(edge.id);
    if (!admittedIds.has(edge.from) || !admittedIds.has(edge.to)) {
      ledger.omitEdge(edge.id, 'outside_profile_scope', 'endpoint omitted');
      continue;
    }
    if (admittedEdges.length >= input.budget.maxEdges) {
      ledger.omitEdge(edge.id, 'budget_exhausted_after_protected_set');
      continue;
    }
    admittedEdges.push(edge);
    ledger.emitEdge(edge.id);
  }
  return {
    nodes: Object.freeze(admitted),
    edges: Object.freeze(admittedEdges),
    ledger
  };
}
