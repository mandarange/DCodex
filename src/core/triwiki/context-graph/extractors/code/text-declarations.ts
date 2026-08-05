import { contextGraphNodeId } from '../../ids.js';
import type { CodeSourceFileRecord, CodeSymbolKind, DeclaredSymbol } from './types.js';
import { estimateTokenCost } from './types.js';

interface DeclarationMatch {
  kind: CodeSymbolKind;
  name: string;
  exported: boolean;
}

function declaration(kind: CodeSymbolKind, name: string, exported = false): DeclarationMatch {
  return { kind, name, exported };
}

function visibilityExported(modifiers: string): boolean {
  return /\b(?:public|open|pub|export)\b/.test(modifiers);
}

function matchPattern(
  line: string,
  pattern: RegExp,
  kind: CodeSymbolKind,
  options: { exported?: boolean; exportedFrom?: number; nameAt?: number } = {}
): DeclarationMatch | null {
  const match = line.match(pattern);
  if (!match) return null;
  const name = String(match[options.nameAt ?? 2] ?? '');
  if (!name) return null;
  const exported = options.exported ?? visibilityExported(String(match[options.exportedFrom ?? 1] ?? ''));
  return declaration(kind, name, exported);
}

/**
 * Locate a declaration that is explicitly present on one source line.
 *
 * This is intentionally a conservative navigation parser, not a compiler for
 * each language. A missed multi-line declaration is preferable to a guessed
 * symbol: every returned coordinate is backed by the literal source line.
 */
function declarationOf(record: CodeSourceFileRecord, line: string): DeclarationMatch | null {
  if (record.language === 'swift') {
    const match = line.match(/^\s*((?:(?:public|open|internal|private|fileprivate|final|indirect|nonisolated)\s+)*)(class|struct|enum|protocol|actor|extension|func|typealias|let|var)\s+([A-Za-z_][A-Za-z0-9_.]*)/);
    if (!match) return null;
    const rawKind = match[2] ?? '';
    const kind: CodeSymbolKind = rawKind === 'func' ? 'function' : rawKind === 'typealias' ? 'type' : rawKind as CodeSymbolKind;
    return declaration(kind, match[3] ?? '', visibilityExported(match[1] ?? ''));
  }

  if (record.language === 'rust') {
    const match = line.match(/^\s*((?:pub(?:\([^)]*\))?\s+)?)(fn|struct|enum|trait|mod|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!match) return null;
    const rawKind = match[2] ?? '';
    const kind: CodeSymbolKind = rawKind === 'fn' ? 'function' : rawKind === 'mod' ? 'module' : rawKind === 'static' ? 'var' : rawKind as CodeSymbolKind;
    return declaration(kind, match[3] ?? '', /^pub\b/.test(match[1] ?? ''));
  }

  if (record.language === 'python') {
    const match = line.match(/^\s*(async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!match) return null;
    const name = match[2] ?? '';
    return declaration(match[1] === 'class' ? 'class' : 'function', name, !name.startsWith('_'));
  }

  if (record.language === 'ruby') {
    const type = matchPattern(line, /^\s*(class|module)\s+(?:::)?([A-Z][A-Za-z0-9_:]*)/, 'class', { exported: true, exportedFrom: 99 });
    if (type) return type.kind === 'class' && /^\s*module\b/.test(line) ? { ...type, kind: 'module' } : type;
    const method = line.match(/^\s*def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_!?=]*)/);
    return method ? declaration('method', method[1] ?? '', !String(method[1] ?? '').startsWith('_')) : null;
  }

  if (record.language === 'go') {
    const method = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/);
    if (method) {
      const name = method[1] ?? '';
      return declaration('function', name, /^[A-Z]/.test(name));
    }
    const named = line.match(/^\s*(type|const|var)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!named) return null;
    const name = named[2] ?? '';
    return declaration(named[1] as CodeSymbolKind, name, /^[A-Z]/.test(name));
  }

  if (record.language === 'kotlin' || record.language === 'java' || record.language === 'scala' || record.language === 'csharp') {
    const match = line.match(/^\s*((?:(?:public|protected|internal|private|open|final|sealed|abstract|static|data|case)\s+)*)(class|interface|enum|object|fun|record|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!match) return null;
    const rawKind = match[2] ?? '';
    const kind: CodeSymbolKind = rawKind === 'fun' ? 'function' : rawKind === 'object' || rawKind === 'record' ? 'class' : rawKind as CodeSymbolKind;
    return declaration(kind, match[3] ?? '', visibilityExported(match[1] ?? ''));
  }

  if (record.language === 'c' || record.language === 'cpp') {
    const type = line.match(/^\s*((?:(?:export|public|private|protected|final)\s+)*)(class|struct|enum)\s+(?:class\s+)?([A-Za-z_][A-Za-z0-9_]*)/);
    if (type) return declaration(type[2] as CodeSymbolKind, type[3] ?? '', record.language === 'c' || !/\b(?:private|protected)\b/.test(type[1] ?? ''));
    const namespace = line.match(/^\s*namespace\s+([A-Za-z_][A-Za-z0-9_:]*)/);
    if (namespace) return declaration('module', namespace[1] ?? '', true);
    const callable = line.match(/^\s*(?!if\b|for\b|while\b|switch\b|catch\b)(?:(?:inline|static|virtual|constexpr|consteval|constinit|extern|friend|explicit|unsigned|signed|long|short)\s+)*(?:[A-Za-z_][A-Za-z0-9_:<>,*&\s]*\s+)([A-Za-z_~][A-Za-z0-9_:~]*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:\{|;|$)/);
    return callable ? declaration(callable[1]?.includes('::') ? 'method' : 'function', callable[1] ?? '', !/^static\b/.test(line.trim())) : null;
  }

  if (record.language === 'objective-c') {
    const type = line.match(/^\s*@(interface|implementation|protocol)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (type) return declaration(type[1] === 'protocol' ? 'protocol' : 'class', type[2] ?? '', true);
    const method = line.match(/^\s*[+-]\s*\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)/);
    return method ? declaration('method', method[1] ?? '', true) : null;
  }

  if (record.language === 'php') {
    const type = line.match(/^\s*((?:(?:final|abstract|readonly)\s+)*)(class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (type) return declaration(type[2]?.toLowerCase() === 'trait' ? 'trait' : type[2]?.toLowerCase() as CodeSymbolKind, type[3] ?? '', true);
    const fn = line.match(/^\s*((?:(?:public|protected|private|static|final|abstract)\s+)*)function\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)/i);
    return fn ? declaration('function', fn[2] ?? '', !/\b(?:private|protected)\b/i.test(fn[1] ?? '')) : null;
  }

  if (record.language === 'dart') {
    const type = line.match(/^\s*(?:(?:abstract|base|final|interface|sealed)\s+)*(class|enum|mixin|extension|typedef)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (type) return declaration(type[1] === 'typedef' ? 'type' : type[1] === 'extension' || type[1] === 'mixin' ? 'extension' : type[1] as CodeSymbolKind, type[2] ?? '', !(type[2] ?? '').startsWith('_'));
  }

  if (record.language === 'shell') {
    const match = line.match(/^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)|^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/);
    const name = match?.[1] ?? match?.[2];
    return name ? declaration('function', name, false) : null;
  }

  if (record.language === 'perl') {
    return matchPattern(line, /^\s*sub\s+([A-Za-z_][A-Za-z0-9_:]*)/, 'function', { nameAt: 1, exported: false });
  }

  if (record.language === 'lua') {
    return matchPattern(line, /^\s*(?:local\s+)?function\s+([A-Za-z_][A-Za-z0-9_.:]*)/, 'function', { nameAt: 1, exported: !/^\s*local\b/.test(line) });
  }

  if (record.language === 'elixir') {
    const match = line.match(/^\s*(defmodule|defprotocol|defstruct|defp?|defmacro)\s+([A-Za-z_][A-Za-z0-9_.!?]*)/);
    if (!match) return null;
    const kind: CodeSymbolKind = match[1] === 'defmodule' ? 'module' : match[1] === 'defprotocol' ? 'protocol' : match[1] === 'defstruct' ? 'struct' : 'function';
    return declaration(kind, match[2] ?? '', match[1] !== 'defp');
  }

  if (record.language === 'clojure') {
    const match = line.match(/^\s*\((ns|defn-|defn|defmacro|defrecord|deftype|defprotocol|def)\s+([^\s()[\]{}]+)/);
    if (!match) return null;
    const kind: CodeSymbolKind = match[1] === 'ns' ? 'module' : match[1] === 'defrecord' || match[1] === 'deftype' ? 'struct' : match[1] === 'defprotocol' ? 'protocol' : match[1] === 'def' ? 'var' : 'function';
    return declaration(kind, match[2] ?? '', match[1] !== 'defn-');
  }

  if (record.language === 'haskell') {
    const type = line.match(/^\s*(data|newtype|type|class)\s+([A-Z][A-Za-z0-9_']*)/);
    if (type) return declaration(type[1] === 'class' ? 'class' : 'type', type[2] ?? '', true);
    return matchPattern(line, /^\s*([a-z_][A-Za-z0-9_']*)\s*::/, 'function', { nameAt: 1, exported: true });
  }

  if (record.language === 'ocaml') {
    const match = line.match(/^\s*(?:let\s+(?:rec\s+)?|module\s+(?:type\s+)?|type\s+|class\s+)([a-zA-Z_][A-Za-z0-9_']*)/);
    if (!match) return null;
    const kind: CodeSymbolKind = /^\s*module\b/.test(line) ? 'module' : /^\s*type\b/.test(line) ? 'type' : /^\s*class\b/.test(line) ? 'class' : 'function';
    return declaration(kind, match[1] ?? '', true);
  }

  if (record.language === 'julia') {
    const match = line.match(/^\s*(?:mutable\s+struct|struct|abstract\s+type|primitive\s+type|module|baremodule|function|macro)\s+([A-Za-z_][A-Za-z0-9_!]*)/);
    if (!match) return null;
    const kind: CodeSymbolKind = /\bstruct\b/.test(line) ? 'struct' : /\btype\b/.test(line) ? 'type' : /\bmodule\b/.test(line) ? 'module' : 'function';
    return declaration(kind, match[1] ?? '', true);
  }

  if (record.language === 'r') {
    return matchPattern(line, /^\s*([A-Za-z_.][A-Za-z0-9_.]*)\s*(?:<-|=)\s*function\s*\(/, 'function', { nameAt: 1, exported: true });
  }

  if (record.language === 'sql') {
    const match = line.match(/^\s*(?:CREATE\s+(?:OR\s+REPLACE\s+)?)?(TABLE|VIEW|FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_.]*)/i);
    if (!match) return null;
    return declaration(match[1]?.toLowerCase() as CodeSymbolKind, match[2] ?? '', true);
  }

  if (record.language === 'vue' || record.language === 'svelte') {
    const match = line.match(/^\s*((?:export\s+)?)(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (!match) return null;
    return declaration(match[2] === 'function' ? 'function' : match[2] as CodeSymbolKind, match[3] ?? '', Boolean(match[1]?.trim()));
  }

  return null;
}

/**
 * Deterministic declaration locator for non-TypeScript sources.
 * It records only declarations literally present on a source line. It does not
 * infer behavior, call graphs, or intent from prose outside the code file.
 */
export function extractTextDeclarations(record: CodeSourceFileRecord): DeclaredSymbol[] {
  if (record.parser !== 'text') return [];
  const out: DeclaredSymbol[] = [];
  let offset = 0;
  const lines = record.text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const matched = declarationOf(record, line);
    if (matched) {
      const column = Math.max(1, line.indexOf(matched.name) + 1);
      const startOffset = offset + column - 1;
      out.push({
        nodeId: contextGraphNodeId({
          kind: 'symbol',
          path: record.rel,
          symbolKind: matched.kind,
          name: matched.name,
          startOffset
        }),
        name: matched.name,
        symbolKind: matched.kind,
        startOffset,
        endOffset: offset + line.length,
        line: index + 1,
        column,
        endLine: index + 1,
        endColumn: line.length + 1,
        exported: matched.exported,
        isDefault: false,
        exportNames: matched.exported ? [matched.name] : [],
        tokenCost: estimateTokenCost(line.length)
      });
    }
    offset += line.length + 1;
  }
  return out;
}
