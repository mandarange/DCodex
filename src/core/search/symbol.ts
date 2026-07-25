import fsp from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { cacheGet, cacheSet, searchCacheKey } from './cache.js';
import { searchFilesJs } from './files.js';
import { searchTextJs } from './text.js';
import {
  createSearchLanguageService,
  findExactDefinitions,
  findExactReferences
} from './typescript-ls.js';
import {
  compareMatches,
  defaultSearchLimits,
  emptySkipped,
  SEARCH_PROVIDER_SCHEMA,
  SEARCH_SCHEMA_VERSION,
  type SearchConfidence,
  type SearchMatch,
  type SearchRequest,
  type SearchResponse
} from './types.js';

const TS_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const SUPPORTED_SYMBOL_LANGS = new Set(['ts', 'typescript', 'js', 'javascript', 'tsx', 'jsx']);

/**
 * Symbol/reference search with explicit confidence.
 * exact_definition / exact_reference come only from TypeScript LanguageService
 * binding resolution — never from raw text search.
 */
export async function searchSymbol(req: SearchRequest): Promise<SearchResponse> {
  const started = Date.now();
  const limits = defaultSearchLimits(req.limits);
  const root = path.resolve(req.root);
  const symbol = (req.query || req.pattern || '').trim();
  const language = (req.language || 'typescript').toLowerCase();

  if (req.language && !SUPPORTED_SYMBOL_LANGS.has(language)) {
    return errorResponse(limits, started, [`symbol_unsupported_language:${language}`], [
      'exact_definition/exact_reference require TypeScript LanguageService (ts/tsx/js/jsx)'
    ]);
  }

  if (!symbol || !/^[A-Za-z_$][\w$]*$/.test(symbol)) {
    return errorResponse(limits, started, ['invalid_symbol_identifier']);
  }

  const cacheKey = searchCacheKey('symbol_extract', { ...req, root, mode: 'symbol', query: symbol, language });
  const cached = cacheGet<SearchResponse>(cacheKey);
  if (cached) return { ...cached, cacheHit: true, durationMs: Date.now() - started };

  const defaultInclude = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'];
  const include = req.include?.length ? req.include : defaultInclude;
  const filesResp = await searchFilesJs({
    ...req,
    mode: 'files',
    query: '',
    pattern: '',
    include,
    limits: { ...limits, maxMatches: limits.maxFiles }
  });

  const tsFiles = filesResp.matches.map((m) => m.path).filter((p) => TS_EXT.test(p));
  const matches: SearchMatch[] = [];
  const skipped = emptySkipped();
  let scannedBytes = 0;
  let truncated = false;
  let engine = 'typescript-language-service';
  const warnings: string[] = [];

  const session = createSearchLanguageService(root, tsFiles);
  const lsReady = Boolean(session);
  if (!session) {
    warnings.push('typescript_language_service_unavailable:falling_back_to_syntactic_and_text');
    engine = 'syntactic+text';
  } else {
    try {
      const defs = findExactDefinitions(session, symbol, { maxMatches: limits.maxMatches });
      for (const hit of defs) {
        const row: SearchMatch = {
          path: hit.path,
          line: hit.line,
          column: hit.column,
          text: hit.text,
          symbol,
          confidence: 'exact_definition',
          language: 'typescript',
          meta: { resolver: 'typescript-language-service', kind: hit.kind }
        };
        if (hit.endLine !== undefined) row.endLine = hit.endLine;
        if (hit.endColumn !== undefined) row.endColumn = hit.endColumn;
        matches.push(row);
      }
      const refs = findExactReferences(session, symbol, {
        maxMatches: Math.max(0, limits.maxMatches - matches.length)
      });
      for (const hit of refs) {
        const row: SearchMatch = {
          path: hit.path,
          line: hit.line,
          column: hit.column,
          text: hit.text,
          symbol,
          confidence: 'exact_reference',
          language: 'typescript',
          meta: {
            resolver: 'typescript-language-service',
            kind: hit.kind,
            isWriteAccess: hit.isWriteAccess === true
          }
        };
        if (hit.endLine !== undefined) row.endLine = hit.endLine;
        if (hit.endColumn !== undefined) row.endColumn = hit.endColumn;
        matches.push(row);
      }
      if (matches.length >= limits.maxMatches) truncated = true;
    } finally {
      session.dispose();
    }
  }

  // Syntactic supplement for nodes the LS did not bind (e.g. incomplete projects).
  const seenExact = new Set(matches.map((m) => `${m.path}:${m.line}:${m.confidence}`));
  for (const file of filesResp.matches) {
    if (matches.length >= limits.maxMatches) {
      truncated = true;
      break;
    }
    const rel = file.path;
    if (!TS_EXT.test(rel)) continue;
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
    const scriptKind = /\.tsx?$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind);
    visit(source, (node) => {
      if (matches.length >= limits.maxMatches) {
        truncated = true;
        return;
      }
      const syn = asSyntacticReference(node, symbol, source);
      if (!syn) return;
      const pos = source.getLineAndCharacterOfPosition(syn.pos);
      const line = pos.line + 1;
      if (
        seenExact.has(`${rel}:${line}:exact_definition`) ||
        seenExact.has(`${rel}:${line}:exact_reference`) ||
        seenExact.has(`${rel}:${line}:syntactic_reference`)
      ) {
        return;
      }
      seenExact.add(`${rel}:${line}:syntactic_reference`);
      matches.push({
        path: rel,
        line,
        column: pos.character + 1,
        text: syn.text.slice(0, 240),
        symbol,
        confidence: 'syntactic_reference',
        language: 'typescript',
        meta: { kind: syn.kind, resolver: 'syntax-only' }
      });
    });
  }

  // Text candidates last — never promoted to exact_*.
  const textResp = await searchTextJs({
    ...req,
    mode: 'text',
    pattern: `\\b${escapeRegex(symbol)}\\b`,
    limits: { ...limits, maxMatches: Math.min(200, limits.maxMatches) }
  });
  for (const hit of textResp.matches) {
    if (matches.length >= limits.maxMatches) {
      truncated = true;
      break;
    }
    const keyExactDef = `${hit.path}:${hit.line}:exact_definition`;
    const keyExactRef = `${hit.path}:${hit.line}:exact_reference`;
    const keySyn = `${hit.path}:${hit.line}:syntactic_reference`;
    const keyText = `${hit.path}:${hit.line}:text_candidate`;
    if (seenExact.has(keyExactDef) || seenExact.has(keyExactRef) || seenExact.has(keySyn) || seenExact.has(keyText)) {
      continue;
    }
    seenExact.add(keyText);
    matches.push({
      ...hit,
      symbol,
      confidence: 'text_candidate',
      meta: { ...(hit.meta || {}), note: 'text_hit_not_a_reference', resolver: 'text' }
    });
  }

  matches.sort(compareMatches);
  const confidences = new Set(matches.map((m) => m.confidence));
  const response: SearchResponse = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    schema: SEARCH_PROVIDER_SCHEMA,
    ok: true,
    mode: 'symbol',
    provider: 'mixed',
    engine,
    matches,
    confidence: confidences.size === 1 ? ([...confidences][0] as SearchConfidence) : 'mixed',
    truncated: truncated || filesResp.truncated || textResp.truncated,
    timeout: textResp.timeout,
    limits,
    scanned: { files: filesResp.matches.length, bytes: scannedBytes + textResp.scanned.bytes },
    skipped,
    cacheHit: false,
    warnings,
    errors: [],
    durationMs: Date.now() - started,
    processSpawns: filesResp.processSpawns + textResp.processSpawns,
    context: {
      whySearched: req.why || 'symbol_lookup',
      method: engine,
      hydrated: lsReady,
      truncation: truncated || filesResp.truncated || textResp.truncated,
      excludedCount: skipped.files,
      tokenBudgetOmissions: 0
    },
    deterministicOrder: 'path_line_column'
  };
  cacheSet(cacheKey, response);
  return response;
}

function asSyntacticReference(
  node: ts.Node,
  symbol: string,
  source: ts.SourceFile
): { pos: number; text: string; kind: string } | null {
  if (ts.isImportSpecifier(node) && node.name.getText() === symbol) {
    return { pos: node.name.getStart(), text: node.getText(), kind: 'ImportSpecifier' };
  }
  if (ts.isExportSpecifier(node) && (node.name.getText() === symbol || node.propertyName?.getText() === symbol)) {
    return { pos: node.name.getStart(), text: node.getText(), kind: 'ExportSpecifier' };
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.getText() === symbol) {
    return { pos: node.expression.getStart(), text: node.getText().slice(0, 240), kind: 'CallExpression' };
  }
  if (ts.isPropertyAccessExpression(node) && node.name.getText() === symbol) {
    return { pos: node.name.getStart(), text: node.getText().slice(0, 240), kind: 'PropertyAccess' };
  }
  if (ts.isIdentifier(node) && node.getText() === symbol) {
    const parent = node.parent;
    if (
      parent &&
      (ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isEnumDeclaration(parent)) &&
      (parent as ts.NamedDeclaration).name === node
    ) {
      // Declarations are covered by exact_definition when LS is available.
      return { pos: node.getStart(source), text: node.getText(), kind: 'DeclarationName' };
    }
    return { pos: node.getStart(source), text: node.getText(), kind: 'Identifier' };
  }
  return null;
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorResponse(
  limits: ReturnType<typeof defaultSearchLimits>,
  started: number,
  errors: string[],
  warnings: string[] = []
): SearchResponse {
  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    schema: SEARCH_PROVIDER_SCHEMA,
    ok: false,
    mode: 'symbol',
    provider: 'mixed',
    engine: 'typescript-language-service',
    matches: [],
    confidence: 'mixed',
    truncated: false,
    timeout: false,
    limits,
    scanned: { files: 0, bytes: 0 },
    skipped: emptySkipped(),
    cacheHit: false,
    warnings,
    errors,
    durationMs: Date.now() - started,
    processSpawns: 0,
    deterministicOrder: 'path_line_column'
  };
}
