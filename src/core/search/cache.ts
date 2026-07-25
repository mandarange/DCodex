import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { SearchMode, SearchRequest } from './types.js';

const CACHE = new Map<string, { expires: number; value: unknown }>();
const DEFAULT_TTL_MS = 30_000;

export type SearchCacheKind =
  | 'dir_snapshot'
  | 'compiled_ignore'
  | 'compiled_ast_pattern'
  | 'file_hash'
  | 'symbol_extract'
  | 'triwiki_codepack'
  | 'candidate_set';

export function searchCacheKey(kind: SearchCacheKind, req: Pick<SearchRequest, 'root' | 'mode' | 'query' | 'pattern' | 'include' | 'exclude' | 'language' | 'caseSensitive'> & { extra?: string }): string {
  const head = gitHead(req.root);
  const dirty = gitDirtyFingerprint(req.root);
  const payload = {
    kind,
    schema: 1,
    engine: 'sks.search.v1',
    root: req.root,
    head,
    dirty,
    mode: req.mode as SearchMode | undefined,
    query: req.query || '',
    pattern: req.pattern || '',
    include: req.include || [],
    exclude: req.exclude || [],
    language: req.language || '',
    caseSensitive: req.caseSensitive !== false,
    extra: req.extra || ''
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function cacheGet<T>(key: string): T | undefined {
  const hit = CACHE.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    CACHE.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function cacheSet(key: string, value: unknown, ttlMs = DEFAULT_TTL_MS): void {
  CACHE.set(key, { expires: Date.now() + ttlMs, value });
}

export function cacheClear(): void {
  CACHE.clear();
}

function gitHead(root: string): string {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (r.status === 0) return String(r.stdout || '').trim() || 'nohead';
  } catch {
    // ignore
  }
  return 'nohead';
}

function gitDirtyFingerprint(root: string): string {
  try {
    const r = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0) return 'unknown';
    const text = String(r.stdout || '');
    if (!text.trim()) return 'clean';
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  } catch {
    return 'unknown';
  }
}
