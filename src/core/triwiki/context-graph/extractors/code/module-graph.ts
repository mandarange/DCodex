/**
 * Import, re-export and barrel-chain resolution.
 *
 * Every specifier goes through `ts.resolveModuleName`, so path aliases, package
 * `exports`, index files and the NodeNext `.js` -> `.ts` mapping are decided by
 * the compiler rather than by string surgery. A specifier that does not resolve
 * produces no edge at all — an unresolved import is reported, never invented.
 */
import ts from 'typescript';
import { tryNormalizeGraphPath } from '../../paths.js';
import type { CodeGraphSink } from './builders.js';
import type { CodeResolutionContext } from './ts-config.js';
import { isBareSpecifier, modeForSpecifier, resolveSpecifier } from './ts-config.js';
import type {
  CodeSourceFileRecord,
  DeclaredSymbol,
  ModuleFacts,
  ParsedCodeFile,
  ReexportRecord
} from './types.js';
import { MAX_REEXPORT_DEPTH } from './types.js';

export interface ModuleGraphTables {
  factsByRel: ReadonlyMap<string, ModuleFacts>;
  /** exported name -> declaration, per file */
  exportsByRel: ReadonlyMap<string, ReadonlyMap<string, DeclaredSymbol>>;
  /** every declared name, including module-private ones, per file */
  declaredByRel: ReadonlyMap<string, ReadonlyMap<string, DeclaredSymbol>>;
}

export interface ExportResolution {
  rel: string;
  symbol: DeclaredSymbol;
  /** the definition was reached by following at least one `export ... from` hop */
  viaReexport: boolean;
}

interface FactsBuilder {
  facts: ModuleFacts;
  record: CodeSourceFileRecord;
  sourceFile: ts.SourceFile;
  context: CodeResolutionContext;
  isKnownFile: (rel: string) => boolean;
  importLines: Map<string, number>;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Resolve one specifier to a workspace-relative path, or record why no edge is
 * possible. Package imports resolve outside the workspace by design and are not
 * treated as skips; a first-party path that escapes the workspace is.
 */
function resolveTargetRel(builder: FactsBuilder, literal: ts.StringLiteralLike, line: number): string | null {
  const specifier = literal.text;
  if (!specifier) return null;
  const mode = modeForSpecifier(builder.context, builder.sourceFile, literal);
  const resolved = resolveSpecifier(builder.context, specifier, builder.record.abs, mode);
  if (!resolved) {
    if (!isBareSpecifier(specifier)) builder.facts.unresolved.push({ specifier, line });
    return null;
  }
  const rel = tryNormalizeGraphPath(builder.context.root, resolved.fileName);
  if (rel === null) {
    if (!resolved.external && !isBareSpecifier(specifier)) {
      builder.facts.skips.push({
        path: builder.facts.rel,
        reason: 'excluded',
        detail: `import '${specifier}' resolves outside the workspace`
      });
    }
    return null;
  }
  if (!builder.isKnownFile(rel)) return null;
  return rel;
}

function noteImport(builder: FactsBuilder, targetRel: string, line: number): void {
  if (builder.importLines.has(targetRel)) return;
  builder.importLines.set(targetRel, line);
  builder.facts.imports.push({ targetRel, line });
}

function collectImportDeclaration(builder: FactsBuilder, statement: ts.ImportDeclaration): void {
  const specifier = statement.moduleSpecifier;
  if (!ts.isStringLiteralLike(specifier)) return;
  const line = lineOf(builder.sourceFile, statement);
  const targetRel = resolveTargetRel(builder, specifier, line);
  if (targetRel) noteImport(builder, targetRel, line);
  const clause = statement.importClause;
  if (!clause) return;
  const push = (local: string, exportName: string): void => {
    builder.facts.bindings.push({ local, exportName, specifier: specifier.text, targetRel, line });
  };
  if (clause.name) push(clause.name.text, 'default');
  const bindings = clause.namedBindings;
  if (!bindings) return;
  if (ts.isNamespaceImport(bindings)) {
    push(bindings.name.text, '*');
    return;
  }
  for (const element of bindings.elements) {
    push(element.name.text, (element.propertyName ?? element.name).text);
  }
}

function collectImportEquals(builder: FactsBuilder, statement: ts.ImportEqualsDeclaration): void {
  const reference = statement.moduleReference;
  if (!ts.isExternalModuleReference(reference)) return;
  const specifier = reference.expression;
  if (!ts.isStringLiteralLike(specifier)) return;
  const line = lineOf(builder.sourceFile, statement);
  const targetRel = resolveTargetRel(builder, specifier, line);
  if (targetRel) noteImport(builder, targetRel, line);
  builder.facts.bindings.push({
    local: statement.name.text,
    exportName: 'export=',
    specifier: specifier.text,
    targetRel,
    line
  });
}

function collectExportDeclaration(builder: FactsBuilder, statement: ts.ExportDeclaration): void {
  const specifier = statement.moduleSpecifier;
  if (!specifier || !ts.isStringLiteralLike(specifier)) return;
  const line = lineOf(builder.sourceFile, statement);
  const targetRel = resolveTargetRel(builder, specifier, line);
  if (!targetRel) return;
  const clause = statement.exportClause;
  const record: ReexportRecord = { targetRel, line, star: !clause, names: [] };
  if (clause && ts.isNamedExports(clause)) {
    for (const element of clause.elements) {
      record.names.push({ exportName: element.name.text, sourceName: (element.propertyName ?? element.name).text });
    }
  }
  builder.facts.reexports.push(record);
}

/** `import('...')` and `require('...')` with a literal argument. Computed specifiers yield no edge. */
function collectCallSpecifiers(builder: FactsBuilder): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) {
          const line = lineOf(builder.sourceFile, node);
          const targetRel = resolveTargetRel(builder, argument, line);
          if (targetRel) noteImport(builder, targetRel, line);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(builder.sourceFile, visit);
}

/** Imports, re-exports and imported bindings for one parsed file. */
export function collectModuleFacts(
  context: CodeResolutionContext,
  parsed: ParsedCodeFile,
  isKnownFile: (rel: string) => boolean
): ModuleFacts {
  const facts: ModuleFacts = {
    rel: parsed.record.rel,
    imports: [],
    reexports: [],
    bindings: [],
    skips: [],
    unresolved: []
  };
  const builder: FactsBuilder = {
    facts,
    record: parsed.record,
    sourceFile: parsed.sourceFile,
    context,
    isKnownFile,
    importLines: new Map<string, number>()
  };
  for (const statement of parsed.sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) collectImportDeclaration(builder, statement);
    else if (ts.isImportEqualsDeclaration(statement)) collectImportEquals(builder, statement);
    else if (ts.isExportDeclaration(statement)) collectExportDeclaration(builder, statement);
  }
  collectCallSpecifiers(builder);
  return facts;
}

/**
 * Follow `export ... from` hops until the file that actually declares
 * `exportName` is found. Bounded in depth and cycle-guarded, so a barrel that
 * re-exports itself terminates instead of hanging the compile.
 */
export function resolveExportedSymbol(
  tables: ModuleGraphTables,
  rel: string,
  exportName: string,
  depth = 0,
  seen: Set<string> = new Set<string>()
): ExportResolution | null {
  if (depth > MAX_REEXPORT_DEPTH) return null;
  const key = `${rel}\u0000${exportName}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const direct = tables.exportsByRel.get(rel)?.get(exportName);
  if (direct) return { rel, symbol: direct, viaReexport: depth > 0 };
  const facts = tables.factsByRel.get(rel);
  if (!facts) return null;
  for (const record of facts.reexports) {
    for (const name of record.names) {
      if (name.exportName !== exportName) continue;
      const nested = resolveExportedSymbol(tables, record.targetRel, name.sourceName, depth + 1, seen);
      if (nested) return { rel: nested.rel, symbol: nested.symbol, viaReexport: true };
    }
  }
  for (const record of facts.reexports) {
    if (!record.star) continue;
    const nested = resolveExportedSymbol(tables, record.targetRel, exportName, depth + 1, seen);
    if (nested) return { rel: nested.rel, symbol: nested.symbol, viaReexport: true };
  }
  return null;
}

/** Files reachable from `rel` through `export * from` hops, bounded by depth. */
export function starReexportTargets(tables: ModuleGraphTables, rel: string): string[] {
  const found = new Set<string>();
  const walk = (current: string, depth: number): void => {
    if (depth > MAX_REEXPORT_DEPTH) return;
    for (const record of tables.factsByRel.get(current)?.reexports ?? []) {
      if (!record.star) continue;
      if (record.targetRel === rel || found.has(record.targetRel)) continue;
      found.add(record.targetRel);
      walk(record.targetRel, depth + 1);
    }
  };
  walk(rel, 0);
  return [...found].sort();
}

/** `file imports file` and `file reexports file|symbol`. */
export function buildImportAndReexportEdges(
  sink: CodeGraphSink,
  tables: ModuleGraphTables,
  byRel: ReadonlyMap<string, CodeSourceFileRecord>,
  fileNodeIdByRel: ReadonlyMap<string, string>
): void {
  for (const [rel, facts] of tables.factsByRel) {
    const record = byRel.get(rel);
    const from = fileNodeIdByRel.get(rel);
    if (!record || !from) continue;
    for (const entry of facts.imports) {
      const to = fileNodeIdByRel.get(entry.targetRel);
      if (!to) continue;
      sink.addEdge({ from, to, type: 'imports', confidence: 'exact', path: rel, hash: record.hash, line: entry.line });
    }
    for (const reexport of facts.reexports) {
      const to = fileNodeIdByRel.get(reexport.targetRel);
      if (to) {
        sink.addEdge({ from, to, type: 'reexports', confidence: 'exact', path: rel, hash: record.hash, line: reexport.line });
      }
      if (reexport.star) {
        for (const transitive of starReexportTargets(tables, reexport.targetRel)) {
          const target = fileNodeIdByRel.get(transitive);
          if (!target || target === from) continue;
          sink.addEdge({ from, to: target, type: 'reexports', confidence: 'exact', path: rel, hash: record.hash, line: reexport.line });
        }
        continue;
      }
      for (const name of reexport.names) {
        const resolution = resolveExportedSymbol(tables, reexport.targetRel, name.sourceName);
        if (!resolution) continue;
        sink.addEdge({
          from,
          to: resolution.symbol.nodeId,
          type: 'reexports',
          confidence: 'exact',
          path: rel,
          hash: record.hash,
          line: reexport.line
        });
        const definingFile = fileNodeIdByRel.get(resolution.rel);
        if (definingFile && definingFile !== from) {
          sink.addEdge({
            from,
            to: definingFile,
            type: 'reexports',
            confidence: 'exact',
            path: rel,
            hash: record.hash,
            line: reexport.line
          });
        }
      }
    }
  }
}
