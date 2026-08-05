/**
 * The pre-graph context retrieval mechanic, rebuilt as a measurement instrument.
 *
 * MEASUREMENT INSTRUMENT ONLY — NOT A PRODUCTION FALLBACK.
 * This module exists so the benchmark has something to compare the Context
 * Graph against. It is imported by `benchmark/adapters/` and by nothing else.
 * It must never be wired into `src/core/search/context.ts`, into the query
 * engine, or into any code path that answers a real user request: a missing or
 * stale graph is required to surface `context_graph_missing` /
 * `context_graph_stale` plus `sks align run`, never a text answer.
 *
 * What it reproduces: a path search plus a text search over the workspace,
 * merged into one ranked list, every hit labelled `context_pack`, and
 * `hydrated` true exactly when a TriWiki pack artifact is present.
 */
import fs from 'node:fs';
import path from 'node:path';
import { searchFilesJs } from '../../../../search/files.js';
import { searchTextJs } from '../../../../search/text.js';
import { SEARCH_SCHEMA_VERSION, type SearchConfidence } from '../../../../search/types.js';
import { estimateTokenCost } from '../../extractors/code/types.js';
import { isWorkspaceRelativePosixPath } from '../../paths.js';
import { lexicalAlternationPattern, lexicalQueryTerms, lexicalTermHits } from './lexical-terms.js';

/** Pack artifacts the retired context mode probed for its `hydrated` signal. */
export const LEXICAL_PACK_CANDIDATES: readonly string[] = [
  '.sneakoscope/wiki/code-pack.json',
  '.sneakoscope/wiki/context-pack.json'
];

/** Every lexical hit is a context-pack candidate; a text hit is never an exact reference. */
export const LEXICAL_MATCH_CONFIDENCE: SearchConfidence = 'context_pack';

export interface LexicalSearchLimits {
  /** Files the two providers are allowed to list. Also the per-provider half of the scan budget. */
  readonly maxListedFiles: number;
  readonly maxTextMatches: number;
  /** Hits handed back to the caller, mirroring the graph's own selected-node ceiling. */
  readonly maxResults: number;
  readonly timeoutMs: number;
  /** Charged when a returned file cannot be stat'ed, so a token cost is never silently zero. */
  readonly unknownFileBytes: number;
}

export const DEFAULT_LEXICAL_SEARCH_LIMITS: LexicalSearchLimits = {
  maxListedFiles: 5000,
  maxTextMatches: 500,
  maxResults: 64,
  timeoutMs: 15000,
  unknownFileBytes: 4096
};

export type LexicalMatchChannel = 'caller_path' | 'path_match' | 'text_match' | 'path_and_text_match';

export interface LexicalMatch {
  readonly path: string;
  readonly confidence: SearchConfidence;
  readonly channel: LexicalMatchChannel;
  readonly pathTermHits: number;
  readonly textHits: number;
  /** True when the caller named this path itself (the benchmark's `changedPaths`). */
  readonly seeded: boolean;
  readonly firstLine: number | undefined;
  /** Estimated prompt cost of handing this file to a model, `ceil(bytes / 4)`. */
  readonly tokenCost: number;
}

export interface LexicalSearchInput {
  /**
   * Paths the caller already knows are in play. The benchmark hands the same
   * `changedPaths` to both adapters, so withholding them here would make the
   * control weaker than the candidate for a reason that has nothing to do with
   * retrieval.
   */
  readonly seedPaths?: readonly string[];
  /** Restrict the answer to these workspace-relative roots, mirroring the graph's focus semantics. */
  readonly focusPaths?: readonly string[];
}

export interface LexicalSearchAnswer {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly terms: readonly string[];
  readonly matches: readonly LexicalMatch[];
  /** True when a TriWiki pack artifact exists in the workspace. */
  readonly hydrated: boolean;
  readonly tokenCost: number;
  readonly truncated: boolean;
  readonly timeout: boolean;
  readonly scannedFiles: number;
  readonly scanBudget: number;
  /**
   * Spawn count the search providers themselves declare for this answer, summed
   * the way the retired context mode summed it. The file provider probes
   * `git ls-files` and declares 1 when git actually produced the listing, 0 when
   * it did not; a cached listing carries its original count forward, so this
   * over-reports rather than under-reports on a repeat query.
   *
   * Consequence worth knowing: over a git-initialized workspace this instrument
   * honestly declares spawns, and `project_code_execution_zero` applies to every
   * adapter. Shelling out per query is a real property of the pre-graph path —
   * one the graph answer does not have.
   */
  readonly processSpawns: number;
  /** True when the workspace listing was served from the search provider's in-process cache. */
  readonly cacheHit: boolean;
}

function limitsWith(overrides: Partial<LexicalSearchLimits> | undefined): LexicalSearchLimits {
  const merged = { ...DEFAULT_LEXICAL_SEARCH_LIMITS, ...(overrides ?? {}) };
  return {
    maxListedFiles: Math.max(1, Math.trunc(merged.maxListedFiles)),
    maxTextMatches: Math.max(1, Math.trunc(merged.maxTextMatches)),
    maxResults: Math.max(1, Math.trunc(merged.maxResults)),
    timeoutMs: Math.max(1, Math.trunc(merged.timeoutMs)),
    unknownFileBytes: Math.max(0, Math.trunc(merged.unknownFileBytes))
  };
}

export function lexicalPackPresent(root: string): boolean {
  for (const candidate of LEXICAL_PACK_CANDIDATES) {
    try {
      if (fs.statSync(path.join(root, ...candidate.split('/'))).isFile()) return true;
    } catch {
      // absent or unreadable; try the next candidate
    }
  }
  return false;
}

interface Accumulator {
  pathTermHits: number;
  textHits: number;
  seeded: boolean;
  firstLine: number | undefined;
}

function bucket(into: Map<string, Accumulator>, relativePath: string): Accumulator | null {
  if (!isWorkspaceRelativePosixPath(relativePath)) return null;
  const existing = into.get(relativePath);
  if (existing) return existing;
  const created: Accumulator = { pathTermHits: 0, textHits: 0, seeded: false, firstLine: undefined };
  into.set(relativePath, created);
  return created;
}

function channelOf(entry: Accumulator): LexicalMatchChannel {
  if (entry.pathTermHits === 0 && entry.textHits === 0) return 'caller_path';
  if (entry.pathTermHits > 0 && entry.textHits > 0) return 'path_and_text_match';
  return entry.pathTermHits > 0 ? 'path_match' : 'text_match';
}

/**
 * Rank score. A caller-named path outranks everything, then a path hit outranks
 * a body hit because a file named after the query is the strongest signal a
 * lexical engine has. All three are capped so one enormous file cannot dominate.
 */
function rankScore(entry: Accumulator): number {
  return (entry.seeded ? 64 : 0) + Math.min(entry.pathTermHits, 8) * 3 + Math.min(entry.textHits, 10);
}

/** `focus` matches `candidate` when it is the same path or one of its ancestors. */
function underFocus(candidate: string, focusPaths: readonly string[]): boolean {
  if (!focusPaths.length) return true;
  for (const focus of focusPaths) {
    if (candidate === focus || candidate.startsWith(`${focus}/`)) return true;
  }
  return false;
}

function usableFocusPaths(focusPaths: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of focusPaths ?? []) {
    const normalized = String(raw ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
    if (normalized && isWorkspaceRelativePosixPath(normalized) && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function fileTokenCost(root: string, relativePath: string, fallbackBytes: number): number {
  try {
    const stat = fs.statSync(path.join(root, ...relativePath.split('/')));
    if (stat.isFile()) return estimateTokenCost(stat.size);
  } catch {
    // fall through to the declared default
  }
  return estimateTokenCost(fallbackBytes);
}

/**
 * Path channel: the workspace listing, filtered to paths containing a query
 * term. The listing is requested unfiltered because the provider's own filter
 * is a single whole-string `includes`, which no multi-word question survives.
 */
async function pathChannel(
  root: string,
  terms: readonly string[],
  limits: LexicalSearchLimits,
  into: Map<string, Accumulator>
): Promise<{ scanned: number; truncated: boolean; spawns: number; cacheHit: boolean; errors: readonly string[] }> {
  const response = await searchFilesJs({
    schemaVersion: SEARCH_SCHEMA_VERSION,
    mode: 'files',
    root,
    query: '',
    limits: { maxMatches: limits.maxListedFiles, maxFiles: limits.maxListedFiles, timeoutMs: limits.timeoutMs }
  });
  for (const match of response.matches) {
    const hits = lexicalTermHits(match.path, terms);
    if (hits === 0) continue;
    const entry = bucket(into, match.path);
    if (!entry) continue;
    entry.pathTermHits = Math.max(entry.pathTermHits, hits);
  }
  return {
    scanned: response.scanned.files,
    truncated: response.truncated,
    spawns: response.processSpawns,
    cacheHit: response.cacheHit,
    errors: response.errors
  };
}

/** Text channel: one alternation regex over the same workspace listing. */
async function textChannel(
  root: string,
  terms: readonly string[],
  limits: LexicalSearchLimits,
  into: Map<string, Accumulator>
): Promise<{ scanned: number; truncated: boolean; timeout: boolean; spawns: number; errors: readonly string[] }> {
  const pattern = lexicalAlternationPattern(terms);
  if (!pattern) return { scanned: 0, truncated: false, timeout: false, spawns: 0, errors: [] };
  const response = await searchTextJs({
    schemaVersion: SEARCH_SCHEMA_VERSION,
    mode: 'text',
    root,
    pattern,
    caseSensitive: false,
    limits: { maxMatches: limits.maxTextMatches, maxFiles: limits.maxListedFiles, timeoutMs: limits.timeoutMs }
  });
  for (const match of response.matches) {
    const entry = bucket(into, match.path);
    if (!entry) continue;
    entry.textHits += 1;
    const line = match.line;
    if (typeof line === 'number' && line > 0 && (entry.firstLine === undefined || line < entry.firstLine)) {
      entry.firstLine = line;
    }
  }
  return {
    scanned: response.scanned.files,
    truncated: response.truncated,
    timeout: response.timeout,
    spawns: response.processSpawns,
    errors: response.errors
  };
}

/**
 * Run the merged path + text search. Deterministic: ranked by score, then by
 * codepoint path order, so repeating the same query over the same tree returns
 * a byte-identical answer.
 */
export async function runLexicalContextSearch(
  root: string,
  query: string,
  input: LexicalSearchInput = {},
  overrides?: Partial<LexicalSearchLimits>
): Promise<LexicalSearchAnswer> {
  const limits = limitsWith(overrides);
  const terms = lexicalQueryTerms(query);
  const accumulators = new Map<string, Accumulator>();

  const byPath = await pathChannel(root, terms, limits, accumulators);
  const byText = await textChannel(root, terms, limits, accumulators);
  for (const seedPath of input.seedPaths ?? []) {
    const entry = bucket(accumulators, seedPath);
    if (entry) entry.seeded = true;
  }
  const errors = [...byPath.errors, ...byText.errors];

  const focusPaths = usableFocusPaths(input.focusPaths);
  for (const key of [...accumulators.keys()]) {
    if (!underFocus(key, focusPaths)) accumulators.delete(key);
  }

  const ordered = [...accumulators.entries()].sort((left, right) => {
    const delta = rankScore(right[1]) - rankScore(left[1]);
    if (delta !== 0) return delta;
    return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
  });

  const kept = ordered.slice(0, limits.maxResults);
  const matches: LexicalMatch[] = [];
  let tokenCost = 0;
  for (const [relativePath, entry] of kept) {
    const cost = fileTokenCost(root, relativePath, limits.unknownFileBytes);
    tokenCost += cost;
    matches.push({
      path: relativePath,
      confidence: LEXICAL_MATCH_CONFIDENCE,
      channel: channelOf(entry),
      pathTermHits: entry.pathTermHits,
      textHits: entry.textHits,
      seeded: entry.seeded,
      firstLine: entry.firstLine,
      tokenCost: cost
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    terms,
    matches,
    hydrated: lexicalPackPresent(root),
    tokenCost,
    truncated: byPath.truncated || byText.truncated || ordered.length > kept.length,
    timeout: byText.timeout,
    scannedFiles: byPath.scanned + byText.scanned,
    scanBudget: limits.maxListedFiles * 2,
    processSpawns: byPath.spawns + byText.spawns,
    cacheHit: byPath.cacheHit
  };
}
