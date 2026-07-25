import path from 'node:path';
import { searchContext } from './context.js';
import { searchFilesJs } from './files.js';
import { tryRustSearch, tryRustSearchBatch, rustSearchStatus } from './ipc.js';
import { rustSupportsSearchCommand } from './rust-bridge.js';
import { searchStructure } from './structure.js';
import { searchSymbol } from './symbol.js';
import { searchTextJs } from './text.js';
import {
  SEARCH_SCHEMA_VERSION,
  type SearchBatchRequest,
  type SearchBatchResponse,
  type SearchCapabilityReport,
  type SearchRequest,
  type SearchResponse
} from './types.js';

export async function search(request: SearchRequest): Promise<SearchResponse> {
  const req: SearchRequest = {
    ...request,
    schemaVersion: SEARCH_SCHEMA_VERSION,
    root: path.resolve(request.root)
  };

  if (req.mode === 'files' || req.mode === 'text') {
    if (await rustSupportsSearchCommand()) {
      const rust = await tryRustSearch(req);
      if (rust) return rust;
    }
    return req.mode === 'files' ? searchFilesJs(req) : searchTextJs(req);
  }

  if (req.mode === 'structure') return searchStructure(req);
  if (req.mode === 'symbol') return searchSymbol(req);
  if (req.mode === 'context') return searchContext(req);

  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    schema: 'sks.search-provider.v1',
    ok: false,
    mode: req.mode,
    provider: 'js',
    engine: 'none',
    matches: [],
    confidence: 'mixed',
    truncated: false,
    timeout: false,
    limits: {
      maxMatches: 0,
      maxFiles: 0,
      maxBytes: 0,
      timeoutMs: 0
    },
    scanned: { files: 0, bytes: 0 },
    skipped: { files: 0, reasons: {} },
    cacheHit: false,
    warnings: [],
    errors: [`unsupported_mode:${String(req.mode)}`],
    durationMs: 0,
    processSpawns: 0,
    deterministicOrder: 'path_line_column'
  };
}

export async function searchBatch(batch: SearchBatchRequest): Promise<SearchBatchResponse> {
  const started = Date.now();
  const root = path.resolve(batch.root);
  const normalized: SearchBatchRequest = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    root,
    requests: batch.requests.map((r) => ({ ...r, schemaVersion: SEARCH_SCHEMA_VERSION, root }))
  };

  if (await rustSupportsSearchCommand()) {
    const rust = await tryRustSearchBatch(normalized);
    if (rust) return rust;
  }

  const responses: SearchResponse[] = [];
  let spawns = 0;
  for (const req of normalized.requests) {
    const resp = await search(req);
    responses.push(resp);
    spawns += resp.processSpawns;
  }
  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    schema: 'sks.search-batch.v1',
    ok: responses.every((r) => r.ok),
    provider: responses.some((r) => r.provider === 'sks-rs') ? 'mixed' : 'js',
    responses,
    processSpawns: spawns,
    durationMs: Date.now() - started
  };
}

export async function searchCapabilities(root = process.cwd()): Promise<SearchCapabilityReport> {
  const rust = await rustSearchStatus();
  const rustSearch = rust.available && (await rustSupportsSearchCommand());
  return {
    schema: 'sks.search-capability.v1',
    ok: true,
    schemaVersion: SEARCH_SCHEMA_VERSION,
    modes: {
      files: {
        available: true,
        provider: rustSearch ? 'sks-rs' : 'js',
        engine: rustSearch ? 'ignore' : 'js+git-ls-files',
        externalBinaryRequired: false,
        notes: rustSearch ? [] : ['Using JS fallback; build sks-rs for Rust ignore engine']
      },
      text: {
        available: true,
        provider: rustSearch ? 'sks-rs' : 'js',
        engine: rustSearch ? 'grep-searcher' : 'js-regex-scanner',
        externalBinaryRequired: false,
        notes: rustSearch ? [] : ['Using JS fallback; build sks-rs for Rust grep engine']
      },
      structure: {
        available: true,
        provider: 'typescript-ast',
        engine: 'typescript-compiler-api',
        externalBinaryRequired: false,
        notes: ['TS/JS only; unsupported languages return capability errors (never disguised as text)']
      },
      symbol: {
        available: true,
        provider: 'mixed',
        engine: 'typescript-ast+text',
        externalBinaryRequired: false,
        notes: ['exact_reference not claimed without LSP/tsserver project graph']
      },
      context: {
        available: true,
        provider: 'triwiki',
        engine: 'triwiki+codepack',
        externalBinaryRequired: false,
        notes: [`root=${path.resolve(root)}`, 'No vector DB']
      }
    },
    rust: {
      available: rust.available,
      bin: rust.bin,
      version: rust.version
    },
    warnings: rustSearch ? [] : ['sks_rs_search_unavailable']
  };
}
