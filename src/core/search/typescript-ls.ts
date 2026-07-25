import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface TsSymbolHit {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  text: string;
  kind: 'definition' | 'reference';
  isWriteAccess?: boolean;
}

export interface TsLanguageServiceSession {
  service: ts.LanguageService;
  root: string;
  files: string[];
  dispose: () => void;
}

const TS_EXT = /\.(?:[cm]?[jt]sx?)$/i;

/**
 * Build an in-process TypeScript LanguageService over a bounded file set.
 * Used for exact_definition / exact_reference — never for text search.
 */
export function createSearchLanguageService(root: string, relativeFiles: string[]): TsLanguageServiceSession | null {
  const absRoot = path.resolve(root);
  const files = relativeFiles
    .filter((rel) => TS_EXT.test(rel))
    .map((rel) => path.resolve(absRoot, rel))
    .filter((abs) => fs.existsSync(abs));
  if (!files.length) return null;

  const configPath = ts.findConfigFile(absRoot, ts.sys.fileExists, 'tsconfig.json');
  let options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    noEmit: true
  };
  if (configPath) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!read.error) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
      options = { ...parsed.options, noEmit: true, skipLibCheck: true, allowJs: true };
    }
  }

  const versions = new Map<string, string>();
  for (const file of files) versions.set(normalizeFs(file), '1');

  const scriptSnapshots = new Map<string, ts.IScriptSnapshot>();
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => files.map(normalizeFs),
    getScriptVersion: (fileName) => versions.get(normalizeFs(fileName)) || '0',
    getScriptSnapshot: (fileName) => {
      const key = normalizeFs(fileName);
      const cached = scriptSnapshots.get(key);
      if (cached) return cached;
      if (!fs.existsSync(key)) return undefined;
      const text = fs.readFileSync(key, 'utf8');
      const snap = ts.ScriptSnapshot.fromString(text);
      scriptSnapshots.set(key, snap);
      return snap;
    },
    getCurrentDirectory: () => absRoot,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories
  };
  if (typeof ts.sys.realpath === 'function') {
    host.realpath = (p) => ts.sys.realpath!(p);
  }

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return {
    service,
    root: absRoot,
    files: files.map(normalizeFs),
    dispose: () => service.dispose()
  };
}

export function findExactDefinitions(
  session: TsLanguageServiceSession,
  symbol: string,
  limits: { maxMatches: number }
): TsSymbolHit[] {
  const hits: TsSymbolHit[] = [];
  const seen = new Set<string>();
  for (const file of session.files) {
    if (hits.length >= limits.maxMatches) break;
    const snap = session.service.getProgram()?.getSourceFile(file);
    if (!snap) continue;
    const text = snap.getFullText();
    let from = 0;
    while (hits.length < limits.maxMatches) {
      const idx = indexOfIdentifier(text, symbol, from);
      if (idx < 0) break;
      from = idx + symbol.length;
      const defs = session.service.getDefinitionAtPosition(file, idx) || [];
      for (const def of defs) {
        const defFile = session.service.getProgram()?.getSourceFile(def.fileName);
        const defText = defFile?.getFullText().slice(def.textSpan.start, def.textSpan.start + def.textSpan.length) || '';
        const nameOk = def.name === symbol || defText === symbol || defText.startsWith(symbol);
        if (!nameOk) continue;
        const key = `${normalizeRel(session.root, def.fileName)}:${def.textSpan.start}:def`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Prefer the identifier span when the definition span covers a whole statement.
        const span = defText === symbol || defText.length <= symbol.length + 2
          ? def.textSpan
          : { start: idx, length: symbol.length };
        const hit = spanToHit(session.root, def.fileName, span, 'definition');
        if (hit) hits.push(hit);
        if (hits.length >= limits.maxMatches) break;
      }
    }
  }
  return hits;
}

export function findExactReferences(
  session: TsLanguageServiceSession,
  symbol: string,
  limits: { maxMatches: number }
): TsSymbolHit[] {
  const hits: TsSymbolHit[] = [];
  const seen = new Set<string>();
  // Seed from a definition position when possible so findReferences resolves the symbol binding.
  const seedPositions: Array<{ file: string; pos: number }> = [];
  for (const file of session.files) {
    const snap = session.service.getProgram()?.getSourceFile(file);
    if (!snap) continue;
    const text = snap.getFullText();
    let from = 0;
    while (seedPositions.length < 8) {
      const idx = indexOfIdentifier(text, symbol, from);
      if (idx < 0) break;
      from = idx + symbol.length;
      const defs = session.service.getDefinitionAtPosition(file, idx) || [];
      if (defs.length) {
        seedPositions.push({ file, pos: idx });
        break;
      }
    }
    if (seedPositions.length >= 8) break;
  }
  if (!seedPositions.length) {
    // Fall back: scan for identifier occurrences and only keep those that resolve via findReferences.
    for (const file of session.files) {
      const snap = session.service.getProgram()?.getSourceFile(file);
      if (!snap) continue;
      const text = snap.getFullText();
      let from = 0;
      while (seedPositions.length < 3) {
        const idx = indexOfIdentifier(text, symbol, from);
        if (idx < 0) break;
        from = idx + symbol.length;
        seedPositions.push({ file, pos: idx });
      }
    }
  }

  for (const seed of seedPositions) {
    if (hits.length >= limits.maxMatches) break;
    const groups = session.service.findReferences(seed.file, seed.pos) || [];
    for (const group of groups) {
      for (const ref of group.references) {
        if (hits.length >= limits.maxMatches) break;
        const key = `${normalizeRel(session.root, ref.fileName)}:${ref.textSpan.start}:ref`;
        if (seen.has(key)) continue;
        // Skip definition entries — reported separately as exact_definition.
        if (ref.isDefinition) continue;
        const defsHere = session.service.getDefinitionAtPosition(ref.fileName, ref.textSpan.start) || [];
        const isDefSite = defsHere.some((d) =>
          normalizeFs(d.fileName) === normalizeFs(ref.fileName) && d.textSpan.start === ref.textSpan.start
        );
        if (isDefSite) continue;
        seen.add(key);
        const hit = spanToHit(session.root, ref.fileName, ref.textSpan, 'reference');
        if (hit) {
          hit.isWriteAccess = ref.isWriteAccess;
          hits.push(hit);
        }
      }
    }
  }
  return hits;
}

function indexOfIdentifier(text: string, symbol: string, from: number): number {
  let idx = text.indexOf(symbol, from);
  while (idx >= 0) {
    const before = idx === 0 ? '' : text[idx - 1] || '';
    const after = text[idx + symbol.length] || '';
    if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) return idx;
    idx = text.indexOf(symbol, idx + symbol.length);
  }
  return -1;
}

function spanToHit(
  root: string,
  fileName: string,
  span: ts.TextSpan,
  kind: 'definition' | 'reference'
): TsSymbolHit | null {
  const abs = normalizeFs(fileName);
  if (!fs.existsSync(abs)) return null;
  const text = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  const start = sf.getLineAndCharacterOfPosition(span.start);
  const end = sf.getLineAndCharacterOfPosition(span.start + span.length);
  const lineStart = text.lastIndexOf('\n', span.start - 1) + 1;
  const lineEndIdx = text.indexOf('\n', span.start);
  const lineText = text.slice(lineStart, lineEndIdx < 0 ? text.length : lineEndIdx);
  return {
    path: normalizeRel(root, abs),
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
    text: lineText.trim().slice(0, 240),
    kind
  };
}

function normalizeFs(file: string): string {
  return path.resolve(file);
}

function normalizeRel(root: string, file: string): string {
  return path.relative(root, normalizeFs(file)).split(path.sep).join('/');
}
