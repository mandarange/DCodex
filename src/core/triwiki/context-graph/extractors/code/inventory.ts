/**
 * Bounded, spawn-free file inventory for the code graph extractor.
 *
 * The walk is filesystem-only (no `git ls-files`, no child process at all), it
 * is sorted at every level so three runs see the same order, and anything it
 * refuses to parse is recorded as an explicit skip rather than dropped.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ContextGraphExtractionLimits } from '../../contracts.js';
import { isSymlinkEscape } from '../../paths.js';
import type { CodeInventory, CodeInventorySkip, CodeLanguage, CodeSourceFileRecord } from './types.js';

/**
 * Generated/vendor directories that are never repository source.
 *
 * This is deliberately path-aware. A basename rule used to drop real modules
 * such as `src/core/build/**` merely because one segment was named `build`.
 * Hidden directories are also not blanket-excluded: `.github` and `.codex` can
 * contain real repository code. Only known runtime/generated roots and vendor
 * segments are omitted.
 */
const EXCLUDED_ROOT_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.sneakoscope',
  '.next',
  'archive',
  'build',
  'coverage',
  'dist',
  'out',
  'target'
]);
const EXCLUDED_ANYWHERE_DIRS: ReadonlySet<string> = new Set(['node_modules']);
const EXCLUDED_DIRECTORY_PREFIXES = Object.freeze([
  '.claude/worktrees'
]);

interface CodeExtensionProfile {
  language: CodeLanguage;
  parser: 'typescript' | 'text';
}

const SUPPORTED_EXTENSIONS: ReadonlyMap<string, CodeExtensionProfile> = new Map([
  ['.ts', { language: 'typescript', parser: 'typescript' }],
  ['.tsx', { language: 'typescript', parser: 'typescript' }],
  ['.mts', { language: 'typescript', parser: 'typescript' }],
  ['.cts', { language: 'typescript', parser: 'typescript' }],
  ['.js', { language: 'javascript', parser: 'typescript' }],
  ['.jsx', { language: 'javascript', parser: 'typescript' }],
  ['.mjs', { language: 'javascript', parser: 'typescript' }],
  ['.cjs', { language: 'javascript', parser: 'typescript' }],
  ['.py', { language: 'python', parser: 'text' }],
  ['.rb', { language: 'ruby', parser: 'text' }],
  ['.go', { language: 'go', parser: 'text' }],
  ['.rs', { language: 'rust', parser: 'text' }],
  ['.java', { language: 'java', parser: 'text' }],
  ['.kt', { language: 'kotlin', parser: 'text' }],
  ['.kts', { language: 'kotlin', parser: 'text' }],
  ['.swift', { language: 'swift', parser: 'text' }],
  ['.php', { language: 'php', parser: 'text' }],
  ['.c', { language: 'c', parser: 'text' }],
  ['.h', { language: 'c', parser: 'text' }],
  ['.cc', { language: 'cpp', parser: 'text' }],
  ['.cpp', { language: 'cpp', parser: 'text' }],
  ['.hpp', { language: 'cpp', parser: 'text' }],
  ['.cs', { language: 'csharp', parser: 'text' }],
  ['.scala', { language: 'scala', parser: 'text' }],
  ['.sh', { language: 'shell', parser: 'text' }],
  ['.bash', { language: 'shell', parser: 'text' }],
  ['.zsh', { language: 'shell', parser: 'text' }],
  ['.vue', { language: 'vue', parser: 'text' }],
  ['.svelte', { language: 'svelte', parser: 'text' }],
  ['.dart', { language: 'dart', parser: 'text' }],
  ['.m', { language: 'objective-c', parser: 'text' }],
  ['.mm', { language: 'objective-c', parser: 'text' }],
  ['.pl', { language: 'perl', parser: 'text' }],
  ['.lua', { language: 'lua', parser: 'text' }],
  ['.ex', { language: 'elixir', parser: 'text' }],
  ['.exs', { language: 'elixir', parser: 'text' }],
  ['.clj', { language: 'clojure', parser: 'text' }],
  ['.hs', { language: 'haskell', parser: 'text' }],
  ['.ml', { language: 'ocaml', parser: 'text' }],
  ['.jl', { language: 'julia', parser: 'text' }],
  ['.sql', { language: 'sql', parser: 'text' }],
  ['.r', { language: 'r', parser: 'text' }]
]);

/**
 * Extensions that are unmistakably source code in another language. Only these
 * earn an `unsupported_language` skip: recording one for every `.md` or `.png`
 * in a repository would bury the skips that actually mean something.
 */
/** How many `excluded` / `cap_reached` skips are worth keeping before they become noise. */
const MAX_EXCLUDED_SKIPS = 64;
const MAX_CAP_SKIPS = 32;
/** Leading bytes inspected when deciding whether a source-extension file is really binary. */
const BINARY_PROBE_BYTES = 8192;
/**
 * A single NUL is not evidence of a binary: this repository legitimately uses
 * `U+0000` as a key separator inside template literals, and the old "any NUL
 * means binary" rule silently refused nine real TypeScript sources including a
 * frozen contract file. Binary now means undecodable UTF-8, or a genuine
 * density of control bytes.
 */
const MIN_BINARY_CONTROL_BYTES = 4;
const MIN_BINARY_CONTROL_PERCENT = 1;

export function isSupportedCodePath(relativePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase());
}

/** `__tests__/`, `test/` or `tests/` roots, and `*.test.*` / `*.spec.*` files. */
export function isTestPath(relativePath: string): boolean {
  const parts = relativePath.split('/');
  if (parts.includes('__tests__') || parts.includes('__test__')) return true;
  const head = parts[0];
  if (parts.length > 1 && (head === 'test' || head === 'tests')) return true;
  const base = parts[parts.length - 1] ?? '';
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(base);
}

function isExcludedDirectory(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => EXCLUDED_ANYWHERE_DIRS.has(part))) return true;
  if (EXCLUDED_DIRECTORY_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return true;
  return parts.length === 1 && EXCLUDED_ROOT_DIRS.has(parts[0] ?? '');
}

function hashBytes(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lines += 1;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** Decoded text, or `null` when the bytes are not valid UTF-8 and cannot be parsed. */
function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function controlByteDensity(bytes: Buffer): { count: number; percent: number } {
  const probe = Math.min(bytes.length, BINARY_PROBE_BYTES);
  if (!probe) return { count: 0, percent: 0 };
  let count = 0;
  for (let index = 0; index < probe; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) continue;
    // tab, newline, vertical tab, form feed and carriage return are ordinary text
    if (byte === 0 || byte < 9 || (byte > 13 && byte < 32) || byte === 127) count += 1;
  }
  return { count, percent: (count / probe) * 100 };
}

function looksBinary(bytes: Buffer): boolean {
  const density = controlByteDensity(bytes);
  return density.count >= MIN_BINARY_CONTROL_BYTES && density.percent >= MIN_BINARY_CONTROL_PERCENT;
}

function leadingSourcePurpose(text: string, language: CodeLanguage): string | null {
  const head = text.replace(/^\uFEFF/, '').slice(0, 8192).replace(/^#![^\n]*(?:\n|$)/, '').trimStart();
  const hashComment = new Set<CodeLanguage>(['python', 'ruby', 'shell', 'perl', 'r']).has(language);
  const match = head.match(hashComment
    ? /^(?:\/\*\*?([\s\S]*?)\*\/|((?:\/\/[^\n]*(?:\n|$))+)|((?:#[^\n]*(?:\n|$))+)|(?:"""|''')([\s\S]*?)(?:"""|'''))/
    : /^(?:\/\*\*?([\s\S]*?)\*\/|((?:\/\/[^\n]*(?:\n|$))+)|(?:"""|''')([\s\S]*?)(?:"""|'''))/);
  const raw = match?.slice(1).find((value) => typeof value === 'string' && value.trim()) ?? '';
  const compact = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\*|\/\/|#)\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return compact || null;
}

interface WalkState {
  root: string;
  limits: ContextGraphExtractionLimits;
  deadlineMs: number;
  maxEntries: number;
  maxDepth: number;
  visitedEntries: number;
  files: CodeSourceFileRecord[];
  skipped: CodeInventorySkip[];
  excludedSkips: number;
  capSkips: number;
  stopped: boolean;
  visitedDirs: Set<string>;
}

function addSkip(state: WalkState, skip: CodeInventorySkip): void {
  if (skip.reason === 'excluded') {
    if (state.excludedSkips >= MAX_EXCLUDED_SKIPS) return;
    state.excludedSkips += 1;
  }
  if (skip.reason === 'cap_reached') {
    if (state.capSkips >= MAX_CAP_SKIPS) {
      state.stopped = true;
      return;
    }
    state.capSkips += 1;
  }
  state.skipped.push(skip);
}

function stopWalk(state: WalkState, pathValue: string, detail: string): void {
  if (!state.stopped) {
    state.skipped.push({ path: pathValue, reason: 'cap_reached', detail });
    state.capSkips += 1;
  }
  state.stopped = true;
}

function readEntries(state: WalkState, relative: string, absolute: string): fs.Dirent[] | null {
  let directory: fs.Dir | null = null;
  try {
    directory = fs.opendirSync(absolute);
    const entries: fs.Dirent[] = [];
    for (;;) {
      if (Date.now() >= state.deadlineMs) {
        stopWalk(state, relative || '.', `timeoutMs=${state.limits.timeoutMs} exceeded during inventory`);
        break;
      }
      const entry = directory.readSync();
      if (!entry) break;
      if (state.visitedEntries + entries.length >= state.maxEntries) {
        stopWalk(state, relative || '.', `maxEntries=${state.maxEntries} reached`);
        break;
      }
      entries.push(entry);
    }
    return entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch {
    return null;
  } finally {
    try { directory?.closeSync(); } catch { /* the scan is already failing closed */ }
  }
}

function ingestFile(state: WalkState, rel: string, absolute: string): void {
  if (Date.now() >= state.deadlineMs) {
    stopWalk(state, rel, `timeoutMs=${state.limits.timeoutMs} exceeded during inventory`);
    return;
  }
  const extension = path.posix.extname(rel).toLowerCase();
  const profile = SUPPORTED_EXTENSIONS.get(extension);
  if (!profile) return;
  if (isSymlinkEscape(state.root, rel)) {
    addSkip(state, { path: rel, reason: 'symlink_escape', detail: 'symlink resolves outside the workspace' });
    return;
  }
  if (state.files.length >= state.limits.maxFiles) {
    addSkip(state, { path: rel, reason: 'cap_reached', detail: `maxFiles=${state.limits.maxFiles} reached` });
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    addSkip(state, { path: rel, reason: 'unreadable', detail: 'stat failed' });
    return;
  }
  if (stat.size > state.limits.maxFileBytes) {
    addSkip(state, { path: rel, reason: 'oversized', detail: `${stat.size} bytes exceeds maxFileBytes=${state.limits.maxFileBytes}` });
    return;
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absolute);
  } catch {
    addSkip(state, { path: rel, reason: 'unreadable', detail: 'read failed' });
    return;
  }
  const text = decodeUtf8(bytes);
  if (text === null) {
    addSkip(state, { path: rel, reason: 'binary', detail: 'not valid UTF-8 despite a source extension' });
    return;
  }
  if (looksBinary(bytes)) {
    addSkip(state, { path: rel, reason: 'binary', detail: 'dense control bytes in a source-extension file' });
    return;
  }
  state.files.push({
    rel,
    abs: absolute,
    hash: hashBytes(bytes),
    text,
    bytes: bytes.length,
    lines: countLines(text),
    isTest: isTestPath(rel),
    extension,
    language: profile.language,
    parser: profile.parser,
    purpose: leadingSourcePurpose(text, profile.language)
  });
}

function walkDirectories(state: WalkState): void {
  const stack: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  while (stack.length > 0 && !state.stopped) {
    const current = stack.pop()!;
    if (current.depth > state.maxDepth) {
      stopWalk(state, current.rel || '.', `maxDepth=${state.maxDepth} reached`);
      break;
    }
    if (Date.now() >= state.deadlineMs) {
      stopWalk(state, current.rel || '.', `timeoutMs=${state.limits.timeoutMs} exceeded during inventory`);
      break;
    }
    const absolute = current.rel ? path.join(state.root, current.rel) : state.root;
    let real: string;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      addSkip(state, { path: current.rel || '.', reason: 'unreadable', detail: 'directory realpath failed' });
      continue;
    }
    if (state.visitedDirs.has(real)) continue;
    state.visitedDirs.add(real);
    const entries = readEntries(state, current.rel, absolute);
    if (!entries) {
      addSkip(state, { path: current.rel || '.', reason: 'unreadable', detail: 'directory listing failed' });
      continue;
    }
    const childDirectories: string[] = [];
    for (const entry of entries) {
      if (state.stopped) break;
      state.visitedEntries += 1;
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isExcludedDirectory(rel)) {
          addSkip(state, { path: rel, reason: 'excluded', detail: 'directory is not scanned by the code extractor' });
        } else {
          childDirectories.push(rel);
        }
        continue;
      }
      if (entry.isSymbolicLink()) {
        let target: fs.Stats;
        try {
          target = fs.statSync(path.join(state.root, rel));
        } catch {
          addSkip(state, { path: rel, reason: 'unreadable', detail: 'broken symlink' });
          continue;
        }
        if (target.isDirectory()) {
          if (isSymlinkEscape(state.root, rel)) {
            addSkip(state, { path: rel, reason: 'symlink_escape', detail: 'symlinked directory resolves outside the workspace' });
          } else if (!isExcludedDirectory(rel)) {
            childDirectories.push(rel);
          }
          continue;
        }
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      ingestFile(state, rel, path.join(state.root, rel));
    }
    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      stack.push({ rel: childDirectories[index]!, depth: current.depth + 1 });
    }
  }
}

/** Walk the workspace and return every parseable source file plus explicit skips. */
export function walkCodeInventory(root: string, limits: ContextGraphExtractionLimits): CodeInventory {
  const absoluteRoot = path.resolve(root);
  const maxEntries = Number.isFinite(limits.maxEntries) && Number(limits.maxEntries) > 0
    ? Math.trunc(Number(limits.maxEntries))
    : Math.max(4_096, Math.min(1_000_000, Math.trunc(limits.maxFiles * 8)));
  const maxDepth = Number.isFinite(limits.maxDepth) && Number(limits.maxDepth) >= 0
    ? Math.trunc(Number(limits.maxDepth))
    : 256;
  const state: WalkState = {
    root: absoluteRoot,
    limits,
    deadlineMs: Date.now() + Math.max(1, limits.timeoutMs),
    maxEntries,
    maxDepth,
    visitedEntries: 1,
    files: [],
    skipped: [],
    excludedSkips: 0,
    capSkips: 0,
    stopped: false,
    visitedDirs: new Set<string>()
  };
  if (fs.existsSync(absoluteRoot)) walkDirectories(state);
  state.files.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
  const byRel = new Map<string, CodeSourceFileRecord>();
  for (const file of state.files) byRel.set(file.rel, file);
  return { files: state.files, byRel, skipped: state.skipped };
}
