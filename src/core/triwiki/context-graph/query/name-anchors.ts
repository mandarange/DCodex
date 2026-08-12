/**
 * Label and basename anchoring: when the caller's query *is* a node's name.
 *
 * Format revision 1's anchor tables are keyed by a canonical node id and by a
 * whole workspace-relative path, so `reader.ts` typed alone anchors nothing and
 * `compileContextIndex` anchors nothing. Both are still *found* — BM25F puts
 * them at lexical rank 0 — and then ranked out, because the fused score is a
 * sum in which one strong text rank loses to a node with four mediocre ones.
 * Measured on the CRK2 corpus, every gold node these queries missed was in the
 * returned candidate set and below `k`. So this is a ranking gap, not a
 * retrieval gap, and it is closed by ranking rather than by finding more.
 *
 * ## This does not claim exact confidence, and cannot
 *
 * Nothing here calls `table.claim`. A name match sets one flag and changes two
 * scores; a candidate's §4 confidence is whatever the lane that produced it
 * said, which for a text hit is `text_candidate` at any magnitude. That is not
 * caution, it is the rule: §4 gives `exact` to a *resolved identifier*, and a
 * string being equal to a node's name is not a resolution. Two files share a
 * basename; a symbol and a directory share a stem; `run` is a label. The
 * caller-supplied changed path in `changed-path-seeds.ts` may claim `file_path`
 * for the one reason that does not apply here — the caller resolved it.
 *
 * Because no claim is made, the §4 violation count cannot move. That is a
 * structural property of this module, not something a run has to confirm; the
 * run confirms it anyway, and the joined-behaviour test pins it.
 *
 * ## The query-shape gate
 *
 * Anchoring is attempted only when **the whole query is one bare token** — one
 * word, no spaces. That is the shape at which "your query is this node's name"
 * is a statement about the query rather than about one word inside it.
 *
 * The gate exists because a correct anchor can still cost recall: a hoisted
 * node displaces whatever was in the slot below it. On a phrase, hoisting every
 * node that happens to be named by one of its words is a large displacement for
 * a weak reason — an earlier probe took the §4 violation count from 3 to 16 by
 * treating a three-word jargon phrase as six resolved identifiers, for zero
 * recall. One word is also what bounds the cost: the scan below runs once per
 * query or not at all.
 *
 * `QueryPlan.shape` is deliberately *not* the gate, and this is worth knowing
 * before someone tries it. `classifyShape` counts tokenizer segments, so the
 * one-word query `compileContextIndex` classifies as `natural` (six segments)
 * and the one-word `context_graph_smoke` classifies as `natural` (three), while
 * the two-word `CSR adjacency` also classifies as `natural`. The frozen shape
 * enum cannot distinguish an identifier from a sentence, which is exactly the
 * distinction this gate needs.
 *
 * ## Where the candidates come from
 *
 * The candidate table, after the seeding lanes and before the traversal. Every
 * row in it at that point was admitted by a lane, so this can only reorder what
 * retrieval already found — it never invents a candidate, and it never widens a
 * posting cap. The bound that follows from that is real and worth stating: a
 * node whose name is the query but whose BM25F rank fell outside `laneTopN` is
 * not reachable here. Closing *that* needs the anchor tables to carry names,
 * which is a format revision.
 */
import type { ContextIndexReader } from '../runtime-index/reader.js';
import { CANDIDATE_FLAG } from './kernel-types.js';
import type { CandidateTable } from './kernel-candidates.js';
import type { KernelPlanContext } from './kernel-plan.js';

/**
 * The query, if the whole of it is one bare token; otherwise `null`.
 *
 * Derived from `anchorTerms` rather than re-split from the query text, because
 * `resolveQueryPlan` has already done that splitting and doing it twice is how
 * the v1 engine ended up normalizing a query in three places. The list holds
 * the distinct whitespace runs of the normalized query, plus the whole
 * normalized query unshifted at the front when it differs from all of them — so
 * `length === 1` holds for exactly the one-token queries, and a two-token query
 * yields three entries rather than two.
 */
export function nameAnchorTermOf(context: KernelPlanContext): string | null {
  if (context.anchorTerms.length !== 1) return null;
  const term = context.anchorTerms[0] as string;
  return term === '' ? null : term;
}

/**
 * Marks every candidate the query names exactly, and returns how many.
 *
 * Runs before the traversal so a name match seeds the walk at its own strength:
 * a symbol the query named is the reason its file is relevant, and the file is
 * reached by a hop rather than by its own text. Running this after the walk
 * would rank the symbol correctly and leave the file where it was.
 */
export function markNameAnchors(
  reader: ContextIndexReader,
  context: KernelPlanContext,
  table: CandidateTable,
): number {
  const name = nameAnchorTermOf(context);
  if (name === null) return 0;
  let matched = 0;
  for (let slot = 0; slot < table.size; slot += 1) {
    if (!reader.nodeHasName(table.node[slot] as number, name)) continue;
    table.mark(slot, CANDIDATE_FLAG.NAME_MATCH);
    matched += 1;
  }
  return matched;
}
