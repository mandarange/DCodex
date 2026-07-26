/**
 * tsconfig loading and module resolution for the code graph extractor.
 *
 * The compiler API is the single source of truth for what a module specifier
 * points at: path aliases, package `exports`, index resolution and the
 * NodeNext `.js` -> `.ts` mapping are all decided by `ts.resolveModuleName`.
 * The parsed config is created once per extraction and reused, and
 * `options.plugins` is stripped so no project plugin is ever loaded.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { CodeSourceFileRecord } from './types.js';

export interface CodeResolutionContext {
  root: string;
  options: ts.CompilerOptions;
  /** workspace-relative POSIX path of the config that produced `options`, when one was found */
  configRel: string | null;
  configHash: string | null;
  host: ts.ModuleResolutionHost;
  cache: ts.ModuleResolutionCache;
}

export interface ResolvedSpecifier {
  /** absolute resolved file name; callers normalize it before it reaches an artifact */
  fileName: string;
  /** resolution landed in a package directory rather than in first-party sources */
  external: boolean;
}

/** Used when the workspace carries no tsconfig/jsconfig at its root. */
const FALLBACK_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  resolveJsonModule: false
};

/**
 * Remove everything that would make resolution load or execute project code, or
 * that would make the extractor emit files. Extraction is read-only by contract.
 */
export function sanitizeCompilerOptions(options: ts.CompilerOptions): ts.CompilerOptions {
  const sanitized: ts.CompilerOptions = { ...options };
  delete sanitized.plugins;
  delete sanitized.outFile;
  delete sanitized.out;
  delete sanitized.declarationDir;
  delete sanitized.tsBuildInfoFile;
  delete sanitized.incremental;
  delete sanitized.composite;
  sanitized.noEmit = true;
  sanitized.declaration = false;
  sanitized.declarationMap = false;
  sanitized.sourceMap = false;
  sanitized.skipLibCheck = true;
  sanitized.allowJs = true;
  sanitized.checkJs = false;
  sanitized.types = [];
  return sanitized;
}

function readConfigOptions(root: string): { options: ts.CompilerOptions; rel: string | null; hash: string | null } {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const absolute = path.join(root, name);
    let raw: Buffer;
    try {
      raw = fs.readFileSync(absolute);
    } catch {
      continue;
    }
    const read = ts.readConfigFile(absolute, () => raw.toString('utf8'));
    if (read.error || !read.config) continue;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, absolute);
    return {
      options: sanitizeCompilerOptions(parsed.options),
      rel: name,
      hash: crypto.createHash('sha256').update(raw).digest('hex')
    };
  }
  return { options: sanitizeCompilerOptions(FALLBACK_OPTIONS), rel: null, hash: null };
}

function createResolutionHost(): ts.ModuleResolutionHost {
  const existsCache = new Map<string, boolean>();
  const dirCache = new Map<string, boolean>();
  const host: ts.ModuleResolutionHost = {
    fileExists: (fileName) => {
      const cached = existsCache.get(fileName);
      if (cached !== undefined) return cached;
      const value = ts.sys.fileExists(fileName);
      existsCache.set(fileName, value);
      return value;
    },
    readFile: (fileName) => ts.sys.readFile(fileName),
    directoryExists: (directoryName) => {
      const cached = dirCache.get(directoryName);
      if (cached !== undefined) return cached;
      const value = ts.sys.directoryExists(directoryName);
      dirCache.set(directoryName, value);
      return value;
    },
    getDirectories: (directoryName) => ts.sys.getDirectories(directoryName),
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames
  };
  if (typeof ts.sys.realpath === 'function') {
    const realpath = ts.sys.realpath.bind(ts.sys);
    host.realpath = (fileName) => realpath(fileName);
  }
  return host;
}

/** Build the per-extraction resolution context. Call this once, never per file. */
export function createResolutionContext(root: string): CodeResolutionContext {
  const absoluteRoot = path.resolve(root);
  const config = readConfigOptions(absoluteRoot);
  const host = createResolutionHost();
  const canonical = ts.sys.useCaseSensitiveFileNames
    ? (value: string) => value
    : (value: string) => value.toLowerCase();
  const cache = ts.createModuleResolutionCache(absoluteRoot, canonical, config.options);
  return {
    root: absoluteRoot,
    options: config.options,
    configRel: config.rel,
    configHash: config.hash,
    host,
    cache
  };
}

export function scriptKindForPath(relativePath: string): ts.ScriptKind {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.mts') || lower.endsWith('.cts') || lower.endsWith('.ts')) return ts.ScriptKind.TS;
  if (lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Real AST for one file. `impliedNodeFormat` is derived from disk so that
 * `getModeForUsageLocation` reports the correct CommonJS/ESM mode per specifier.
 */
export function createCodeSourceFile(context: CodeResolutionContext, record: CodeSourceFileRecord): ts.SourceFile {
  let impliedNodeFormat: ts.ResolutionMode;
  try {
    impliedNodeFormat = ts.getImpliedNodeFormatForFile(
      record.abs,
      context.cache.getPackageJsonInfoCache(),
      context.host,
      context.options
    );
  } catch {
    impliedNodeFormat = undefined;
  }
  const options: ts.CreateSourceFileOptions = {
    languageVersion: context.options.target ?? ts.ScriptTarget.ESNext,
    ...(impliedNodeFormat === undefined ? {} : { impliedNodeFormat })
  };
  return ts.createSourceFile(record.abs, record.text, options, true, scriptKindForPath(record.rel));
}

/** Mode for a specifier used at `usage`, so NodeNext dual-format files resolve correctly. */
export function modeForSpecifier(
  context: CodeResolutionContext,
  sourceFile: ts.SourceFile,
  usage: ts.StringLiteralLike
): ts.ResolutionMode {
  try {
    return ts.getModeForUsageLocation(sourceFile, usage, context.options);
  } catch {
    return undefined;
  }
}

/** Resolve one module specifier. Returns `null` when TypeScript could not resolve it. */
export function resolveSpecifier(
  context: CodeResolutionContext,
  specifier: string,
  containingFile: string,
  mode: ts.ResolutionMode
): ResolvedSpecifier | null {
  if (!specifier) return null;
  let resolved: ts.ResolvedModuleWithFailedLookupLocations;
  try {
    resolved = ts.resolveModuleName(specifier, containingFile, context.options, context.host, context.cache, undefined, mode);
  } catch {
    return null;
  }
  const module = resolved.resolvedModule;
  if (!module) return null;
  return { fileName: module.resolvedFileName, external: module.isExternalLibraryImport === true };
}

/** `true` for specifiers that name a package rather than a workspace path. */
export function isBareSpecifier(specifier: string): boolean {
  if (!specifier) return false;
  if (specifier.startsWith('.')) return false;
  if (specifier.startsWith('/')) return false;
  if (/^[A-Za-z]:[\\/]/.test(specifier)) return false;
  return true;
}
