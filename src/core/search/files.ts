import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cacheGet, cacheSet, searchCacheKey } from './cache.js';
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

const DEFAULT_SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.sneakoscope/tmp',
  '.sneakoscope/arenas',
  'target'
]);

export async function searchFilesJs(req: SearchRequest): Promise<SearchResponse> {
  const started = Date.now();
  const limits = defaultSearchLimits(req.limits);
  const root = path.resolve(req.root);
  const cacheKey = searchCacheKey('dir_snapshot', { ...req, root, mode: 'files' });
  const cached = cacheGet<SearchResponse>(cacheKey);
  if (cached) {
    return { ...cached, cacheHit: true, durationMs: Date.now() - started };
  }

  const skipped = emptySkipped();
  let files: string[] = [];
  const gitListed = listViaGit(root);
  if (gitListed) {
    files = gitListed;
  } else {
    files = await walkIgnoreAware(root, limits.maxFiles, skipped);
  }

  const include = req.include || [];
  const exclude = [...(req.exclude || []), ...(req.pattern ? [] : [])];
  const query = (req.query || req.pattern || '').trim();
  let filtered = files.filter((rel) => {
    if (exclude.some((g) => globMatch(rel, g))) {
      skipped.files += 1;
      skipped.reasons.exclude = (skipped.reasons.exclude || 0) + 1;
      return false;
    }
    if (include.length && !include.some((g) => globMatch(rel, g))) {
      skipped.files += 1;
      skipped.reasons.include = (skipped.reasons.include || 0) + 1;
      return false;
    }
    if (query && !rel.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  let truncated = false;
  if (filtered.length > limits.maxMatches) {
    filtered = filtered.slice(0, limits.maxMatches);
    truncated = true;
  }

  const matches: SearchMatch[] = filtered
    .map((p) => ({ path: p, confidence: 'file_path' as const }))
    .sort(compareMatches);

  const response: SearchResponse = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    schema: SEARCH_PROVIDER_SCHEMA,
    ok: true,
    mode: 'files',
    provider: 'js',
    engine: gitListed ? 'js+git-ls-files' : 'js-walk',
    matches,
    confidence: 'file_path',
    truncated,
    timeout: false,
    limits,
    scanned: { files: files.length, bytes: 0 },
    skipped,
    cacheHit: false,
    warnings: gitListed ? [] : ['gitignore_partial:js_walk_without_full_ignore_crate'],
    errors: [],
    durationMs: Date.now() - started,
    processSpawns: gitListed ? 1 : 0,
    deterministicOrder: 'path_line_column'
  };
  cacheSet(cacheKey, response);
  return response;
}

function listViaGit(root: string): string[] | null {
  try {
    const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    });
    if (r.status !== 0 || r.error) return null;
    return String(r.stdout || '')
      .split('\n')
      .map((line) => line.trim().replace(/\\/g, '/'))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return null;
  }
}

async function walkIgnoreAware(root: string, maxFiles: number, skipped: SearchResponse['skipped']): Promise<string[]> {
  const out: string[] = [];
  async function walk(abs: string, rel: string, depth: number): Promise<void> {
    if (out.length >= maxFiles || depth > 40) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      skipped.files += 1;
      skipped.reasons.readdir = (skipped.reasons.readdir || 0) + 1;
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const name = entry.name;
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = path.join(abs, name);
      if (DEFAULT_SKIP.has(name) || DEFAULT_SKIP.has(childRel.split('/')[0] || '')) {
        skipped.files += 1;
        skipped.reasons.default_skip = (skipped.reasons.default_skip || 0) + 1;
        continue;
      }
      try {
        if (entry.isSymbolicLink()) {
          skipped.files += 1;
          skipped.reasons.symlink = (skipped.reasons.symlink || 0) + 1;
          continue;
        }
        if (entry.isDirectory()) {
          await walk(childAbs, childRel, depth + 1);
        } else if (entry.isFile()) {
          out.push(childRel.replace(/\\/g, '/'));
        }
      } catch {
        skipped.files += 1;
        skipped.reasons.permission = (skipped.reasons.permission || 0) + 1;
      }
    }
  }
  await walk(root, '', 0);
  return out.sort((a, b) => a.localeCompare(b));
}

function globMatch(rel: string, pattern: string): boolean {
  const p = pattern.replace(/\\/g, '/');
  if (p.startsWith('!')) return false;
  if (p.includes('**')) {
    const re = new RegExp('^' + p.split('**').map(escapeRegex).join('.*') + '$');
    return re.test(rel);
  }
  if (p.includes('*')) {
    const re = new RegExp('^' + p.split('*').map(escapeRegex).join('[^/]*') + '$');
    return re.test(rel);
  }
  return rel === p || rel.startsWith(p.endsWith('/') ? p : `${p}/`) || rel.includes(`/${p}`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
