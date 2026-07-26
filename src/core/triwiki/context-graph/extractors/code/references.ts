/**
 * Usage edges: `file references symbol`, `file calls symbol`, `test tests ...`.
 *
 * A binding only produces an edge when it is actually used in the file body, and
 * the edge is only `exact` when the export it points at was resolved in the
 * target module or through a re-export chain. A name that merely happens to
 * exist in the target file stays `syntactic`; it is never promoted.
 */
import ts from 'typescript';
import type { ContextGraphEdgeConfidence } from '../../contracts.js';
import type { CodeGraphSink } from './builders.js';
import type { ModuleGraphTables } from './module-graph.js';
import { resolveExportedSymbol } from './module-graph.js';
import type { CodeSourceFileRecord, ImportBinding, ParsedCodeFile } from './types.js';

interface UsageRecord {
  binding: ImportBinding;
  /** export name looked up in the target module; `*` never reaches this stage */
  exportName: string;
  line: number;
  callLine: number | null;
}

export interface ReferenceEdgeInputs {
  tables: ModuleGraphTables;
  parsedByRel: ReadonlyMap<string, ParsedCodeFile>;
  byRel: ReadonlyMap<string, CodeSourceFileRecord>;
  fileNodeIdByRel: ReadonlyMap<string, string>;
  testNodeIdByRel: ReadonlyMap<string, string>;
}

/** `false` for identifiers that are being declared or that name a property. */
function isUsageIdentifier(node: ts.Identifier): boolean {
  const parent: ts.Node | undefined = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isPropertySignature(parent) && parent.name === node) return false;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isMethodSignature(parent) && parent.name === node) return false;
  if (ts.isEnumMember(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isClassDeclaration(parent) && parent.name === node) return false;
  if (ts.isInterfaceDeclaration(parent) && parent.name === node) return false;
  if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return false;
  if (ts.isEnumDeclaration(parent) && parent.name === node) return false;
  if (ts.isModuleDeclaration(parent) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  return true;
}

function isInvoked(node: ts.Node): boolean {
  const parent: ts.Node | undefined = node.parent;
  if (!parent) return false;
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (ts.isNewExpression(parent) && parent.expression === node) return true;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === node) return true;
  return false;
}

function recordUsage(usages: Map<string, UsageRecord>, binding: ImportBinding, exportName: string, line: number, call: boolean): void {
  const key = `${binding.local}|${exportName}`;
  const existing = usages.get(key);
  if (!existing) {
    usages.set(key, { binding, exportName, line, callLine: call ? line : null });
    return;
  }
  if (call && existing.callLine === null) existing.callLine = line;
}

/** Walk the body of one file and collect which imported bindings it actually uses. */
function collectUsages(parsed: ParsedCodeFile, bindings: readonly ImportBinding[]): Map<string, UsageRecord> {
  const usages = new Map<string, UsageRecord>();
  const byLocal = new Map<string, ImportBinding>();
  for (const binding of bindings) if (!byLocal.has(binding.local)) byLocal.set(binding.local, binding);
  if (!byLocal.size) return usages;
  const sourceFile = parsed.sourceFile;

  const handle = (node: ts.Identifier): void => {
    const binding = byLocal.get(node.text);
    if (!binding || !binding.targetRel) return;
    if (!isUsageIdentifier(node)) return;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const parent: ts.Node | undefined = node.parent;
    if (binding.exportName === '*') {
      // Only a member access on the namespace names a concrete export.
      if (!parent || !ts.isPropertyAccessExpression(parent) || parent.expression !== node) return;
      if (!ts.isIdentifier(parent.name)) return;
      recordUsage(usages, binding, parent.name.text, line, isInvoked(parent));
      return;
    }
    recordUsage(usages, binding, binding.exportName, line, isInvoked(node));
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      handle(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return usages;
}

interface ResolvedUsage {
  symbolNodeId: string;
  definingRel: string;
  confidence: ContextGraphEdgeConfidence;
}

function resolveUsage(tables: ModuleGraphTables, usage: UsageRecord): ResolvedUsage | null {
  const targetRel = usage.binding.targetRel;
  if (!targetRel) return null;
  const resolved = resolveExportedSymbol(tables, targetRel, usage.exportName);
  if (resolved) return { symbolNodeId: resolved.symbol.nodeId, definingRel: resolved.rel, confidence: 'exact' };
  // The export was not found; a same-named declaration in the resolved module is
  // suggestive but unproven, so it is recorded at syntactic confidence.
  const declared = tables.declaredByRel.get(targetRel)?.get(usage.exportName);
  if (declared) return { symbolNodeId: declared.nodeId, definingRel: targetRel, confidence: 'syntactic' };
  return null;
}

/** `file references symbol`, `file calls symbol`, and the `tests` edges of test files. */
export function buildReferenceEdges(sink: CodeGraphSink, inputs: ReferenceEdgeInputs): void {
  const rels = [...inputs.parsedByRel.keys()].sort();
  for (const rel of rels) {
    const parsed = inputs.parsedByRel.get(rel);
    const record = inputs.byRel.get(rel);
    const from = inputs.fileNodeIdByRel.get(rel);
    const facts = inputs.tables.factsByRel.get(rel);
    if (!parsed || !record || !from || !facts) continue;
    const testNodeId = inputs.testNodeIdByRel.get(rel);

    for (const usage of collectUsages(parsed, facts.bindings).values()) {
      const resolved = resolveUsage(inputs.tables, usage);
      if (!resolved) continue;
      sink.addEdge({
        from,
        to: resolved.symbolNodeId,
        type: 'references',
        confidence: resolved.confidence,
        path: rel,
        hash: record.hash,
        line: usage.line
      });
      if (usage.callLine !== null) {
        sink.addEdge({
          from,
          to: resolved.symbolNodeId,
          type: 'calls',
          confidence: resolved.confidence,
          path: rel,
          hash: record.hash,
          line: usage.callLine
        });
      }
      if (testNodeId && !inputs.byRel.get(resolved.definingRel)?.isTest) {
        sink.addEdge({
          from: testNodeId,
          to: resolved.symbolNodeId,
          type: 'tests',
          confidence: resolved.confidence,
          path: rel,
          hash: record.hash,
          line: usage.line
        });
      }
    }

    if (!testNodeId) continue;
    for (const entry of facts.imports) {
      const target = inputs.byRel.get(entry.targetRel);
      if (!target || target.isTest) continue;
      const to = inputs.fileNodeIdByRel.get(entry.targetRel);
      if (!to) continue;
      sink.addEdge({
        from: testNodeId,
        to,
        type: 'tests',
        confidence: 'exact',
        path: rel,
        hash: record.hash,
        line: entry.line
      });
    }
  }
}
