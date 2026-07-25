export const SEARCH_PROVIDER_SCHEMA = 'sks.search-provider.v1' as const;
export const SEARCH_SCHEMA_VERSION = 1 as const;

export type SearchMode = 'files' | 'text' | 'structure' | 'symbol' | 'context';

export type SearchProviderId = 'sks-rs' | 'js' | 'typescript-ast' | 'triwiki' | 'mixed';

/** Confidence for matches. Text hits must never be labeled exact_reference. */
export type SearchConfidence =
  | 'exact_definition'
  | 'exact_reference'
  | 'syntactic_reference'
  | 'text_candidate'
  | 'structure_match'
  | 'file_path'
  | 'context_pack';

export interface SearchLimits {
  maxMatches?: number;
  maxFiles?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface SearchRequest {
  schemaVersion: typeof SEARCH_SCHEMA_VERSION;
  mode: SearchMode;
  root: string;
  query?: string;
  pattern?: string;
  language?: string;
  include?: string[];
  exclude?: string[];
  caseSensitive?: boolean;
  multiline?: boolean;
  followSymlinks?: boolean;
  limits?: SearchLimits;
  why?: string;
  batchId?: string;
}

export interface SearchMatch {
  path: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  text?: string;
  symbol?: string;
  confidence: SearchConfidence;
  language?: string;
  meta?: Record<string, unknown>;
}

export interface SearchContextMeta {
  whySearched?: string;
  method?: string;
  hydrated?: boolean;
  indexFreshness?: string | null;
  fileHash?: string | null;
  truncation?: boolean;
  excludedCount?: number;
  tokenBudgetOmissions?: number;
}

export interface SearchResponse {
  schemaVersion: typeof SEARCH_SCHEMA_VERSION;
  schema: typeof SEARCH_PROVIDER_SCHEMA;
  ok: boolean;
  mode: SearchMode;
  provider: SearchProviderId;
  engine: string;
  matches: SearchMatch[];
  confidence: SearchConfidence | 'mixed';
  truncated: boolean;
  timeout: boolean;
  limits: Required<SearchLimits>;
  scanned: { files: number; bytes: number };
  skipped: { files: number; reasons: Record<string, number> };
  cacheHit: boolean;
  warnings: string[];
  errors: string[];
  durationMs: number;
  processSpawns: number;
  context?: SearchContextMeta;
  deterministicOrder: 'path_line_column';
}

export interface SearchBatchRequest {
  schemaVersion: typeof SEARCH_SCHEMA_VERSION;
  root: string;
  requests: SearchRequest[];
}

export interface SearchBatchResponse {
  schemaVersion: typeof SEARCH_SCHEMA_VERSION;
  schema: 'sks.search-batch.v1';
  ok: boolean;
  provider: SearchProviderId;
  responses: SearchResponse[];
  processSpawns: number;
  durationMs: number;
}

export interface SearchCapabilityReport {
  schema: 'sks.search-capability.v1';
  ok: boolean;
  schemaVersion: typeof SEARCH_SCHEMA_VERSION;
  modes: Record<SearchMode, {
    available: boolean;
    provider: SearchProviderId | 'none';
    engine: string;
    externalBinaryRequired: boolean;
    notes: string[];
  }>;
  rust: {
    available: boolean;
    bin: string | null;
    version: string | null;
  };
  warnings: string[];
}

export function defaultSearchLimits(limits: SearchLimits = {}): Required<SearchLimits> {
  return {
    maxMatches: limits.maxMatches ?? 500,
    maxFiles: limits.maxFiles ?? 50_000,
    maxBytes: limits.maxBytes ?? 32 * 1024 * 1024,
    timeoutMs: limits.timeoutMs ?? 30_000
  };
}

export function emptySkipped(): SearchResponse['skipped'] {
  return { files: 0, reasons: {} };
}

export function compareMatches(a: SearchMatch, b: SearchMatch): number {
  const pathCmp = a.path.localeCompare(b.path);
  if (pathCmp !== 0) return pathCmp;
  const lineCmp = (a.line ?? 0) - (b.line ?? 0);
  if (lineCmp !== 0) return lineCmp;
  return (a.column ?? 0) - (b.column ?? 0);
}
