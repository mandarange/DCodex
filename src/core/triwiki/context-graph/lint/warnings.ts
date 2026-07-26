/**
 * Non-blocking Context Graph lint rules.
 *
 * Warnings describe a graph that is structurally valid but epistemically weak:
 * a claim with nothing behind it, a module everything imports that nothing tests,
 * a node no query profile can ever reach. They are recorded in the meta so the
 * quality of the cache stays visible without re-running the compiler.
 */
import {
  lintWarning,
  type ContextGraphEdgeType,
  type ContextGraphLintIssue,
  type ContextGraphSkip
} from '../contracts.js';
import { incomingEdges, outgoingEdges, type ContextGraphIndex } from '../graph-index.js';
import { CONTEXT_GRAPH_QUERY_PROFILES } from '../profiles.js';

const CITATION_EDGE_TYPES: ReadonlySet<ContextGraphEdgeType> = new Set<ContextGraphEdgeType>([
  'cites',
  'derived_from',
  'supports'
]);

const VERIFICATION_EDGE_TYPES: ReadonlySet<ContextGraphEdgeType> = new Set<ContextGraphEdgeType>([
  'tests',
  'verified_by',
  'gated_by'
]);

const HIGH_FAN_IN = 8;
const LOW_TRUST = 0.5;
const PER_RULE_LIMIT = 50;

function traversableEdgeTypes(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const profile of Object.values(CONTEXT_GRAPH_QUERY_PROFILES)) {
    for (const edge of profile.edges) out.add(edge);
  }
  return out;
}

function capped(issues: readonly ContextGraphLintIssue[], limit = PER_RULE_LIMIT): ContextGraphLintIssue[] {
  if (issues.length <= limit) return [...issues];
  const head = issues.slice(0, limit);
  const first = issues[0];
  if (first) {
    head.push({
      code: first.code,
      severity: 'warning',
      message: `${issues.length - limit} further ${first.code} warnings were omitted from this snapshot`
    });
  }
  return head;
}

export interface ContextGraphWarningInput {
  index: ContextGraphIndex;
  skipped?: readonly ContextGraphSkip[] | undefined;
}

export function warningIssues(input: ContextGraphWarningInput): ContextGraphLintIssue[] {
  const { index } = input;
  const traversable = traversableEdgeTypes();
  const orphanClaims: ContextGraphLintIssue[] = [];
  const lowTrust: ContextGraphLintIssue[] = [];
  const unknownFreshness: ContextGraphLintIssue[] = [];
  const highFanIn: ContextGraphLintIssue[] = [];
  const unreachable: ContextGraphLintIssue[] = [];

  for (const node of index.snapshot.nodes) {
    const outgoing = outgoingEdges(index, node.id);
    const incoming = incomingEdges(index, node.id);

    if (node.kind === 'wiki_claim') {
      const citations = outgoing.filter((edge) => CITATION_EDGE_TYPES.has(edge.type));
      if (citations.length === 0) {
        orphanClaims.push(
          lintWarning('orphan_wiki_claim', `wiki claim ${node.id} cites no source`, { nodeId: node.id })
        );
      } else if (citations.length === 1 && node.trust < LOW_TRUST) {
        lowTrust.push(
          lintWarning('single_source_low_trust_synthesis', `wiki claim ${node.id} rests on one low-trust source`, {
            nodeId: node.id
          })
        );
      }
    }

    if (node.freshness === 'unknown') {
      unknownFreshness.push(
        lintWarning('unknown_freshness', `node ${node.id} has unknown freshness`, { nodeId: node.id })
      );
    }

    if (incoming.length >= HIGH_FAN_IN) {
      const verified = [...incoming, ...outgoing].some((edge) => VERIFICATION_EDGE_TYPES.has(edge.type));
      if (!verified) {
        highFanIn.push(
          lintWarning(
            'high_fan_in_without_verification',
            `node ${node.id} has ${incoming.length} dependents and no test or gate relation`,
            { nodeId: node.id }
          )
        );
      }
    }

    const reachable = [...incoming, ...outgoing].some((edge) => traversable.has(edge.type));
    if (!reachable) {
      unreachable.push(
        lintWarning('unreachable_in_profile', `node ${node.id} is not reachable by any query profile`, {
          nodeId: node.id
        })
      );
    }
  }

  return [
    ...capped(orphanClaims),
    ...capped(lowTrust),
    ...capped(unknownFreshness),
    ...capped(highFanIn),
    ...capped(unreachable),
    ...summarizeSkips(input.skipped ?? [])
  ];
}

/** One warning per skip reason rather than one per file: the artifact has to stay bounded. */
export function summarizeSkips(skipped: readonly ContextGraphSkip[]): ContextGraphLintIssue[] {
  const counts = new Map<string, number>();
  for (const skip of skipped) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([reason, count]) => lintWarning('extractor_skipped_input', `${count} input(s) were skipped: ${reason}`));
}
