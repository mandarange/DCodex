/**
 * TriWiki claim / source / proof evidence extractor.
 *
 * Produces the evidence half of the Context Graph: what the project claims, what
 * those claims cite, and which proofs still stand behind a gate. Everything it
 * emits is a generated cache over two on-disk artifacts — the TriWiki context
 * pack and the proof bank — and every edge carries provenance back at one of
 * them. A missing artifact is an explicit skip plus a lint warning; it is never
 * an empty success and never a silent fallback to text search.
 *
 * Guarantees:
 *  - zero process spawns and zero dynamic imports of workspace code;
 *  - bounded reads (byte cap, file cap, node/edge cap) with `cap_reached` skips;
 *  - deterministic, sorted output for a fixed workspace state;
 *  - every metadata string passes the shared secret redactor and the path guard.
 */
import type {
  ContextGraphExtractionInput,
  ContextGraphExtractor,
  ContextGraphFragment
} from '../../contracts.js';
import { lintWarning } from '../../contracts.js';
import { extractContextPackEvidence } from './claims.js';
import { extractProofEvidence } from './proofs.js';
import { sanitizeEvidenceFragment } from './redaction.js';
import { createSharedSourceInventory, type SharedSourceInventory } from '../source-inventory.js';
import {
  CONTEXT_PACK_REL,
  EVIDENCE_EXTRACTOR_ID,
  EVIDENCE_EXTRACTOR_REVISION,
  EvidenceFragmentBuilder,
  PROOF_BANK_REL,
  RiskDomainRegistry,
  evidenceContext,
  finalizeEvidenceFragment
} from './shared.js';

export {
  CONTEXT_PACK_REL,
  EVIDENCE_EXTRACTOR_ID,
  EVIDENCE_EXTRACTOR_REVISION,
  PROOF_BANK_REL,
  PROOF_INDEX_REL
} from './shared.js';
export { TRIWIKI_PROOF_INDEX_SCHEMA } from './proof-index.js';
export type { TriWikiProofIndexEntry, TriWikiProofIndexFile } from './proof-index.js';

const MIN_FAN_IN_FOR_VERIFICATION_WARNING = 3;

export class EvidenceGraphExtractor implements ContextGraphExtractor {
  readonly id = EVIDENCE_EXTRACTOR_ID;

  readonly revision = EVIDENCE_EXTRACTOR_REVISION;

  constructor(private readonly sourceInventory: SharedSourceInventory = createSharedSourceInventory()) {}

  /**
   * `changedPaths` is intentionally not used to narrow the walk: the evidence
   * surface is two bounded artifacts whose claim set is global, so a partial
   * re-extraction would silently drop claims that a changed file invalidates.
   * The compiler decides whether to reuse a cached fragment instead.
   */
  async extract(input: ContextGraphExtractionInput): Promise<ContextGraphFragment> {
    const ctx = evidenceContext({
      root: input.root,
      observedAt: input.observedAt,
      limits: input.limits,
      sourcePaths: this.sourceInventory.sourcePaths(input.root, input.limits)
    });
    const builder = new EvidenceFragmentBuilder(input.limits, input.observedAt);
    const risks = new RiskDomainRegistry();

    const pack = extractContextPackEvidence(builder, ctx, risks);
    const proofs = extractProofEvidence(builder, ctx, risks);
    risks.flush(builder, pack.packPresent ? CONTEXT_PACK_REL : PROOF_BANK_REL);
    noteUnverifiedFanIn(builder);

    if (!pack.packPresent && proofs.proofCount === 0) {
      builder.addIssue(
        lintWarning('extractor_skipped_input', 'no TriWiki evidence artifacts were present; the evidence fragment is empty by observation, not by failure', {
          path: CONTEXT_PACK_REL,
          extractor: EVIDENCE_EXTRACTOR_ID
        })
      );
    }
    return finalizeEvidenceFragment(sanitizeEvidenceFragment(builder.fragment));
  }
}

export function createEvidenceGraphExtractor(
  options: { sourceInventory?: SharedSourceInventory } = {}
): ContextGraphExtractor {
  return new EvidenceGraphExtractor(options.sourceInventory ?? createSharedSourceInventory());
}

/**
 * A gate/module that many proofs point at but that nothing currently verifies is
 * a real review signal, so it is surfaced rather than left implicit.
 */
function noteUnverifiedFanIn(builder: EvidenceFragmentBuilder): void {
  const incoming = new Map<string, { total: number; verified: number }>();
  for (const edge of builder.fragment.edges) {
    if (edge.type !== 'verified_by' && edge.type !== 'invalidates') continue;
    const bucket = incoming.get(edge.to) ?? { total: 0, verified: 0 };
    bucket.total += 1;
    if (edge.type === 'verified_by') bucket.verified += 1;
    incoming.set(edge.to, bucket);
  }
  for (const nodeId of [...incoming.keys()].sort()) {
    const bucket = incoming.get(nodeId);
    if (!bucket) continue;
    if (bucket.verified > 0 || bucket.total < MIN_FAN_IN_FOR_VERIFICATION_WARNING) continue;
    builder.addIssue(
      lintWarning('high_fan_in_without_verification', 'subject is referenced only by invalidated proofs and has no standing verification', {
        nodeId,
        extractor: EVIDENCE_EXTRACTOR_ID
      })
    );
  }
}
