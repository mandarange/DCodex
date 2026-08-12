/**
 * Normalize once, then resolve the plan once (CG2-07).
 *
 * Everything a lane needs to decide *what* to read is computed here and handed
 * down. A lane that re-derived the profile mask, the depth cap, or the term list
 * would be a second opinion about the same query, and two opinions is how the v1
 * engine ended up normalizing the query string in three places.
 *
 * The query is normalized by `normalizeLexiconQuery` and by nothing else. A
 * query term and a document term must be the same string *by construction*: a
 * second normalizer here would drift from the tokenizer that compiled the index
 * and the two would silently stop matching.
 *
 * The anchor lane needs the query verbatim, not tokenized — `gate:release:proof`
 * is one canonical id, and the tokenizer's job is to split it. So the anchor
 * terms are whitespace runs of the *normalizer's own* `normalized` output, which
 * keeps the single-normalization rule intact while preserving the raw shape.
 */
import { CONTEXT_GRAPH_EDGE_TYPES, type ContextGraphEdgeType } from '../contracts.js';
import { isWorkspaceRelativePosixPath } from '../paths.js';
import {
  CONTEXT_GRAPH_QUERY_PROFILE_NAMES,
  CONTEXT_GRAPH_TRAVERSAL_CAPS,
  contextGraphQueryProfile,
} from '../profiles.js';
import { CONTEXT_INDEX_FIXED_POINT_SCALE, toFixedPoint } from '../runtime-index/format.js';
import { CONFIDENCE_CODES } from '../runtime-index/reader-layout.js';
import { CONTEXT_LEXICON_FIELD, lexiconFieldMask, normalizeLexiconQuery } from '../runtime-index/lexicon.js';
import type { ContextIndexReader } from '../runtime-index/reader.js';
import {
  CONTEXT_GRAPH_KERNEL_CONFIG,
  CONTEXT_GRAPH_LEXICON_CONFIG,
  CONTEXT_GRAPH_RANKING_CONFIG,
  type ContextGraphKernelConfig,
  type ContextGraphRankingConfig,
} from './ranking-config.js';
import {
  LANE_COUNT,
  LANE_SLOT,
  RETRIEVAL_LANES,
  addOmission,
  type KernelClock,
  type KernelOmissions,
  type KernelRequest,
  type QueryPlan,
  type QueryShape,
} from './kernel-types.js';

/** The safety closure's relations, fixed by §7.4 rather than by the profile. */
export const KERNEL_SAFETY_EDGE_TYPES: readonly ContextGraphEdgeType[] = Object.freeze([
  'tests',
  'verified_by',
  'gated_by',
  'affected_by',
  'invalidates',
  'conflicts_with',
] as const);

/** The subset of the safety relations that report a conflict, for `conflictRecall`. */
export const KERNEL_CONFLICT_EDGE_TYPES: readonly ContextGraphEdgeType[] = Object.freeze([
  'invalidates',
  'conflicts_with',
] as const);

export interface KernelPlanOptions {
  readonly config?: ContextGraphRankingConfig;
  readonly kernelConfig?: ContextGraphKernelConfig;
  /** Required. The kernel never reads the wall clock itself. */
  readonly clock: KernelClock;
}

/**
 * The plan plus the derived integer tables the hot path indexes into. They are
 * built once here because they are pure functions of the profile: rebuilding
 * them per visited node is how a "cheap lookup" becomes the traversal's cost.
 */
export interface KernelPlanContext {
  readonly plan: QueryPlan;
  readonly config: ContextGraphRankingConfig;
  readonly kernelConfig: ContextGraphKernelConfig;
  readonly normalizedQuery: string;
  readonly terms: readonly string[];
  /** Verbatim whitespace runs; the anchor lane resolves ids, not word pieces. */
  readonly anchorTerms: readonly string[];
  readonly focusPaths: readonly string[];
  readonly highRisk: boolean;
  readonly maxSelected: number;
  readonly startedAt: number;
  readonly deadline: number | null;
  readonly clock: KernelClock;
  /** Fixed-point profile weight per edge-type code; `0` means never traversed. */
  readonly edgeWeights: Int32Array;
  /** Bit per edge-type code the profile traverses. 21 types fit one word. */
  readonly edgeTypeMask: number;
  readonly safetyEdgeMask: number;
  readonly conflictEdgeMask: number;
  /** Fixed-point multiplier per edge-confidence code. */
  readonly confidenceMultipliers: Int32Array;
  /** Fixed-point lane weight, indexed by `LANE_SLOT`. */
  readonly laneWeights: Int32Array;
  /** Fixed-point `1/(k + rank)` by zero-based rank; past the cap it is 0. */
  readonly rrf: Int32Array;
  readonly warnings: string[];
  readonly omissions: KernelOmissions;
}

const SCALE = CONTEXT_INDEX_FIXED_POINT_SCALE;

/**
 * A token that names something rather than describing it: a canonical id, a
 * path, or a dotted basename. This is a shape test on the raw token, never a
 * lookup, so it costs nothing and cannot be fooled into an exact claim by a
 * strong text match.
 */
function isAnchorShapedToken(token: string): boolean {
  if (token.length === 0) return false;
  if (token.includes(':') || token.includes('/') || token.includes('#')) return true;
  const dot = token.lastIndexOf('.');
  return dot > 0 && dot < token.length - 1;
}

function classifyShape(
  anchorShaped: number,
  termCount: number,
  kernelConfig: ContextGraphKernelConfig,
): QueryShape {
  if (anchorShaped > 0 && termCount <= kernelConfig.anchoredMaxTerms) return 'anchored';
  if (anchorShaped === 0 && termCount >= kernelConfig.naturalMinTerms) return 'natural';
  return anchorShaped > 0 ? 'mixed' : 'natural';
}

/**
 * §4.2: an anchored query does not need the free-text fields, and letting it
 * read them is how a canonical id starts matching prose. A natural query cannot
 * use the canonical-id field at all — that field is the anchor lane's, and it is
 * not tokenized precisely so a word overlap can never reach it.
 */
function fieldMaskFor(shape: QueryShape): number {
  const anchorFields =
    lexiconFieldMask(CONTEXT_LEXICON_FIELD.EXACT_LABEL)
    | lexiconFieldMask(CONTEXT_LEXICON_FIELD.MANIFEST_NAME)
    | lexiconFieldMask(CONTEXT_LEXICON_FIELD.BASENAME)
    | lexiconFieldMask(CONTEXT_LEXICON_FIELD.PATH_SEGMENT);
  const textFields =
    lexiconFieldMask(CONTEXT_LEXICON_FIELD.SYMBOL_SEGMENT)
    | lexiconFieldMask(CONTEXT_LEXICON_FIELD.PURPOSE)
    | lexiconFieldMask(CONTEXT_LEXICON_FIELD.EVIDENCE)
    | lexiconFieldMask(CONTEXT_LEXICON_FIELD.COARSE);
  if (shape === 'anchored') return anchorFields;
  if (shape === 'natural') return anchorFields | textFields;
  return anchorFields | textFields;
}

function profileMaskFor(profile: string): number {
  const position = CONTEXT_GRAPH_QUERY_PROFILE_NAMES.indexOf(profile as never);
  // A zero mask selects nothing, so an unrecognized profile must not produce
  // one: the reader would return an empty traversal that looks like an empty
  // graph. `contextGraphQueryProfile` has already defaulted the name by here.
  return position < 0 ? 1 : (1 << position) >>> 0;
}

function usableFocusPaths(request: KernelRequest, omissions: KernelOmissions): string[] {
  const out: string[] = [];
  for (const focus of request.focusPaths ?? []) {
    const normalized = String(focus ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
    if (normalized === '' || !isWorkspaceRelativePosixPath(normalized)) {
      addOmission(omissions, 'focus_filtered', 1);
      continue;
    }
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function edgeTables(
  profile: ReturnType<typeof contextGraphQueryProfile>,
): { weights: Int32Array; mask: number } {
  const weights = new Int32Array(CONTEXT_GRAPH_EDGE_TYPES.length);
  let mask = 0;
  CONTEXT_GRAPH_EDGE_TYPES.forEach((type, code) => {
    const weight = profile.edgeWeights[type] ?? 0;
    if (weight <= 0) return;
    weights[code] = toFixedPoint(weight, SCALE);
    mask |= (1 << code) >>> 0;
  });
  return { weights, mask };
}

function edgeTypeMaskOf(types: readonly ContextGraphEdgeType[]): number {
  let mask = 0;
  for (const type of types) {
    const code = CONTEXT_GRAPH_EDGE_TYPES.indexOf(type);
    if (code >= 0) mask |= (1 << code) >>> 0;
  }
  return mask;
}

function rrfTable(kernelConfig: ContextGraphKernelConfig): Int32Array {
  const table = new Int32Array(kernelConfig.rrfRankCap);
  for (let rank = 0; rank < table.length; rank += 1) {
    table[rank] = Math.round((SCALE * SCALE) / (kernelConfig.rrfK + rank + 1));
  }
  return table;
}

/**
 * A query touching a protected node, or a caller asking for high risk, gets the
 * deeper profile depth *and* the safety closure. Risk is taken from the request
 * and from the anchor seeds' own flags — never guessed from the query text,
 * because a guess that misses is a protected gate that never gets reserved.
 */
export function resolveQueryPlan(
  reader: ContextIndexReader,
  request: KernelRequest,
  options: KernelPlanOptions,
): KernelPlanContext {
  const config = options.config ?? CONTEXT_GRAPH_RANKING_CONFIG;
  const kernelConfig = options.kernelConfig ?? CONTEXT_GRAPH_KERNEL_CONFIG;
  const caps = CONTEXT_GRAPH_TRAVERSAL_CAPS;
  const profile = contextGraphQueryProfile(request.profile);
  const warnings: string[] = [];
  const omissions: KernelOmissions = {};

  const normalization = normalizeLexiconQuery(request.query, CONTEXT_GRAPH_LEXICON_CONFIG);
  const anchorTerms: string[] = [];
  let anchorShaped = 0;
  for (const raw of normalization.normalized.split(/\s+/)) {
    const token = raw.replace(/[,;]+$/, '');
    if (token === '' || anchorTerms.includes(token)) continue;
    anchorTerms.push(token);
    if (isAnchorShapedToken(token)) anchorShaped += 1;
  }
  // The whole query is itself an anchor candidate: a pasted path with no spaces
  // is one token already, but a label like `release proof` is not.
  if (normalization.normalized !== '' && !anchorTerms.includes(normalization.normalized)) {
    anchorTerms.unshift(normalization.normalized);
  }
  if (normalization.omissions.redactedSpans > 0) {
    warnings.push('an absolute path in the query was redacted before it reached the index');
  }

  const shape = classifyShape(anchorShaped, normalization.terms.length, kernelConfig);
  const highRisk = request.risk === 'high';
  const termIds: number[] = [];
  // Resolved once per distinct term, not once per lane: the lookup is a binary
  // search with a UTF-8 decode per probe, and the lexical and coarse lanes share
  // one dictionary.
  for (const term of normalization.terms) {
    const id = reader.termId(term);
    if (id >= 0) termIds.push(id);
  }

  const postingMultiplier = shape === 'anchored' ? 1 : kernelConfig.textShapePostingMultiplier;
  const plan: QueryPlan = Object.freeze({
    profile: profile.name,
    shape,
    termIds: Object.freeze(termIds),
    fieldMask: fieldMaskFor(shape),
    profileMask: profileMaskFor(profile.name),
    maxDepth: highRisk ? profile.maxDepthHighRisk : profile.maxDepth,
    frontierBudget: kernelConfig.frontierBudget,
    postingCapPerTerm: CONTEXT_GRAPH_LEXICON_CONFIG.postingCapPerTerm * postingMultiplier,
    candidateBudget: kernelConfig.candidateBudget,
    tokenBudget: Math.max(0, request.tokenBudget ?? caps.defaultTokenBudget),
  });

  const edges = edgeTables(profile);
  const confidenceMultipliers = new Int32Array(CONFIDENCE_CODES.length);
  CONFIDENCE_CODES.forEach((confidence, code) => {
    confidenceMultipliers[code] = toFixedPoint(config.edgeConfidenceMultiplier[confidence] ?? 0, SCALE);
  });
  const laneWeights = new Int32Array(LANE_COUNT);
  const mix = kernelConfig.laneWeights[profile.name];
  RETRIEVAL_LANES.forEach((lane) => {
    laneWeights[LANE_SLOT[lane]] = toFixedPoint(mix[lane], SCALE);
  });

  const startedAt = options.clock();
  const timeoutMs = Math.max(0, request.timeoutMs ?? caps.queryTimeoutMs);

  return {
    plan,
    config,
    kernelConfig,
    normalizedQuery: normalization.normalized,
    terms: normalization.terms,
    anchorTerms,
    focusPaths: usableFocusPaths(request, omissions),
    highRisk,
    maxSelected: Math.max(0, Math.min(request.maxSelected ?? caps.maxSelectedNodes, caps.maxSelectedNodes)),
    startedAt,
    deadline: timeoutMs > 0 ? startedAt + timeoutMs : null,
    clock: options.clock,
    edgeWeights: edges.weights,
    edgeTypeMask: edges.mask,
    safetyEdgeMask: edgeTypeMaskOf(KERNEL_SAFETY_EDGE_TYPES),
    conflictEdgeMask: edgeTypeMaskOf(KERNEL_CONFLICT_EDGE_TYPES),
    confidenceMultipliers,
    laneWeights,
    rrf: rrfTable(kernelConfig),
    warnings,
    omissions,
  };
}
