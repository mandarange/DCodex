/**
 * Architecture findings. Fail-closed: when the graph lacks kinds/edges needed
 * for structural analysis, emit blocking `insufficient_graph` — never empty pass.
 */
import type { ContextGraphSnapshot } from '../contracts.js';
import {
  byCodePoint,
  type ArchitectureFinding,
  type ArchitectureFindingCode,
  type ArchitectureFindingSeverity,
  type ArchitectureInputBundleV1
} from './contracts.js';
import { findingId, makeFinding } from './finding-factory.js';
import { isAllowedLayerEdge, layerForModule, type ArchitectureMapPolicy } from './policy.js';
import {
  buildModuleDependencyGraph,
  computeSccs,
  sccKey
} from './metrics.js';
import { mergeGraphWithTopology } from './topology-overlay.js';
import { canonicalSsotAuthorityInventory } from '../../../safety/ssot-authority-inventory.js';
import { analyzeSsotCollisions } from './ssot-analysis.js';

export { findingId, makeFinding };

const ANALYSIS_REQUIRED_KINDS = ['module'] as const;
const ANALYSIS_REQUIRED_EDGES = ['imports'] as const;

function severityFor(
  code: ArchitectureFindingCode,
  policy: ArchitectureMapPolicy
): ArchitectureFindingSeverity {
  return policy.blockingCodes.includes(code) ? 'blocking' : 'warning';
}

export function graphSufficiencyIssues(graph: ContextGraphSnapshot): readonly string[] {
  const kinds = new Set(graph.nodes.map((node) => node.kind));
  const edgeTypes = new Set(graph.edges.map((edge) => edge.type));
  const missing: string[] = [];
  for (const kind of ANALYSIS_REQUIRED_KINDS) {
    if (!kinds.has(kind)) missing.push(`kind:${kind}`);
  }
  for (const type of ANALYSIS_REQUIRED_EDGES) {
    if (!edgeTypes.has(type)) missing.push(`edge:${type}`);
  }
  if (!graph.nodes.length) missing.push('nodes:empty');
  return Object.freeze(missing.sort(byCodePoint));
}

function insufficientGraphFinding(
  policy: ArchitectureMapPolicy,
  missing: readonly string[]
): ArchitectureFinding {
  return makeFinding({
    code: 'insufficient_graph',
    severity: severityFor('insufficient_graph', policy),
    subjectIds: missing,
    evidenceIds: missing,
    ruleId: 'graph-sufficiency',
    message: `Architecture graph lacks required kinds/edges for analysis: ${missing.join(', ')}`
  });
}

export function detectNewAndExpandedCycles(input: {
  policy: ArchitectureMapPolicy;
  baselineSccs: readonly (readonly string[])[];
  afterSccs: readonly (readonly string[])[];
}): ArchitectureFinding[] {
  const baselineKeys = new Map(input.baselineSccs.map((members) => [sccKey(members), members]));
  const findings: ArchitectureFinding[] = [];
  for (const members of input.afterSccs) {
    const key = sccKey(members);
    const prior = baselineKeys.get(key);
    if (!prior) {
      // Expansion: after members properly contain a baseline SCC.
      let expandedFrom: readonly string[] | null = null;
      for (const baseline of input.baselineSccs) {
        if (baseline.every((id) => members.includes(id)) && members.length > baseline.length) {
          expandedFrom = baseline;
          break;
        }
      }
      if (expandedFrom) {
        findings.push(
          makeFinding({
            code: 'cycle_expansion',
            severity: severityFor('cycle_expansion', input.policy),
            subjectIds: members,
            evidenceIds: expandedFrom,
            ruleId: 'cycle-expansion',
            message: `Dependency cycle expanded from ${expandedFrom.length} to ${members.length} modules`
          })
        );
      } else {
        findings.push(
          makeFinding({
            code: 'new_cycle',
            severity: severityFor('new_cycle', input.policy),
            subjectIds: members,
            evidenceIds: members,
            ruleId: 'new-cycle',
            message: `New dependency cycle among ${members.length} modules`
          })
        );
      }
    }
  }
  return findings.sort((left, right) => byCodePoint(left.id, right.id));
}

export function detectForbiddenDependencies(input: {
  policy: ArchitectureMapPolicy;
  moduleIds: readonly string[];
  edgeKeys: readonly string[];
}): ArchitectureFinding[] {
  const findings: ArchitectureFinding[] = [];
  for (const key of input.edgeKeys) {
    const [from, to] = key.split('->');
    if (!from || !to) continue;
    const fromLayer = layerForModule(input.policy, modulePathFromId(from));
    const toLayer = layerForModule(input.policy, modulePathFromId(to));
    if (!fromLayer || !toLayer) continue;
    if (!isAllowedLayerEdge(input.policy, fromLayer, toLayer)) {
      findings.push(
        makeFinding({
          code: 'forbidden_dependency',
          severity: severityFor('forbidden_dependency', input.policy),
          subjectIds: [from, to],
          evidenceIds: [key],
          ruleId: `${fromLayer}->${toLayer}`,
          message: `Forbidden layer edge ${fromLayer} -> ${toLayer} via ${from} -> ${to}`
        })
      );
    }
  }
  return findings.sort((left, right) => byCodePoint(left.id, right.id));
}

/** Module node ids are `module:<path>` or raw path-like ids depending on extractor. */
function modulePathFromId(moduleId: string): string {
  return moduleId.startsWith('module:') ? moduleId.slice('module:'.length) : moduleId;
}

export function detectVerificationGaps(input: {
  policy: ArchitectureMapPolicy;
  graph: ContextGraphSnapshot;
}): ArchitectureFinding[] {
  const protectedNodes = input.graph.nodes.filter((node) => node.risk === 'protected' || node.risk === 'high');
  if (!protectedNodes.length) return [];
  const verifiedTargets = new Set<string>();
  for (const edge of input.graph.edges) {
    if (edge.type === 'tests' || edge.type === 'verified_by' || edge.type === 'gated_by') {
      verifiedTargets.add(edge.to);
      verifiedTargets.add(edge.from);
    }
  }
  const kinds = new Set(input.graph.nodes.map((node) => node.kind));
  if (!kinds.has('test') && !kinds.has('gate') && !kinds.has('proof')) {
    // Cannot prove coverage without verification kinds — fail closed.
    return [
      makeFinding({
        code: 'insufficient_graph',
        severity: severityFor('insufficient_graph', input.policy),
        subjectIds: ['kind:test', 'kind:gate', 'kind:proof'],
        evidenceIds: protectedNodes.map((node) => node.id),
        ruleId: 'verification-kinds',
        message: 'Graph lacks test/gate/proof kinds required to evaluate verification gaps'
      })
    ];
  }
  const findings: ArchitectureFinding[] = [];
  for (const node of protectedNodes) {
    if (!verifiedTargets.has(node.id)) {
      findings.push(
        makeFinding({
          code: 'protected_verification_gap',
          severity: severityFor('protected_verification_gap', input.policy),
          subjectIds: [node.id],
          evidenceIds: [node.id],
          ruleId: 'protected-verification-gap',
          message: `Protected/high-risk node ${node.id} has no tests/gate/evidence path`
        })
      );
    }
  }
  return findings.sort((left, right) => byCodePoint(left.id, right.id));
}

export function analyzeArchitectureFindings(input: {
  bundle: ArchitectureInputBundleV1;
  policy: ArchitectureMapPolicy;
  baselineSccs?: readonly (readonly string[])[];
}): readonly ArchitectureFinding[] {
  const missing = graphSufficiencyIssues(input.bundle.graph);
  if (missing.length) {
    return Object.freeze([insufficientGraphFinding(input.policy, missing)]);
  }

  const merged = mergeGraphWithTopology(input.bundle.graph, input.bundle.topology);
  const moduleGraph = buildModuleDependencyGraph(merged.nodes, merged.edges);
  const afterSccs = computeSccs(moduleGraph);
  const baselineSccs = input.baselineSccs ?? [];

  const findings: ArchitectureFinding[] = [
    ...detectNewAndExpandedCycles({
      policy: input.policy,
      baselineSccs,
      afterSccs
    }),
    ...detectForbiddenDependencies({
      policy: input.policy,
      moduleIds: moduleGraph.moduleIds,
      edgeKeys: moduleGraph.edgeKeys
    }),
    ...analyzeSsotCollisions({
      policy: input.policy,
      inventory: canonicalSsotAuthorityInventory()
    }),
    ...detectVerificationGaps({
      policy: input.policy,
      graph: input.bundle.graph
    })
  ];

  // Global atlas with zero findings after a sufficient graph is allowed; mission
  // compare paths pass baselineSccs. Empty pass on insufficient graph is forbidden above.
  return Object.freeze(findings.sort((left, right) => byCodePoint(left.id, right.id)));
}
