/**
 * The `sks.code-pack.v1` wire contract.
 *
 * It lives here, next to the projection that produces it, so `code-pack.ts` can
 * both re-export the contract and import the builder without a module cycle. The
 * shape is unchanged from the scanner era on purpose: the code pack is now a
 * projection *of* the Context Graph, not a second index, and every existing
 * consumer keeps reading the same fields.
 */
import type { ContextGraphFreshness } from '../contracts.js';

export const CODE_PACK_SCHEMA = 'sks.code-pack.v1' as const;
export const DEFAULT_CODE_PACK_TOKEN_BUDGET = 8000;

export interface CodePackCitation {
  path: string;
  line?: number;
}

export interface CodePackEntry {
  id: string;
  text: string;
  citations: CodePackCitation[];
  /** 0..1, derived from the projected node's own trust and how well it is grounded. */
  trust_score: number;
  /** Real verdict from source hashes plus snapshot status; never a blanket `unknown`. */
  freshness: ContextGraphFreshness;
  token_cost: number;
}

export interface CodePack {
  schema: typeof CODE_PACK_SCHEMA;
  generated_at: string;
  git_head_sha: string | null;
  source_file_count: number;
  /** Binds the pack to the snapshot hash *and* to the projected content. */
  index_digest: string;
  entries: CodePackEntry[];
  token_budget: number;
  total_token_cost: number;
}

export function normalizeCodePackTokenBudget(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_CODE_PACK_TOKEN_BUDGET;
}
