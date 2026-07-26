/**
 * Bounded file inventory and cache-input glob expansion.
 *
 * The topology extractor never walks `.git`, `node_modules`, `dist`, or a nested
 * worktree checkout, and it never expands a glob past a cap: a manifest entry
 * such as `src/**` matches thousands of files, and turning every one of them
 * into an `affected_by` edge would drown the snapshot in noise the query engine
 * cannot rank. Over-wide globs stay recorded as raw text on the gate node.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Directories that never contribute manifest-reachable files. */
export const TOPOLOGY_EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.cache',
  '.claude',
  '.next',
  '.sneakoscope',
  '.turbo',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'tmp',
  'vendor'
]);

const MAX_WALK_DEPTH = 24;

export interface FileInventory {
  /** workspace-relative POSIX paths, sorted */
  readonly files: readonly string[];
  readonly set: ReadonlySet<string>;
  /** true when `maxFiles` stopped the walk before it finished */
  readonly truncated: boolean;
}

export interface GlobExpansion {
  /** sorted matches, empty when the pattern blew past `cap` */
  readonly matches: readonly string[];
  /** total number of inventory entries the pattern matched */
  readonly total: number;
  readonly capped: boolean;
}

/**
 * Collect the workspace file list once so every glob is answered from memory.
 * Symlinked entries are skipped outright rather than followed: a link can leave
 * the workspace, and provenance may only cite paths inside it.
 */
export function buildFileInventory(root: string, maxFiles: number): FileInventory {
  const limit = Number.isFinite(maxFiles) && maxFiles > 0 ? Math.trunc(maxFiles) : 0;
  const files: string[] = [];
  let truncated = false;

  const walk = (absoluteDir: string, relativeDir: string, depth: number): void => {
    if (truncated || depth > MAX_WALK_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      const name = entry.name;
      if (!name || name === '.' || name === '..' || name === '.DS_Store') continue;
      if (TOPOLOGY_EXCLUDED_DIR_NAMES.has(name)) continue;
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      if (entry.isDirectory()) {
        walk(path.join(absoluteDir, name), relative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      files.push(relative);
    }
  };

  walk(path.resolve(root), '', 0);
  files.sort();
  return { files, set: new Set(files), truncated };
}

export function isGlobPattern(value: string): boolean {
  return value.includes('*') || value.includes('?');
}

const regexCache = new Map<string, RegExp>();
const REGEX_CACHE_LIMIT = 512;
const REGEX_SPECIAL = /[.+^${}()|[\]\\]/;

/**
 * `**` crosses directory separators, `*` and `?` never do. `a/**` also matches
 * `a/b/c`, so a directory-shaped cache input still reaches its whole subtree.
 */
export function globToRegExp(glob: string): RegExp {
  const cached = regexCache.get(glob);
  if (cached) return cached;
  let body = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? '';
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          body += '(?:.*/)?';
        } else {
          body += '.*';
        }
        continue;
      }
      body += '[^/]*';
      continue;
    }
    if (char === '?') {
      body += '[^/]';
      continue;
    }
    body += REGEX_SPECIAL.test(char) ? `\\${char}` : char;
  }
  const compiled = new RegExp(`^${body}$`);
  if (regexCache.size >= REGEX_CACHE_LIMIT) regexCache.clear();
  regexCache.set(glob, compiled);
  return compiled;
}

/**
 * Expand one manifest cache input against the inventory. A literal path is a set
 * lookup; a pattern walks the sorted inventory so the result never depends on
 * filesystem ordering.
 */
export function expandGlob(inventory: FileInventory, pattern: string, cap: number): GlobExpansion {
  const raw = String(pattern ?? '').trim();
  if (!raw) return { matches: [], total: 0, capped: false };
  if (!isGlobPattern(raw)) {
    const hit = inventory.set.has(raw);
    return { matches: hit ? [raw] : [], total: hit ? 1 : 0, capped: false };
  }
  const expression = globToRegExp(raw);
  const matches: string[] = [];
  let total = 0;
  for (const file of inventory.files) {
    if (!expression.test(file)) continue;
    total += 1;
    if (total <= cap) matches.push(file);
  }
  if (total > cap) return { matches: [], total, capped: true };
  return { matches, total, capped: false };
}
