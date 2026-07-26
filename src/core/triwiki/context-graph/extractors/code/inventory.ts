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
import type { CodeInventory, CodeInventorySkip, CodeSourceFileRecord } from './types.js';

/** Directories never descended into; `.`-prefixed directories are skipped as tool state. */
const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set(['node_modules', 'dist', 'build', 'coverage', 'archive']);

const SUPPORTED_EXTENSIONS: ReadonlyMap<string, 'typescript' | 'javascript'> = new Map([
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript']
]);

/**
 * Extensions that are unmistakably source code in another language. Only these
 * earn an `unsupported_language` skip: recording one for every `.md` or `.png`
 * in a repository would bury the skips that actually mean something.
 */
const FOREIGN_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.php', '.c', '.h', '.cc', '.cpp',
  '.hpp', '.cs', '.scala', '.sh', '.bash', '.zsh', '.vue', '.svelte', '.dart', '.m', '.mm', '.pl',
  '.lua', '.ex', '.exs', '.clj', '.hs', '.ml', '.jl', '.sql', '.r'
]);

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

function isExcludedDirName(name: string): boolean {
  return name.startsWith('.') || EXCLUDED_DIR_NAMES.has(name);
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

interface WalkState {
  root: string;
  limits: ContextGraphExtractionLimits;
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

function readEntries(absolute: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(absolute, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch {
    return null;
  }
}

function ingestFile(state: WalkState, rel: string, absolute: string): void {
  const extension = path.posix.extname(rel).toLowerCase();
  const language = SUPPORTED_EXTENSIONS.get(extension);
  if (!language) {
    if (FOREIGN_CODE_EXTENSIONS.has(extension)) {
      addSkip(state, { path: rel, reason: 'unsupported_language', detail: `no extractor for ${extension} sources` });
    }
    return;
  }
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
    language
  });
}

function walkDirectory(state: WalkState, relDir: string): void {
  if (state.stopped) return;
  const absolute = relDir ? path.join(state.root, relDir) : state.root;
  let real: string;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    addSkip(state, { path: relDir || '.', reason: 'unreadable', detail: 'directory realpath failed' });
    return;
  }
  if (state.visitedDirs.has(real)) return;
  state.visitedDirs.add(real);
  const entries = readEntries(absolute);
  if (!entries) {
    addSkip(state, { path: relDir || '.', reason: 'unreadable', detail: 'directory listing failed' });
    return;
  }
  for (const entry of entries) {
    if (state.stopped) return;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (isExcludedDirName(entry.name)) {
        addSkip(state, { path: rel, reason: 'excluded', detail: 'directory is not scanned by the code extractor' });
        continue;
      }
      walkDirectory(state, rel);
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
          continue;
        }
        if (isExcludedDirName(entry.name)) continue;
        walkDirectory(state, rel);
        continue;
      }
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    ingestFile(state, rel, path.join(state.root, rel));
  }
}

/** Walk the workspace and return every parseable source file plus explicit skips. */
export function walkCodeInventory(root: string, limits: ContextGraphExtractionLimits): CodeInventory {
  const absoluteRoot = path.resolve(root);
  const state: WalkState = {
    root: absoluteRoot,
    limits,
    files: [],
    skipped: [],
    excludedSkips: 0,
    capSkips: 0,
    stopped: false,
    visitedDirs: new Set<string>()
  };
  if (fs.existsSync(absoluteRoot)) walkDirectory(state, '');
  state.files.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
  const byRel = new Map<string, CodeSourceFileRecord>();
  for (const file of state.files) byRel.set(file.rel, file);
  return { files: state.files, byRel, skipped: state.skipped };
}
