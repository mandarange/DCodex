/**
 * Deterministic Mermaid serializer (WO §10.4). htmlLabels: false target.
 */
import { byCodePoint } from '../../architecture/contracts.js';
import { hashCanonical } from '../../architecture/fingerprint.js';
import type { MermaidDocument, MermaidEdge, MermaidNode, MermaidStatement, MermaidSubgraph } from './ast.js';
import { GENERATED_HEADER, MERMAID_TEXT_LIMIT, type MermaidProjectionV1 } from './contracts.js';
import { MERMAID_PROJECTION_SCHEMA } from './contracts.js';
import type { ArchitectureMapViewId } from '../../architecture/contracts.js';
import type { ProjectionAccounting } from './contracts.js';

function nodePrimaryCanonical(node: MermaidNode): string {
  return node.canonicalNodeIds[0] ?? node.id;
}

function edgeSortKey(edge: MermaidEdge): string {
  return [edge.fromCanonicalId, edge.relation, edge.toCanonicalId, edge.canonicalEdgeIds[0] ?? ''].join('\0');
}

function sortStatements(statements: readonly MermaidStatement[]): MermaidStatement[] {
  const comments = statements.filter((entry) => entry.kind === 'comment');
  const subgraphs = statements
    .filter((entry): entry is MermaidSubgraph => entry.kind === 'subgraph')
    .sort((left, right) => byCodePoint(left.canonicalId, right.canonicalId));
  const nodes = statements
    .filter((entry): entry is MermaidNode => entry.kind === 'node')
    .sort((left, right) => byCodePoint(nodePrimaryCanonical(left), nodePrimaryCanonical(right)));
  const edges = statements
    .filter((entry): entry is MermaidEdge => entry.kind === 'edge')
    .sort((left, right) => byCodePoint(edgeSortKey(left), edgeSortKey(right)));
  return [...comments, ...subgraphs, ...nodes, ...edges];
}

function renderStatement(statement: MermaidStatement, indent: string): string[] {
  if (statement.kind === 'comment') return [`${indent}%% ${statement.text}`];
  if (statement.kind === 'node') return [`${indent}${statement.id}["${statement.label}"]`];
  if (statement.kind === 'edge') {
    const arrow = statement.style === 'dotted' ? '-.->' : '-->';
    return [`${indent}${statement.from} ${arrow}|"${statement.relation}"| ${statement.to}`];
  }
  const lines = [`${indent}subgraph ${statement.id}["${statement.label}"]`];
  for (const child of sortStatements(statement.statements)) {
    lines.push(...renderStatement(child, `${indent}  `));
  }
  lines.push(`${indent}end`);
  return lines;
}

export function serializeMermaidDocument(doc: MermaidDocument): string {
  const lines = [
    GENERATED_HEADER,
    `%% title: ${doc.title}`,
    `flowchart ${doc.direction}`
  ];
  for (const statement of sortStatements(doc.statements)) {
    lines.push(...renderStatement(statement, ''));
  }
  const text = `${lines.join('\n')}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MERMAID_TEXT_LIMIT) {
    throw new Error(`mermaid_budget_overrun: ${bytes}>${MERMAID_TEXT_LIMIT}`);
  }
  return text;
}

export function emptyAccounting(): ProjectionAccounting {
  return Object.freeze({
    selectedNodeIds: Object.freeze([]),
    emittedNodeIds: Object.freeze([]),
    aggregatedNodeMembers: Object.freeze({}),
    omittedNodes: Object.freeze([]),
    selectedEdgeIds: Object.freeze([]),
    emittedEdgeIds: Object.freeze([]),
    aggregatedEdgeMembers: Object.freeze({}),
    omittedEdges: Object.freeze([])
  });
}

export function toMermaidProjection(input: {
  viewId: ArchitectureMapViewId;
  doc: MermaidDocument;
  accounting: ProjectionAccounting;
}): MermaidProjectionV1 & { readonly text: string } {
  const text = serializeMermaidDocument(input.doc);
  return Object.freeze({
    schema: MERMAID_PROJECTION_SCHEMA,
    viewId: input.viewId,
    direction: input.doc.direction,
    title: input.doc.title,
    source: text,
    accounting: input.accounting,
    contentHash: hashCanonical(text),
    byteLength: Buffer.byteLength(text, 'utf8'),
    text
  });
}
