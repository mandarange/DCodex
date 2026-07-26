/**
 * Seed acquisition for the graph-backed `context` search mode.
 *
 * `searchContext()` answers from the Context Graph. The only remaining job of
 * lexical matching is to decide *where in the graph to start*, and that job lives
 * here — this file is the single place in the context path where a text-shaped
 * match is produced at all. Three channels run against the already-loaded
 * in-memory index, so seeding costs no file I/O and no process spawn:
 *
 *   symbol -> a node-id or label hit; keeps the kind's real confidence
 *             (`exact_definition` for a symbol, `manifest` for a command/gate/route,
 *             `exact_reference` otherwise)
 *   path   -> an exact workspace-relative path, or a basename hit; always `file_path`
 *   text   -> a bounded substring sweep; always `text_candidate`
 *
 * A seed never leaves this file carrying more confidence than the evidence that
 * produced it. A text hit stays `text_candidate` from here all the way into the
 * answer, which is what keeps `search context` from reporting a guess as a fact.
 */
import path from 'node:path';
import type { ContextGraphIndex } from '../triwiki/context-graph/graph-index.js';
import { compareContextGraphIds } from '../triwiki/context-graph/ids.js';
import { isWorkspaceRelativePosixPath } from '../triwiki/context-graph/paths.js';
import { CONTEXT_GRAPH_TRAVERSAL_CAPS } from '../triwiki/context-graph/profiles.js';
import type { ContextGraphSeed, ContextGraphSeedConfidence } from '../triwiki/context-graph/query-types.js';
import {
  CONTEXT_GRAPH_RANKING_CONFIG,
  contextGraphSeedConfidenceScore,
  isExactContextGraphSeedConfidence,
  type ContextGraphRankingConfig
} from '../triwiki/context-graph/query/ranking-config.js';
import { normalizeContextGraphQuery, seedConfidenceFor } from '../triwiki/context-graph/query/seeds.js';

/** Which acquisition channel produced a seed. Reported per seed, never collapsed. */
export type ContextGraphSeedChannel = 'symbol' | 'path' | 'text';

export interface AcquiredContextGraphSeed extends ContextGraphSeed {
  readonly channel: ContextGraphSeedChannel;
}

export interface ContextGraphSeedAcquisition {
  readonly seeds: AcquiredContextGraphSeed[];
  /** Seeds kept, per channel. */
  readonly counts: Readonly<Record<ContextGraphSeedChannel, number>>;
  /** Seeds whose confidence denotes a real reference rather than a text guess. */
  readonly exactSeeds: number;
  /** Index keys inspected by the basename pass and the text sweep combined. */
  readonly scannedKeys: number;
  readonly scanBudgetExhausted: boolean;
  readonly tokens: readonly string[];
}

export interface AcquireContextGraphSeedsInput {
  readonly index: ContextGraphIndex;
  readonly query: string;
  /** Restrict seeding to these workspace-relative paths, when the caller supplied any. */
  readonly focusPaths?: readonly string[] | undefined;
  readonly maxSeeds?: number | undefined;
  readonly config?: ContextGraphRankingConfig | undefined;
}

/** Keys the basename pass and the text sweep may touch before they stop and say so. */
const SEED_SCAN_BUDGET = 20_000;

const GLOB_META = /[*?[\]{}!]/;

/**
 * Workspace-relative paths usable as a traversal focus. Glob patterns are dropped
 * rather than half-interpreted: the graph focus is a path prefix test, not a matcher.
 */
export function contextGraphFocusPaths(patterns: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of patterns ?? []) {
    const candidate = String(raw ?? '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!candidate || GLOB_META.test(candidate)) continue;
    if (!isWorkspaceRelativePosixPath(candidate)) continue;
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

interface SeedDraft {
  nodeId: string;
  confidence: ContextGraphSeedConfidence;
  channel: ContextGraphSeedChannel;
  score: number;
  path?: string;
  line?: number;
}

class SeedTable {
  private readonly drafts = new Map<string, SeedDraft>();

  constructor(
    private readonly index: ContextGraphIndex,
    private readonly config: ContextGraphRankingConfig,
    private readonly focusPaths: readonly string[]
  ) {}

  has(nodeId: string): boolean {
    return this.drafts.has(nodeId);
  }

  get size(): number {
    return this.drafts.size;
  }

  exactCount(): number {
    let count = 0;
    for (const draft of this.drafts.values()) {
      if (isExactContextGraphSeedConfidence(draft.confidence)) count += 1;
    }
    return count;
  }

  add(nodeId: string, confidence: ContextGraphSeedConfidence, channel: ContextGraphSeedChannel): void {
    const node = this.index.nodesById.get(nodeId);
    if (!node) return;
    if (this.focusPaths.length > 0 && !underFocus(node.path, this.focusPaths)) return;
    const score = contextGraphSeedConfidenceScore(this.config, confidence);
    const existing = this.drafts.get(nodeId);
    if (existing && existing.score >= score) return;
    this.drafts.set(nodeId, {
      nodeId,
      confidence,
      channel,
      score,
      ...(node.path === undefined ? {} : { path: node.path }),
      ...(node.locator?.line === undefined ? {} : { line: node.locator.line })
    });
  }

  /** Highest confidence first, ties broken on the one shared codepoint comparator. */
  ranked(limit: number): SeedDraft[] {
    return [...this.drafts.values()]
      .sort((left, right) => right.score - left.score || compareContextGraphIds(left.nodeId, right.nodeId))
      .slice(0, Math.max(0, limit));
  }
}

function underFocus(nodePath: string | undefined, focusPaths: readonly string[]): boolean {
  if (!nodePath) return false;
  return focusPaths.some((focus) => nodePath === focus || nodePath.startsWith(`${focus}/`));
}

/** A node-id or label hit. The node's kind decides the confidence; nothing is upgraded. */
function addSymbolSeeds(table: SeedTable, index: ContextGraphIndex, token: string, perToken: number): void {
  const direct = index.nodesById.get(token);
  if (direct) table.add(direct.id, seedConfidenceFor(direct.kind, 'node_id'), 'symbol');

  for (const id of (index.nodesByLabel.get(token.toLowerCase()) ?? []).slice(0, perToken)) {
    const node = index.nodesById.get(id);
    if (node) table.add(node.id, seedConfidenceFor(node.kind, 'label'), 'symbol');
  }
}

/** An exact workspace-relative path hit. Always `file_path`, never a definition. */
function addExactPathSeeds(table: SeedTable, index: ContextGraphIndex, token: string, perToken: number): void {
  const candidate = token.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!candidate.includes('/') || !isWorkspaceRelativePosixPath(candidate)) return;
  for (const id of (index.nodesByPath.get(candidate) ?? []).slice(0, perToken)) {
    table.add(id, 'file_path', 'path');
  }
}

/**
 * One pass over the path keys, matching a bare `service.ts`-shaped token against
 * the basename. Still a path match rather than a text guess, so it stays `file_path`.
 */
function addBasenameSeeds(
  table: SeedTable,
  index: ContextGraphIndex,
  tokens: readonly string[],
  perToken: number,
  budget: { scanned: number; exhausted: boolean }
): void {
  const wanted = new Set<string>();
  for (const token of tokens) {
    if (token.includes('/') || !token.includes('.')) continue;
    wanted.add(token.toLowerCase());
  }
  if (wanted.size === 0) return;

  let added = 0;
  for (const key of index.nodesByPath.keys()) {
    if (budget.scanned >= SEED_SCAN_BUDGET) {
      budget.exhausted = true;
      return;
    }
    budget.scanned += 1;
    const base = key.slice(key.lastIndexOf('/') + 1).toLowerCase();
    if (!wanted.has(base)) continue;
    for (const id of (index.nodesByPath.get(key) ?? []).slice(0, perToken)) {
      table.add(id, 'file_path', 'path');
      added += 1;
    }
    if (added >= perToken * wanted.size) return;
  }
}

/**
 * Bounded substring sweep over label and path keys. This is the only unbounded-shaped
 * scan in seeding, so it is capped, it reports how many keys it touched, and every
 * hit it produces stays `text_candidate`.
 */
function addTextSeeds(
  table: SeedTable,
  index: ContextGraphIndex,
  lowerTokens: readonly string[],
  config: ContextGraphRankingConfig,
  budget: { scanned: number; exhausted: boolean }
): void {
  const needles = lowerTokens.filter((token) => token.length >= config.lexicalMinTokenLength);
  if (needles.length === 0) return;

  const hits: string[] = [];
  const sweep = (keys: Iterable<string>, idsOf: (key: string) => readonly string[]): boolean => {
    for (const key of keys) {
      if (budget.scanned >= SEED_SCAN_BUDGET) {
        budget.exhausted = true;
        return false;
      }
      budget.scanned += 1;
      const lower = key.toLowerCase();
      if (!needles.some((needle) => lower.includes(needle))) continue;
      for (const id of idsOf(key)) hits.push(id);
    }
    return true;
  };

  if (sweep(index.nodesByLabel.keys(), (key) => index.nodesByLabel.get(key) ?? [])) {
    sweep(index.nodesByPath.keys(), (key) => index.nodesByPath.get(key) ?? []);
  }

  const ordered = [...new Set(hits)].sort(compareContextGraphIds).slice(0, config.maxLexicalSeeds);
  for (const id of ordered) {
    if (table.has(id)) continue;
    table.add(id, 'text_candidate', 'text');
  }
}

function toSeed(draft: SeedDraft): AcquiredContextGraphSeed {
  // `origin` stays honest: only the text channel is lexical. `score` is omitted so
  // the query engine applies its own configured weight for the confidence.
  return {
    nodeId: draft.nodeId,
    confidence: draft.confidence,
    origin: draft.channel === 'text' ? 'lexical' : 'exact',
    channel: draft.channel,
    ...(draft.path === undefined ? {} : { path: draft.path }),
    ...(draft.line === undefined ? {} : { line: draft.line })
  };
}

/**
 * Resolve query seeds against a loaded snapshot index. Pure and spawn-free: every
 * lookup is a map hit or a bounded pass over index keys, so this stays cheap even
 * on a snapshot with tens of thousands of nodes.
 */
export function acquireContextGraphSeeds(input: AcquireContextGraphSeedsInput): ContextGraphSeedAcquisition {
  const config = input.config ?? CONTEXT_GRAPH_RANKING_CONFIG;
  const index = input.index;
  const focusPaths = contextGraphFocusPaths(input.focusPaths);
  const normalized = normalizeContextGraphQuery(input.query, config);
  const table = new SeedTable(index, config, focusPaths);
  const budget = { scanned: 0, exhausted: false };
  const perToken = config.maxSeedsPerToken;

  for (const focus of focusPaths) {
    for (const id of (index.nodesByPath.get(focus) ?? []).slice(0, perToken)) {
      table.add(id, 'file_path', 'path');
    }
  }
  for (const token of normalized.tokens) {
    addSymbolSeeds(table, index, token, perToken);
    addExactPathSeeds(table, index, token, perToken);
  }
  addBasenameSeeds(table, index, normalized.tokens, perToken, budget);

  // The text sweep is a last resort, exactly as in the query kernel: it only runs
  // when exact resolution did not produce enough places to start from.
  if (table.exactCount() < config.minExactSeeds) {
    addTextSeeds(table, index, normalized.lowerTokens, config, budget);
  }

  const maxSeeds = Math.max(0, input.maxSeeds ?? CONTEXT_GRAPH_TRAVERSAL_CAPS.maxSeeds);
  const seeds = table.ranked(maxSeeds).map(toSeed);
  const counts: Record<ContextGraphSeedChannel, number> = { symbol: 0, path: 0, text: 0 };
  let exactSeeds = 0;
  for (const seed of seeds) {
    counts[seed.channel] += 1;
    if (isExactContextGraphSeedConfidence(seed.confidence)) exactSeeds += 1;
  }

  return {
    seeds,
    counts,
    exactSeeds,
    scannedKeys: budget.scanned,
    scanBudgetExhausted: budget.exhausted,
    tokens: normalized.tokens
  };
}

/** Workspace-relative POSIX form of an arbitrary path-ish string, or `null`. */
export function workspaceRelativeSeedPath(value: string): string | null {
  const candidate = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!candidate || path.posix.isAbsolute(candidate)) return null;
  return isWorkspaceRelativePosixPath(candidate) ? candidate : null;
}
