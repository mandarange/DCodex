import fsp from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { cacheGet, cacheSet, searchCacheKey } from './cache.js';
import { searchFilesJs } from './files.js';
import { searchTextJs } from './text.js';
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

/**
 * Symbol/reference search with explicit confidence.
 * Text hits are always text_candidate — never exact_reference.
 */
export async function searchSymbol(req: SearchRequest): Promise<SearchResponse> {
  const started = Date.now();
  const limits = defaultSearchLimits(req.limits);
  const root = path.resolve(req.root);
  const symbol = (req.query || req.pattern || '').trim();
  if (!symbol || !/^[A-Za-z_$][\w$]*$/.test(symbol)) {
    return {
      schemaVersion: SEARCH_SCHEMA_VERSION,
      schema: SEARCH_PROVIDER_SCHEMA,
      ok: false,
      mode: 'symbol',
      provider: 'mixed',
      engine: 'triwiki+typescript',
      matches: [],
      confidence: 'mixed',
      truncated: false,
      timeout: false,
      limits,
      scanned: { files: 0, bytes: 0 },
      skipped: emptySkipped(),
      cacheHit: false,
      warnings: [],
      errors: ['invalid_symbol_identifier'],
      durationMs: Date.now() - started,
      processSpawns: 0,
      deterministicOrder: 'path_line_column'
    };
  }

  const cacheKey = searchCacheKey('symbol_extract', { ...req, root, mode: 'symbol', query: symbol });
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
      const def = asDefinition(node, symbol);
      if (def) {
        const pos = source.getLineAndCharacterOfPosition(def.pos);
        matches.push({
          path: rel,
          line: pos.line + 1,
          column: pos.character + 1,
          text: def.text.slice(0, 240),
          symbol,
          confidence: 'exact_definition',
          language: 'typescript',
          meta: { kind: def.kind }
        });
        return;
      }
      const syn = asSyntacticReference(node, symbol, source);
      if (syn) {
        const pos = source.getLineAndCharacterOfPosition(syn.pos);
        matches.push({
          path: rel,
          line: pos.line + 1,
          column: pos.character + 1,
          text: syn.text.slice(0, 240),
          symbol,
          confidence: 'syntactic_reference',
          language: 'typescript',
          meta: { kind: syn.kind }
        });
      }
    });
  }

  // Supplement with text candidates that were not already captured — labeled text_candidate only.
  const textResp = await searchTextJs({
    ...req,
    mode: 'text',
    pattern: `\\b${escapeRegex(symbol)}\\b`,
    limits: { ...limits, maxMatches: Math.min(200, limits.maxMatches) }
  });
  const seen = new Set(matches.map((m) => `${m.path}:${m.line}:${m.confidence}`));
  for (const hit of textResp.matches) {
    if (matches.length >= limits.maxMatches) {
      truncated = true;
      break;
    }
    const key = `${hit.path}:${hit.line}:text_candidate`;
    if (seen.has(`${hit.path}:${hit.line}:exact_definition`) || seen.has(`${hit.path}:${hit.line}:syntactic_reference`)) {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      ...hit,
      symbol,
      confidence: 'text_candidate' satisfies SearchConfidence,
      meta: { ...(hit.meta || {}), note: 'text_hit_not_a_reference' }
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
    engine: 'typescript-ast+text',
    matches,
    confidence: confidences.size === 1 ? ([...confidences][0] as SearchConfidence) : 'mixed',
    truncated: truncated || filesResp.truncated || textResp.truncated,
    timeout: textResp.timeout,
    limits,
    scanned: { files: filesResp.matches.length, bytes: scannedBytes + textResp.scanned.bytes },
    skipped,
    cacheHit: false,
    warnings: ['exact_reference_requires_lsp_or_tsserver_project; not claimed here'],
    errors: [],
    durationMs: Date.now() - started,
    processSpawns: filesResp.processSpawns + textResp.processSpawns,
    deterministicOrder: 'path_line_column'
  };
  cacheSet(cacheKey, response);
  return response;
}

function asDefinition(node: ts.Node, symbol: string): { pos: number; text: string; kind: string } | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name?.getText() === symbol
  ) {
    return { pos: node.name.getStart(), text: node.getText(), kind: ts.SyntaxKind[node.kind] };
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.getText() === symbol) {
    const parent = node.parent?.parent;
    const exported =
      parent &&
      ts.isVariableStatement(parent) &&
      !!parent.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    return {
      pos: node.name.getStart(),
      text: node.getText(),
      kind: exported ? 'ExportedVariable' : 'Variable'
    };
  }
  return null;
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
    // Avoid double-counting declarations handled above.
    const parent = node.parent;
    if (
      parent &&
      (ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isVariableDeclaration(parent)) &&
      (parent as ts.NamedDeclaration).name === node
    ) {
      return null;
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
