import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { cacheGet, cacheSet, searchCacheKey } from './cache.js';
import { searchFilesJs } from './files.js';
import { searchTextJs } from './text.js';
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

/**
 * AI context mode: TriWiki + Wiki Code Pack pipeline metadata.
 * No new vector DB. Uses local file/text search + pack freshness signals.
 */
export async function searchContext(req: SearchRequest): Promise<SearchResponse> {
  const started = Date.now();
  const limits = defaultSearchLimits(req.limits);
  const root = path.resolve(req.root);
  const query = (req.query || req.pattern || '').trim();
  if (!query) {
    return {
      schemaVersion: SEARCH_SCHEMA_VERSION,
      schema: SEARCH_PROVIDER_SCHEMA,
      ok: false,
      mode: 'context',
      provider: 'triwiki',
      engine: 'triwiki+codepack',
      matches: [],
      confidence: 'context_pack',
      truncated: false,
      timeout: false,
      limits,
      scanned: { files: 0, bytes: 0 },
      skipped: emptySkipped(),
      cacheHit: false,
      warnings: [],
      errors: ['missing_context_query'],
      durationMs: Date.now() - started,
      processSpawns: 0,
      deterministicOrder: 'path_line_column'
    };
  }

  const cacheKey = searchCacheKey('triwiki_codepack', { ...req, root, mode: 'context', query });
  const cached = cacheGet<SearchResponse>(cacheKey);
  if (cached) return { ...cached, cacheHit: true, durationMs: Date.now() - started };

  const packMeta = await readCodePackMeta(root);
  const filesResp = await searchFilesJs({
    ...req,
    mode: 'files',
    query,
    limits: { ...limits, maxMatches: Math.min(80, limits.maxMatches) }
  });
  const textResp = await searchTextJs({
    ...req,
    mode: 'text',
    pattern: escapeRegex(query),
    caseSensitive: false,
    limits: { ...limits, maxMatches: Math.min(120, limits.maxMatches) }
  });

  const matches: SearchMatch[] = [];
  for (const m of filesResp.matches) {
    matches.push({
      path: m.path,
      confidence: 'context_pack',
      meta: { channel: 'path_match' }
    });
  }
  for (const m of textResp.matches) {
    matches.push({
      ...m,
      confidence: 'context_pack',
      meta: { ...(m.meta || {}), channel: 'text_match', text_is_not_reference: true }
    });
  }
  matches.sort(compareMatches);

  const tokenBudgetOmissions = Math.max(0, textResp.matches.length + filesResp.matches.length - matches.length);
  let fileHash: string | null = null;
  if (matches[0]) {
    try {
      const buf = await fsp.readFile(path.join(root, matches[0].path));
      fileHash = crypto.createHash('sha256').update(buf).digest('hex');
    } catch {
      fileHash = null;
    }
  }

  const response: SearchResponse = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    schema: SEARCH_PROVIDER_SCHEMA,
    ok: true,
    mode: 'context',
    provider: 'triwiki',
    engine: 'triwiki+codepack+local-search',
    matches: matches.slice(0, limits.maxMatches),
    confidence: 'context_pack',
    truncated: filesResp.truncated || textResp.truncated || matches.length > limits.maxMatches,
    timeout: textResp.timeout,
    limits,
    scanned: {
      files: filesResp.scanned.files + textResp.scanned.files,
      bytes: textResp.scanned.bytes
    },
    skipped: textResp.skipped,
    cacheHit: false,
    warnings: packMeta.warnings,
    errors: [],
    durationMs: Date.now() - started,
    processSpawns: filesResp.processSpawns + textResp.processSpawns,
    context: {
      whySearched: req.why || 'ai_context',
      method: 'triwiki_codepack_local',
      hydrated: Boolean(packMeta.present),
      indexFreshness: packMeta.freshness,
      fileHash,
      truncation: filesResp.truncated || textResp.truncated,
      excludedCount: textResp.skipped.files,
      tokenBudgetOmissions
    },
    deterministicOrder: 'path_line_column'
  };
  cacheSet(cacheKey, response);
  return response;
}

async function readCodePackMeta(root: string): Promise<{ present: boolean; freshness: string | null; warnings: string[] }> {
  const candidates = [
    path.join(root, '.sneakoscope', 'wiki', 'code-pack.json'),
    path.join(root, '.sneakoscope', 'wiki', 'context-pack.json')
  ];
  for (const file of candidates) {
    try {
      const text = await fsp.readFile(file, 'utf8');
      const json = JSON.parse(text);
      return {
        present: true,
        freshness: json.generated_at || json.updated_at || json.head || null,
        warnings: json.truncated ? ['code_pack_truncated'] : []
      };
    } catch {
      // try next
    }
  }
  return {
    present: false,
    freshness: null,
    warnings: ['code_pack_missing:run_sks_wiki_refresh_--code']
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
