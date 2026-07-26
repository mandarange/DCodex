/**
 * Top-level declaration extraction from a real TypeScript AST.
 *
 * Identity is `(path, symbolKind, name, startOffset)`, so two modules that both
 * export `parse` never collapse into one node, and a rename that shifts offsets
 * produces a genuinely different symbol instead of silently rewriting one.
 */
import ts from 'typescript';
import { contextGraphNodeId } from '../../ids.js';
import type { CodeSymbolKind, DeclaredSymbol } from './types.js';
import { estimateTokenCost } from './types.js';

interface DeclarationContext {
  sourceFile: ts.SourceFile;
  rel: string;
  /** local name -> names it is published under by a bare `export { ... }` clause */
  localExports: Map<string, string[]>;
  out: DeclaredSymbol[];
}

function hasFlag(node: ts.Declaration, flag: ts.ModifierFlags): boolean {
  return (ts.getCombinedModifierFlags(node) & flag) !== 0;
}

function collectLocalExportAliases(sourceFile: ts.SourceFile): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (statement.moduleSpecifier) continue;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) {
      const local = (element.propertyName ?? element.name).text;
      const exported = element.name.text;
      const bucket = aliases.get(local);
      if (bucket) bucket.push(exported);
      else aliases.set(local, [exported]);
    }
  }
  return aliases;
}

interface PushOptions {
  exportedByModifier: boolean;
  isDefault: boolean;
  /** overrides the derived export names, for `export =` where the published name is not the local one */
  explicitExportNames?: readonly string[];
}

function pushSymbol(
  context: DeclarationContext,
  node: ts.Node,
  name: string,
  symbolKind: CodeSymbolKind,
  options: PushOptions
): void {
  const startOffset = node.getStart(context.sourceFile);
  const endOffset = node.getEnd();
  const start = context.sourceFile.getLineAndCharacterOfPosition(startOffset);
  const end = context.sourceFile.getLineAndCharacterOfPosition(endOffset);
  const exportNames = new Set<string>();
  if (options.explicitExportNames) for (const explicit of options.explicitExportNames) exportNames.add(explicit);
  else if (options.isDefault) exportNames.add('default');
  else if (options.exportedByModifier) exportNames.add(name);
  for (const alias of context.localExports.get(name) ?? []) exportNames.add(alias);
  context.out.push({
    nodeId: contextGraphNodeId({ kind: 'symbol', path: context.rel, symbolKind, name, startOffset }),
    name,
    symbolKind,
    startOffset,
    endOffset,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
    exported: exportNames.size > 0,
    isDefault: options.isDefault,
    exportNames: [...exportNames].sort(),
    tokenCost: estimateTokenCost(endOffset - startOffset)
  });
}

function variableKind(statement: ts.VariableStatement): CodeSymbolKind {
  const flags = statement.declarationList.flags;
  if (flags & ts.NodeFlags.Const) return 'const';
  if (flags & ts.NodeFlags.Let) return 'let';
  return 'var';
}

function collectBindingNames(name: ts.BindingName, out: ts.Identifier[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    collectBindingNames(element.name, out);
  }
}

function visitVariableStatement(context: DeclarationContext, statement: ts.VariableStatement): void {
  const symbolKind = variableKind(statement);
  for (const declaration of statement.declarationList.declarations) {
    // getCombinedModifierFlags walks a VariableDeclaration up to its statement, so `export const` is seen here.
    const exported = hasFlag(declaration, ts.ModifierFlags.Export);
    const identifiers: ts.Identifier[] = [];
    collectBindingNames(declaration.name, identifiers);
    for (const identifier of identifiers) {
      // A destructured binding is anchored on its own identifier so each name keeps a distinct offset.
      const anchor: ts.Node = ts.isIdentifier(declaration.name) ? declaration : identifier;
      pushSymbol(context, anchor, identifier.text, symbolKind, { exportedByModifier: exported, isDefault: false });
    }
  }
}

function namedDeclarationKind(statement: ts.Statement): CodeSymbolKind | null {
  if (ts.isFunctionDeclaration(statement)) return 'function';
  if (ts.isClassDeclaration(statement)) return 'class';
  if (ts.isInterfaceDeclaration(statement)) return 'interface';
  if (ts.isTypeAliasDeclaration(statement)) return 'type';
  if (ts.isEnumDeclaration(statement)) return 'enum';
  if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) return 'namespace';
  return null;
}

function visitStatement(context: DeclarationContext, statement: ts.Statement): void {
  if (ts.isVariableStatement(statement)) {
    visitVariableStatement(context, statement);
    return;
  }
  if (ts.isExportAssignment(statement)) {
    const isEquals = statement.isExportEquals === true;
    const expression = statement.expression;
    const name = isEquals ? (ts.isIdentifier(expression) ? expression.text : 'exportEquals') : 'default';
    pushSymbol(context, statement, name, 'default', {
      exportedByModifier: true,
      isDefault: !isEquals,
      // `export = x` is reachable as the CommonJS module value and, under interop, as `default`.
      ...(isEquals ? { explicitExportNames: ['export=', 'default'] } : {})
    });
    return;
  }
  const kind = namedDeclarationKind(statement);
  if (!kind) return;
  const declaration = statement as ts.DeclarationStatement;
  const isDefault = hasFlag(declaration, ts.ModifierFlags.Default);
  const exported = hasFlag(declaration, ts.ModifierFlags.Export);
  const name = declaration.name && ts.isIdentifier(declaration.name) ? declaration.name.text : isDefault ? 'default' : '';
  if (!name) return;
  pushSymbol(context, statement, name, kind, { exportedByModifier: exported, isDefault });
}

/**
 * Every top-level declaration in `sourceFile`, exported or not, in source order.
 * `export { x }` clauses are folded in so a declaration exported below its
 * definition still reports the names it is importable under.
 */
export function extractDeclarations(sourceFile: ts.SourceFile, rel: string): DeclaredSymbol[] {
  const context: DeclarationContext = {
    sourceFile,
    rel,
    localExports: collectLocalExportAliases(sourceFile),
    out: []
  };
  for (const statement of sourceFile.statements) visitStatement(context, statement);
  return context.out;
}

/** Index of `exportName -> declaration` for one file, used to resolve imported bindings. */
export function indexExports(symbols: readonly DeclaredSymbol[]): Map<string, DeclaredSymbol> {
  const index = new Map<string, DeclaredSymbol>();
  for (const symbol of symbols) {
    for (const exportName of symbol.exportNames) {
      if (!index.has(exportName)) index.set(exportName, symbol);
    }
  }
  return index;
}

/** Index of `name -> declaration` including module-private declarations. */
export function indexDeclaredNames(symbols: readonly DeclaredSymbol[]): Map<string, DeclaredSymbol> {
  const index = new Map<string, DeclaredSymbol>();
  for (const symbol of symbols) {
    if (!index.has(symbol.name)) index.set(symbol.name, symbol);
  }
  return index;
}
