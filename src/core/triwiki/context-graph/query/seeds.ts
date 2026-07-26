/**
 * Query normalization and seed resolution.
 *
 * Seeding is exact-first by construction: node ids, workspace-relative paths,
 * symbol/command/gate/route/pipeline/schema labels and claim hashes are resolved
 * through O(1) index lookups. A lexical sweep only runs when those produce fewer
 * than `minExactSeeds` seeds, it is bounded by an explicit scan budget, and every
 * seed it produces stays `text_candidate` / `lexical`. A text hit therefore never
 * reaches a consumer labelled as an exact reference.
 */
import type { ContextGraphNodeKind } from '../contracts.js';
import type { ContextGraphIndex } from '../graph-index.js';
import { compareContextGraphIds, contextGraphNodeId, type NodeIdentityInput } from '../ids.js';
import { isWorkspaceRelativePosixPath } from '../paths.js';
import type {
  ContextGraphQueryRequest,
  ContextGraphSeed,
  ContextGraphSeedConfidence,
  ContextGraphSeedOrigin
} from '../query-types.js';
import {
  contextGraphSeedConfidenceScore,
  isExactContextGraphSeedConfidence,
  type ContextGraphRankingConfig
} from './ranking-config.js';

export interface NormalizedContextGraphQuery {
  readonly normalized: string;
  /** Deduped, capped tokens in first-seen order. */
  readonly tokens: readonly string[];
  readonly lowerTokens: readonly string[];
}

export interface ContextGraphSeedResolution {
  readonly seeds: ContextGraphSeed[];
  readonly exactSeedCount: number;
  readonly lexicalSeedCount: number;
  readonly providedSeedCount: number;
  /** Caller-supplied seeds whose node id is not in the snapshot. */
  readonly unknownProvidedSeeds: number;
  /** Seeds discarded because the seed cap was reached. */
  readonly droppedSeeds: number;
  readonly scannedKeys: number;
  readonly scanBudgetExhausted: boolean;
  readonly query: NormalizedContextGraphQuery;
}

const TOKEN_PATTERN = /[A-Za-z0-9_$@#./:-]+/g;
const TRIM_PATTERN = /^[.:/-]+|[.:/-]+$/g;

/** Node kinds whose canonical id can be rebuilt from a single bare token. */
const PROBE_KINDS: readonly ContextGraphNodeKind[] = [
  'file',
  'module',
  'command',
  'route',
  'pipeline',
  'gate',
  'schema',
  'wiki_claim',
  'source',
  'proof',
  'risk_domain'
];

function probeIdentity(kind: ContextGraphNodeKind, token: string): NodeIdentityInput | null {
  switch (kind) {
    case 'file':
      return { kind: 'file', path: token };
    case 'module':
      return { kind: 'module', moduleId: token };
    case 'command':
      return { kind: 'command', name: token };
    case 'route':
      return { kind: 'route', name: token };
    case 'pipeline':
      return { kind: 'pipeline', pipelineId: token };
    case 'gate':
      return { kind: 'gate', gateId: token };
    case 'schema':
      return { kind: 'schema', schemaId: token };
    case 'wiki_claim':
      return { kind: 'wiki_claim', claimHash: token };
    case 'source':
      return { kind: 'source', sourceHash: token };
    case 'proof':
      return { kind: 'proof', proofId: token };
    case 'risk_domain':
      return { kind: 'risk_domain', domain: token };
    default:
      return null;
  }
}

const MANIFEST_KINDS: ReadonlySet<ContextGraphNodeKind> = new Set<ContextGraphNodeKind>([
  'command',
  'gate',
  'route',
  'pipeline',
  'schema'
]);

const PATH_KINDS: ReadonlySet<ContextGraphNodeKind> = new Set<ContextGraphNodeKind>(['file', 'test', 'config']);

export type ContextGraphSeedMatch = 'node_id' | 'path' | 'label';

/**
 * Confidence for a resolved seed. A symbol matched by name is a definition, a
 * manifest entity is `manifest`, a path hit is `file_path`; everything else that
 * resolved exactly is an `exact_reference`.
 */
export function seedConfidenceFor(kind: ContextGraphNodeKind, match: ContextGraphSeedMatch): ContextGraphSeedConfidence {
  if (match === 'path') return 'file_path';
  if (kind === 'symbol') return 'exact_definition';
  if (MANIFEST_KINDS.has(kind)) return 'manifest';
  if (PATH_KINDS.has(kind)) return 'file_path';
  return 'exact_reference';
}

export function normalizeContextGraphQuery(
  query: string,
  config: ContextGraphRankingConfig
): NormalizedContextGraphQuery {
  const normalized = String(query ?? '').normalize('NFKC').trim();
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const raw of normalized.match(TOKEN_PATTERN) ?? []) {
    const token = raw.replace(TRIM_PATTERN, '');
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= config.maxQueryTokens) break;
  }
  return { normalized, tokens, lowerTokens: tokens.map((token) => token.toLowerCase()) };
}

interface SeedDraft {
  nodeId: string;
  confidence: ContextGraphSeedConfidence;
  origin: ContextGraphSeedOrigin;
  score: number;
  path?: string;
  line?: number;
}

class SeedCollector {
  readonly drafts = new Map<string, SeedDraft>();

  constructor(
    private readonly index: ContextGraphIndex,
    private readonly config: ContextGraphRankingConfig
  ) {}

  add(nodeId: string, confidence: ContextGraphSeedConfidence, origin: ContextGraphSeedOrigin, score?: number): void {
    const node = this.index.nodesById.get(nodeId);
    if (!node) return;
    const resolved = score ?? contextGraphSeedConfidenceScore(this.config, confidence);
    const existing = this.drafts.get(nodeId);
    if (existing && existing.score >= resolved) return;
    const draft: SeedDraft = {
      nodeId,
      confidence,
      origin,
      score: resolved,
      ...(node.path === undefined ? {} : { path: node.path }),
      ...(node.locator?.line === undefined ? {} : { line: node.locator.line })
    };
    this.drafts.set(nodeId, draft);
  }
}

function addExactSeedsForToken(collector: SeedCollector, index: ContextGraphIndex, token: string, config: ContextGraphRankingConfig): void {
  const direct = index.nodesById.get(token);
  if (direct) collector.add(direct.id, seedConfidenceFor(direct.kind, 'node_id'), 'exact');

  for (const kind of PROBE_KINDS) {
    const identity = probeIdentity(kind, token);
    if (!identity) continue;
    let probed: string;
    try {
      probed = contextGraphNodeId(identity);
    } catch {
      continue;
    }
    const node = index.nodesById.get(probed);
    if (node) collector.add(node.id, seedConfidenceFor(node.kind, 'node_id'), 'exact');
  }

  const candidatePath = token.replace(/^\.\//, '');
  if (isWorkspaceRelativePosixPath(candidatePath)) {
    // File-shaped nodes claim the slots first; whatever is left goes to the other
    // nodes that genuinely live at that exact path (symbols, config keys), which
    // is still a path match rather than a text guess.
    const atPath = index.nodesByPath.get(candidatePath) ?? [];
    let added = 0;
    for (const pass of [true, false]) {
      for (const id of atPath) {
        if (added >= config.maxSeedsPerToken) break;
        const node = index.nodesById.get(id);
        if (!node || PATH_KINDS.has(node.kind) !== pass) continue;
        collector.add(node.id, 'file_path', 'exact');
        added += 1;
      }
    }
  }

  const byLabel = index.nodesByLabel.get(token.toLowerCase()) ?? [];
  for (const id of byLabel.slice(0, config.maxSeedsPerToken)) {
    const node = index.nodesById.get(id);
    if (node) collector.add(node.id, seedConfidenceFor(node.kind, 'label'), 'exact');
  }
}

interface LexicalSweep {
  scanned: number;
  budgetExhausted: boolean;
  added: number;
}

/**
 * Bounded substring sweep over label and path keys. This is the only scan in the
 * engine that is not seed-relative, so it is capped by `lexicalScanBudget` and
 * reports how many keys it touched; it never upgrades a hit above `text_candidate`.
 */
function sweepLexicalSeeds(
  collector: SeedCollector,
  index: ContextGraphIndex,
  query: NormalizedContextGraphQuery,
  config: ContextGraphRankingConfig
): LexicalSweep {
  const needles = query.lowerTokens.filter((token) => token.length >= config.lexicalMinTokenLength);
  const sweep: LexicalSweep = { scanned: 0, budgetExhausted: false, added: 0 };
  if (needles.length === 0) return sweep;

  const hits: string[] = [];
  const consider = (keys: Iterable<string>, idsOf: (key: string) => readonly string[]): void => {
    for (const key of keys) {
      if (sweep.scanned >= config.lexicalScanBudget) {
        sweep.budgetExhausted = true;
        return;
      }
      sweep.scanned += 1;
      const lower = key.toLowerCase();
      if (!needles.some((needle) => lower.includes(needle))) continue;
      for (const id of idsOf(key)) hits.push(id);
    }
  };

  consider(index.nodesByLabel.keys(), (key) => index.nodesByLabel.get(key) ?? []);
  if (!sweep.budgetExhausted) consider(index.nodesByPath.keys(), (key) => index.nodesByPath.get(key) ?? []);

  const ordered = [...new Set(hits)].sort(compareContextGraphIds).slice(0, config.maxLexicalSeeds);
  for (const id of ordered) {
    if (collector.drafts.has(id)) continue;
    collector.add(id, 'text_candidate', 'lexical', config.lexicalMatchScore);
    sweep.added += 1;
  }
  return sweep;
}

function toSeed(draft: SeedDraft): ContextGraphSeed {
  return {
    nodeId: draft.nodeId,
    confidence: draft.confidence,
    origin: draft.origin,
    score: draft.score,
    ...(draft.path === undefined ? {} : { path: draft.path }),
    ...(draft.line === undefined ? {} : { line: draft.line })
  };
}

export interface ResolveSeedsInput {
  readonly index: ContextGraphIndex;
  readonly request: ContextGraphQueryRequest;
  readonly config: ContextGraphRankingConfig;
  readonly maxSeeds: number;
}

export function resolveContextGraphSeeds(input: ResolveSeedsInput): ContextGraphSeedResolution {
  const { index, request, config, maxSeeds } = input;
  const query = normalizeContextGraphQuery(request.query, config);
  const collector = new SeedCollector(index, config);

  let unknownProvidedSeeds = 0;
  let providedSeedCount = 0;
  for (const seed of request.seeds ?? []) {
    if (!index.nodesById.has(seed.nodeId)) {
      unknownProvidedSeeds += 1;
      continue;
    }
    const score = seed.score === undefined
      ? contextGraphSeedConfidenceScore(config, seed.confidence)
      : Math.min(seed.score, config.providedSeedScoreCeiling);
    collector.add(seed.nodeId, seed.confidence, seed.origin ?? 'provided', score);
    providedSeedCount += 1;
  }

  for (const focus of request.focusPaths ?? []) {
    const normalized = String(focus ?? '').replace(/^\.\//, '');
    if (!isWorkspaceRelativePosixPath(normalized)) continue;
    for (const id of (index.nodesByPath.get(normalized) ?? []).slice(0, config.maxSeedsPerToken)) {
      collector.add(id, 'file_path', 'exact');
    }
  }

  for (const token of query.tokens) addExactSeedsForToken(collector, index, token, config);

  let exactSeedCount = 0;
  for (const draft of collector.drafts.values()) {
    if (isExactContextGraphSeedConfidence(draft.confidence)) exactSeedCount += 1;
  }

  let sweep: LexicalSweep = { scanned: 0, budgetExhausted: false, added: 0 };
  if (exactSeedCount < config.minExactSeeds) sweep = sweepLexicalSeeds(collector, index, query, config);

  const ranked = [...collector.drafts.values()].sort(
    (left, right) => right.score - left.score || compareContextGraphIds(left.nodeId, right.nodeId)
  );
  const kept = ranked.slice(0, Math.max(0, maxSeeds));
  const seeds = kept.map(toSeed);

  return {
    seeds,
    exactSeedCount: seeds.filter((seed) => isExactContextGraphSeedConfidence(seed.confidence)).length,
    lexicalSeedCount: seeds.filter((seed) => seed.origin === 'lexical').length,
    providedSeedCount,
    unknownProvidedSeeds,
    droppedSeeds: Math.max(0, ranked.length - kept.length),
    scannedKeys: sweep.scanned,
    scanBudgetExhausted: sweep.budgetExhausted,
    query
  };
}
