/**
 * The three seeding lanes (CG2-07). The fourth, `local_graph`, is the traversal
 * in `kernel-traverse.ts` and runs on what these produce.
 *
 * All three read the plan and none of them re-derives it. The split is by
 * *evidence class*, not by data source, which is the whole reason the confidence
 * mapping in §4 can be total and exclusive:
 *
 *   - `anchor` resolves an identifier. A canonical id, a workspace-relative
 *     path, a caller seed the caller resolved structurally, a focus path. These
 *     are dictionary hits on an exact key, and they are the only source of
 *     `exact` confidence anywhere in the kernel.
 *   - `lexical` and `coarse` merge BM25F postings. Their ceiling is
 *     `text_candidate` at any score, so there is no magnitude at which a text
 *     match becomes a relation. The v1 engine's empty `korean`/`jargon` results
 *     are a quality floor to beat by *indexing* better, never by relaxing this.
 *
 * The scan budget is counted in postings, not in label/path keys. The key scan
 * is gone; measuring a structure that no longer exists would report a bound
 * nothing can hit.
 */
import type { ContextIndexReader, PostingSlice } from '../runtime-index/reader.js';
import {
  CANDIDATE_FLAG,
  addOmission,
  isExactKernelConfidence,
  type KernelRequest,
  type LaneTelemetry,
  type RetrievalLane,
} from './kernel-types.js';
import { CandidateTable, NO_SLOT } from './kernel-candidates.js';
import type { KernelPlanContext } from './kernel-plan.js';

interface LaneCounters {
  postingsExamined: number;
  matchedTerms: number;
  candidates: number;
  truncated: boolean;
}

function counters(): LaneCounters {
  return { postingsExamined: 0, matchedTerms: 0, candidates: 0, truncated: false };
}

function telemetry(lane: RetrievalLane, count: LaneCounters): LaneTelemetry {
  return Object.freeze({
    lane,
    matchedTerms: count.matchedTerms,
    postingsExamined: count.postingsExamined,
    candidates: count.candidates,
    truncated: count.truncated,
  });
}

/**
 * Admits one posting run. `rank` is the run's own order, which the anchor lane
 * keeps global across terms so that an earlier, more specific term outranks a
 * later one deterministically.
 */
function admitPostings(
  reader: ContextIndexReader,
  table: CandidateTable,
  postings: PostingSlice,
  count: LaneCounters,
  admit: (slot: number, rank: number, index: number) => void,
  fromRank: number,
  limit: number,
): number {
  let rank = fromRank;
  for (let index = 0; index < postings.length; index += 1) {
    if (rank >= limit) {
      count.truncated = true;
      break;
    }
    count.postingsExamined += 1;
    const node = postings.node(index);
    const before = table.size;
    const slot = table.admit(reader, node);
    if (slot === NO_SLOT) {
      count.truncated = true;
      break;
    }
    if (table.size > before) count.candidates += 1;
    admit(slot, rank, index);
    rank += 1;
  }
  return rank;
}

/**
 * §7.1. Every source here is an O(log n) dictionary hit on a key that identifies
 * a node rather than describing it — which is what earns the lane its exact
 * confidence, and why no BM25F score appears anywhere in it.
 */
export function runAnchorLane(
  reader: ContextIndexReader,
  context: KernelPlanContext,
  request: KernelRequest,
  table: CandidateTable,
): LaneTelemetry {
  const count = counters();
  const plan = context.plan;
  const limit = context.kernelConfig.laneTopN;
  let rank = 0;

  const claimExact = (termId: number, confidence: 'exact_reference' | 'file_path', focus: boolean) =>
    (slot: number, position: number): void => {
      table.claim(slot, 'anchor', confidence);
      // The term id goes through `contribute` so it lands under the same
      // first-wins rule as the rank it belongs to: one node can be named by two
      // anchor terms at once — its canonical id and its path — and a receipt
      // that mixed one term's rank with another's id would attribute the hit to
      // a lookup that never resolved it.
      table.contribute(slot, 'anchor', position, context.kernelConfig.exactAnchorPriority, termId);
      table.mark(slot, CANDIDATE_FLAG.SEED | CANDIDATE_FLAG.EXACT_SEED | (focus ? CANDIDATE_FLAG.FOCUS : 0));
      table.link(slot, table.node[slot] as number, -1, -1, 0);
    };

  for (const term of context.anchorTerms) {
    const termId = reader.termId(term);
    // A canonical id is a node id, a command id, a route id, a gate id and a
    // schema id all at once — they are the same namespace, so one lookup covers
    // every bullet §7.1 lists after "stable node ID".
    const ids = reader.exact(term, plan.fieldMask);
    if (ids.length > 0) count.matchedTerms += 1;
    rank = admitPostings(reader, table, ids, count, claimExact(termId, 'exact_reference', false), rank, limit);

    // Format revision 1 keys BASENAME_TABLE by the node's whole
    // workspace-relative path, so this resolves an exact *path*, not a basename
    // token — which is why a pasted `src/core/kernel.ts` anchors and a bare
    // `kernel.ts` does not. If CG2-04 re-keys that table to basename tokens,
    // this lane and the focus loop below are its consumers: both go to zero hits
    // and take their tests with them, which is the intended way to find out.
    const paths = reader.basename(term);
    if (paths.length > 0) count.matchedTerms += 1;
    rank = admitPostings(reader, table, paths, count, claimExact(termId, 'file_path', false), rank, limit);
  }

  // A focus path is an anchor in its own right (§7.1) and also the origin of the
  // focus component: everything the traversal reaches from here inherits the
  // flag, which is what makes focus filtering a reachability question rather
  // than a path scan the index cannot answer without a full sweep.
  for (const focus of context.focusPaths) {
    const paths = reader.basename(focus);
    if (paths.length === 0) {
      context.warnings.push('a focus path matched no node in this index');
      addOmission(context.omissions, 'focus_filtered', 1);
      continue;
    }
    rank = admitPostings(reader, table, paths, count, claimExact(-1, 'file_path', true), rank, limit);
  }

  rank = admitProvidedSeeds(reader, context, request, table, count, rank, limit);
  if (count.truncated) addOmission(context.omissions, 'posting_cap', 1);
  return telemetry('anchor', count);
}

/**
 * Caller seeds. A seed whose confidence is in the exact family is a claim that
 * the caller *resolved* the node — a symbol lookup, a manifest entry, a path —
 * so it enters the anchor lane. A seed carrying anything weaker is a text guess
 * no matter who made it, and it enters as a text candidate: §4 constrains what
 * may be reported as exact, and "the caller said so" is not evidence.
 */
function admitProvidedSeeds(
  reader: ContextIndexReader,
  context: KernelPlanContext,
  request: KernelRequest,
  table: CandidateTable,
  count: LaneCounters,
  fromRank: number,
  limit: number,
): number {
  let rank = fromRank;
  let unknown = 0;
  for (const seed of request.seeds ?? []) {
    const nodeId = String(seed.nodeId ?? '');
    if (nodeId === '') continue;
    const postings = reader.exact(nodeId);
    if (postings.length === 0) {
      unknown += 1;
      continue;
    }
    const verified = seed.verified ?? isExactKernelConfidence(seed.confidence);
    const lane: RetrievalLane = verified ? 'anchor' : 'lexical';
    rank = admitPostings(reader, table, postings, count, (slot, position) => {
      table.claim(slot, lane, verified ? seed.confidence : 'text_candidate');
      table.contribute(slot, lane, position, verified ? context.kernelConfig.exactAnchorPriority : 0);
      table.mark(slot, CANDIDATE_FLAG.SEED | CANDIDATE_FLAG.PROVIDED | (verified ? CANDIDATE_FLAG.EXACT_SEED : 0));
      table.link(slot, table.node[slot] as number, -1, -1, 0);
    }, rank, limit);
  }
  if (unknown > 0) {
    context.warnings.push(`${unknown} caller-supplied seed(s) are not present in this index`);
    addOmission(context.omissions, 'unknown_seed', unknown);
  }
  return rank;
}

/** Shared by the two BM25F lanes: they differ only in which dictionary they read. */
function runPostingLane(
  reader: ContextIndexReader,
  context: KernelPlanContext,
  table: CandidateTable,
  lane: 'lexical' | 'coarse',
): LaneTelemetry {
  const count = counters();
  const plan = context.plan;
  if (plan.termIds.length === 0) return telemetry(lane, count);

  const merged = lane === 'lexical' ? reader.lexical(plan.termIds, plan) : reader.coarse(plan.termIds, plan);
  count.matchedTerms = merged.matchedTerms;
  count.truncated = merged.truncated;

  const limit = Math.min(merged.length, context.kernelConfig.laneTopN);
  for (let index = 0; index < limit; index += 1) {
    count.postingsExamined += 1;
    const before = table.size;
    const slot = table.admit(reader, merged.node(index));
    if (slot === NO_SLOT) {
      count.truncated = true;
      break;
    }
    if (table.size > before) {
      count.candidates += 1;
      // A text hit is a seed for the traversal but never an exact one, so it
      // gets `SEED` without `EXACT_SEED` and points at itself as its own origin.
      table.mark(slot, CANDIDATE_FLAG.SEED);
      table.link(slot, merged.node(index), -1, -1, 0);
    }
    table.claim(slot, lane, 'text_candidate');
    table.contribute(slot, lane, index, merged.score(index));
  }
  if (merged.length > limit) count.truncated = true;
  if (count.truncated) addOmission(context.omissions, 'posting_cap', 1);
  return telemetry(lane, count);
}

export function runLexicalLane(
  reader: ContextIndexReader,
  context: KernelPlanContext,
  table: CandidateTable,
): LaneTelemetry {
  return runPostingLane(reader, context, table, 'lexical');
}

export function runCoarseLane(
  reader: ContextIndexReader,
  context: KernelPlanContext,
  table: CandidateTable,
): LaneTelemetry {
  return runPostingLane(reader, context, table, 'coarse');
}

/**
 * The seeding pass. Anchor runs first so its exact claims are already in the
 * table when the text lanes reach the same node — `claim` only strengthens, but
 * ordering it this way keeps the rule visible instead of load-bearing.
 */
export function runSeedLanes(
  reader: ContextIndexReader,
  context: KernelPlanContext,
  request: KernelRequest,
  table: CandidateTable,
): LaneTelemetry[] {
  const lanes = [
    runAnchorLane(reader, context, request, table),
    runLexicalLane(reader, context, table),
    runCoarseLane(reader, context, table),
  ];
  if (table.overflow > 0) addOmission(context.omissions, 'candidate_budget', table.overflow);
  if (table.size === 0) {
    context.warnings.push('no node in this index matched the query; nothing was selected and no text fallback was attempted');
  }
  return lanes;
}
