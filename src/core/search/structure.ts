import fsp from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { cacheGet, cacheSet, searchCacheKey } from './cache.js';
import { searchFilesJs } from './files.js';
import {
  compareMatches,
  defaultSearchLimits,
  emptySkipped,
  SEARCH_PROVIDER_SCHEMA,
  SEARCH_SCHEMA_VERSION,
  type SearchMatch,
  type SearchRequest,
  type SearchResponse
} from './types.js';

const TS_EXT = /\.(?:[cm]?[jt]sx?)$/i;

/** Supported structure pattern kinds for TS/JS (no external ast-grep). */
export type StructurePatternKind =
  | 'function_declaration'
  | 'class_declaration'
  | 'interface_declaration'
  | 'type_alias'
  | 'export_declaration'
  | 'call_expression'
  | 'import_declaration';

const PATTERN_ALIASES: Record<string, StructurePatternKind> = {
  function_declaration: 'function_declaration',
  function: 'function_declaration',
  class_declaration: 'class_declaration',
  class: 'class_declaration',
  interface_declaration: 'interface_declaration',
  interface: 'interface_declaration',
  type_alias: 'type_alias',
  type: 'type_alias',
  export_declaration: 'export_declaration',
  export: 'export_declaration',
  call_expression: 'call_expression',
  call: 'call_expression',
  import_declaration: 'import_declaration',
  import: 'import_declaration'
};

export async function searchStructure(req: SearchRequest): Promise<SearchResponse> {
  const started = Date.now();
  const limits = defaultSearchLimits(req.limits);
  const root = path.resolve(req.root);
  const language = (req.language || 'typescript').toLowerCase();
  if (!['ts', 'typescript', 'js', 'javascript', 'tsx', 'jsx'].includes(language)) {
    return capabilityError(req, limits, started, `structure_unsupported_language:${language}`);
  }

  const rawPattern = (req.pattern || req.query || '').trim();
  if (!rawPattern) {
    return capabilityError(req, limits, started, 'missing_structure_pattern');
  }

  const parsed = parseStructurePattern(rawPattern);
  if (!parsed) {
    return capabilityError(
      req,
      limits,
      started,
      `structure_pattern_unsupported:${rawPattern}`,
      ['Use kinds: function_declaration|class_declaration|interface_declaration|type_alias|export_declaration|call_expression|import_declaration [name]']
    );
  }

  const cacheKey = searchCacheKey('compiled_ast_pattern', {
    ...req,
    root,
    mode: 'structure',
    pattern: `${parsed.kind}:${parsed.name || ''}`,
    language
  });
  const cached = cacheGet<SearchResponse>(cacheKey);
  if (cached) return { ...cached, cacheHit: true, durationMs: Date.now() - started };

  const filesResp = await searchFilesJs({
    ...req,
    mode: 'files',
    query: '',
    pattern: '',
    include: req.include?.length ? req.include : ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    limits: { ...limits, maxMatches: limits.maxFiles }
  });

  const matches: SearchMatch[] = [];
  const skipped = emptySkipped();
  let scannedBytes = 0;
  let truncated = false;

  for (const file of filesResp.matches) {
    if (matches.length >= limits.maxMatches) {
      truncated = true;
      break;
    }
    const rel = file.path;
    if (!TS_EXT.test(rel)) {
      skipped.files += 1;
      skipped.reasons.language = (skipped.reasons.language || 0) + 1;
      continue;
    }
    const abs = path.join(root, rel);
    let text = '';
    try {
      text = await fsp.readFile(abs, 'utf8');
    } catch {
      skipped.files += 1;
      skipped.reasons.read = (skipped.reasons.read || 0) + 1;
      continue;
    }
    scannedBytes += Buffer.byteLength(text, 'utf8');
    const scriptKind = rel.endsWith('tsx') || rel.endsWith('jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind);
    visit(source, (node) => {
      if (matches.length >= limits.maxMatches) {
        truncated = true;
        return;
      }
      if (!nodeMatches(node, parsed.kind, parsed.name)) return;
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      const name = extractName(node);
      const match: SearchMatch = {
        path: rel,
        line: line + 1,
        column: character + 1,
        text: node.getText(source).slice(0, 240),
        confidence: 'structure_match',
        language: 'typescript',
        meta: { kind: parsed.kind }
      };
      if (name) match.symbol = name;
      matches.push(match);
    });
  }

  matches.sort(compareMatches);
  const response: SearchResponse = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    schema: SEARCH_PROVIDER_SCHEMA,
    ok: true,
    mode: 'structure',
    provider: 'typescript-ast',
    engine: 'typescript-compiler-api',
    matches,
    confidence: 'structure_match',
    truncated: truncated || filesResp.truncated,
    timeout: false,
    limits,
    scanned: { files: filesResp.matches.length, bytes: scannedBytes },
    skipped,
    cacheHit: false,
    warnings: [],
    errors: [],
    durationMs: Date.now() - started,
    processSpawns: filesResp.processSpawns,
    deterministicOrder: 'path_line_column'
  };
  cacheSet(cacheKey, response);
  return response;
}

function parseStructurePattern(raw: string): { kind: StructurePatternKind; name?: string } | null {
  // Accept "function_declaration foo" or "class Foo" or kind-only.
  const parts = raw.split(/\s+/).filter(Boolean);
  const kindKey = (parts[0] || '').toLowerCase();
  const kind = PATTERN_ALIASES[kindKey];
  if (!kind) {
    // Allow name-only as call_expression / identifier search is NOT structure — reject to avoid text disguise.
    return null;
  }
  const name = parts[1];
  return name ? { kind, name } : { kind };
}

function nodeMatches(node: ts.Node, kind: StructurePatternKind, name?: string): boolean {
  switch (kind) {
    case 'function_declaration':
      if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node) && !ts.isFunctionExpression(node) && !ts.isArrowFunction(node)) return false;
      break;
    case 'class_declaration':
      if (!ts.isClassDeclaration(node)) return false;
      break;
    case 'interface_declaration':
      if (!ts.isInterfaceDeclaration(node)) return false;
      break;
    case 'type_alias':
      if (!ts.isTypeAliasDeclaration(node)) return false;
      break;
    case 'export_declaration':
      if (ts.isExportDeclaration(node)) break;
      if (ts.canHaveModifiers(node) && (ts.getModifiers(node) || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) break;
      return false;
    case 'call_expression':
      if (!ts.isCallExpression(node)) return false;
      break;
    case 'import_declaration':
      if (!ts.isImportDeclaration(node)) return false;
      break;
    default:
      return false;
  }
  if (!name) return true;
  const extracted = extractName(node);
  if (extracted) return extracted === name;
  if (ts.isCallExpression(node)) {
    const expr = node.expression.getText();
    return expr === name || expr.endsWith(`.${name}`);
  }
  return false;
}

function extractName(node: ts.Node): string | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isMethodDeclaration(node)
  ) {
    return node.name?.getText() || null;
  }
  if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations[0];
    return decl?.name.getText() || null;
  }
  return null;
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function capabilityError(
  req: SearchRequest,
  limits: ReturnType<typeof defaultSearchLimits>,
  started: number,
  error: string,
  warnings: string[] = []
): SearchResponse {
  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    schema: SEARCH_PROVIDER_SCHEMA,
    ok: false,
    mode: 'structure',
    provider: 'typescript-ast',
    engine: 'typescript-compiler-api',
    matches: [],
    confidence: 'structure_match',
    truncated: false,
    timeout: false,
    limits,
    scanned: { files: 0, bytes: 0 },
    skipped: emptySkipped(),
    cacheHit: false,
    warnings,
    errors: [error],
    durationMs: Date.now() - started,
    processSpawns: 0,
    deterministicOrder: 'path_line_column'
  };
}
