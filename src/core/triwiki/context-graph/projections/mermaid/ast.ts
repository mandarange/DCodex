/**
 * Validated Mermaid flowchart AST factories (WO §10.2).
 */
import { byCodePoint } from '../../architecture/contracts.js';
import type { MermaidDirection, MermaidSafeId } from './contracts.js';
import { asRelationLabel, mermaidLabel } from './escape.js';

export interface MermaidComment {
  readonly kind: 'comment';
  readonly text: string;
}

export interface MermaidNode {
  readonly kind: 'node';
  readonly id: MermaidSafeId;
  readonly label: string;
  readonly canonicalNodeIds: readonly string[];
}

export interface MermaidEdge {
  readonly kind: 'edge';
  readonly from: MermaidSafeId;
  readonly to: MermaidSafeId;
  readonly relation: string;
  readonly style: 'solid' | 'dotted';
  readonly canonicalEdgeIds: readonly string[];
  readonly fromCanonicalId: string;
  readonly toCanonicalId: string;
}

export interface MermaidSubgraph {
  readonly kind: 'subgraph';
  readonly id: MermaidSafeId;
  readonly label: string;
  readonly canonicalId: string;
  readonly statements: readonly (MermaidNode | MermaidEdge | MermaidComment)[];
}

export type MermaidStatement = MermaidComment | MermaidSubgraph | MermaidNode | MermaidEdge;

export interface MermaidDocument {
  readonly kind: 'flowchart';
  readonly direction: MermaidDirection;
  readonly title: string;
  readonly statements: readonly MermaidStatement[];
}

function freezeIds(ids: readonly string[]): readonly string[] {
  return Object.freeze([...ids].sort(byCodePoint));
}

export function comment(text: string): MermaidComment {
  return Object.freeze({ kind: 'comment', text: mermaidLabel(text, 200) });
}

export function node(input: {
  id: MermaidSafeId;
  label: string;
  canonicalNodeIds: readonly string[];
}): MermaidNode {
  if (!input.canonicalNodeIds.length) throw new Error('mermaid_node_without_canonical_id');
  return Object.freeze({
    kind: 'node',
    id: input.id,
    label: mermaidLabel(input.label),
    canonicalNodeIds: freezeIds(input.canonicalNodeIds)
  });
}

export function edge(input: {
  from: MermaidSafeId;
  to: MermaidSafeId;
  relation: string;
  style?: 'solid' | 'dotted';
  canonicalEdgeIds: readonly string[];
  fromCanonicalId: string;
  toCanonicalId: string;
}): MermaidEdge {
  if (!input.canonicalEdgeIds.length) throw new Error('mermaid_edge_without_canonical_id');
  return Object.freeze({
    kind: 'edge',
    from: input.from,
    to: input.to,
    relation: asRelationLabel(input.relation),
    style: input.style ?? 'solid',
    canonicalEdgeIds: freezeIds(input.canonicalEdgeIds),
    fromCanonicalId: input.fromCanonicalId,
    toCanonicalId: input.toCanonicalId
  });
}

export function subgraph(input: {
  id: MermaidSafeId;
  label: string;
  canonicalId: string;
  statements: readonly (MermaidNode | MermaidEdge | MermaidComment)[];
}): MermaidSubgraph {
  return Object.freeze({
    kind: 'subgraph',
    id: input.id,
    label: mermaidLabel(input.label),
    canonicalId: input.canonicalId,
    statements: Object.freeze([...input.statements])
  });
}

export function document(input: {
  direction: MermaidDirection;
  title: string;
  statements: readonly MermaidStatement[];
}): MermaidDocument {
  return Object.freeze({
    kind: 'flowchart',
    direction: input.direction,
    title: mermaidLabel(input.title, 120),
    statements: Object.freeze([...input.statements])
  });
}
