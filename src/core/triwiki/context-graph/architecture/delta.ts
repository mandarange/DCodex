/**
 * Architecture delta between sealed baseline and after analysis (WO §14).
 */
import {
  ARCHITECTURE_REVIEW_SCHEMA,
  byCodePoint,
  type ArchitectureBaselineV1,
  type ArchitectureDeltaV1,
  type ArchitectureFinding,
  type ArchitectureInputBundleV1,
  type ArchitectureMetricDelta,
  type ArchitectureMetricsV1,
  type ArchitectureReviewV1,
  type ChangedPathRecord
} from './contracts.js';
import { verifyArchitectureBaselineSeal } from './baseline.js';
import { diffWorktreePaths, hashCanonical } from './fingerprint.js';
import { analyzeArchitectureFindings } from './findings.js';
import { computeArchitectureMetrics } from './metrics.js';
import type { ArchitectureMapPolicy } from './policy.js';

export function metricDelta(before: ArchitectureMetricsV1, after: ArchitectureMetricsV1): ArchitectureMetricDelta {
  return Object.freeze({
    sccCountDelta: after.sccCount - before.sccCount,
    cyclicNodeCountDelta: after.cyclicNodeCount - before.cyclicNodeCount,
    layerViolationCountDelta: after.layerViolationCount - before.layerViolationCount,
    ssotCollisionCountDelta: after.ssotCollisionCount - before.ssotCollisionCount,
    protectedVerificationGapCountDelta:
      after.protectedVerificationGapCount - before.protectedVerificationGapCount
  });
}

function partitionFindings(
  before: readonly ArchitectureFinding[],
  after: readonly ArchitectureFinding[]
): {
  newFindings: ArchitectureFinding[];
  resolvedFindings: ArchitectureFinding[];
  persistentFindings: ArchitectureFinding[];
} {
  const beforeIds = new Set(before.map((finding) => finding.id));
  const afterIds = new Set(after.map((finding) => finding.id));
  const byId = (left: ArchitectureFinding, right: ArchitectureFinding) => byCodePoint(left.id, right.id);
  return {
    newFindings: after.filter((finding) => !beforeIds.has(finding.id)).sort(byId),
    resolvedFindings: before.filter((finding) => !afterIds.has(finding.id)).sort(byId),
    persistentFindings: after.filter((finding) => beforeIds.has(finding.id)).sort(byId)
  };
}

function baselineSccsFromFindings(findings: readonly ArchitectureFinding[]): readonly (readonly string[])[] {
  return Object.freeze(
    findings
      .filter((finding) => finding.code === 'new_cycle' || finding.code === 'cycle_expansion')
      .map((finding) => finding.subjectIds)
  );
}

function countCodes(findings: readonly ArchitectureFinding[], code: ArchitectureFinding['code']): number {
  return findings.filter((finding) => finding.code === code).length;
}

export function buildArchitectureDelta(input: {
  missionId: string;
  baseline: ArchitectureBaselineV1;
  afterBundle: ArchitectureInputBundleV1;
  policy: ArchitectureMapPolicy;
}): ArchitectureDeltaV1 {
  const afterFindings = analyzeArchitectureFindings({
    bundle: input.afterBundle,
    policy: input.policy,
    baselineSccs: baselineSccsFromFindings(input.baseline.findings)
  });
  const partitioned = partitionFindings(input.baseline.findings, afterFindings);
  const afterMetrics = computeArchitectureMetrics({
    graph: input.afterBundle.graph,
    topology: input.afterBundle.topology,
    layerViolationCount: countCodes(afterFindings, 'forbidden_dependency'),
    ssotCollisionCount: countCodes(afterFindings, 'ssot_collision'),
    protectedVerificationGapCount: countCodes(afterFindings, 'protected_verification_gap')
  });
  return Object.freeze({
    schema: 'sks.architecture-delta.v1',
    missionId: input.missionId,
    baselineSeal: input.baseline.seal,
    addedNodeIds: Object.freeze([] as string[]),
    removedNodeIds: Object.freeze([] as string[]),
    addedEdgeIds: Object.freeze([] as string[]),
    removedEdgeIds: Object.freeze([] as string[]),
    newFindings: Object.freeze(partitioned.newFindings),
    resolvedFindings: Object.freeze(partitioned.resolvedFindings),
    metricDelta: metricDelta(input.baseline.metrics, afterMetrics)
  });
}

export function buildArchitectureReview(input: {
  missionId: string;
  baseline: ArchitectureBaselineV1;
  afterBundle: ArchitectureInputBundleV1;
  policy: ArchitectureMapPolicy;
  generatedAt: string;
  accountedChangedPaths?: readonly string[];
  projectionAccounting?: Readonly<Record<string, unknown>>;
}): ArchitectureReviewV1 {
  const sealValid = verifyArchitectureBaselineSeal(input.baseline);
  const changedPaths: ChangedPathRecord[] = [...diffWorktreePaths(
    input.baseline.preexistingDirtyPaths.map((path) => ({
      path,
      kind: 'file' as const,
      sha256: 'baseline',
      size: 0,
      executable: false
    })),
    input.afterBundle.worktree.paths
  )];
  const changedPathSet = new Set(changedPaths.map((entry) => entry.path));
  const accounted = [...(input.accountedChangedPaths ?? [...changedPathSet])].sort(byCodePoint);
  const accountedSet = new Set(accounted);
  const unaccounted = [...changedPathSet].filter((path) => !accountedSet.has(path)).sort(byCodePoint);

  const afterFindings = analyzeArchitectureFindings({
    bundle: input.afterBundle,
    policy: input.policy,
    baselineSccs: baselineSccsFromFindings(input.baseline.findings)
  });
  const partitioned = partitionFindings(input.baseline.findings, afterFindings);
  const afterMetrics = computeArchitectureMetrics({
    graph: input.afterBundle.graph,
    topology: input.afterBundle.topology,
    layerViolationCount: countCodes(afterFindings, 'forbidden_dependency'),
    ssotCollisionCount: countCodes(afterFindings, 'ssot_collision'),
    authorityBypassCount: countCodes(afterFindings, 'authority_bypass'),
    protectedVerificationGapCount: countCodes(afterFindings, 'protected_verification_gap')
  });

  const newBlocking = afterFindings
    .filter((finding) => finding.severity === 'blocking' && finding.disposition === 'open')
    .filter((finding) => !input.baseline.findings.some((prior) => prior.id === finding.id))
    .map((finding) => finding.id)
    .sort(byCodePoint);

  const blockers: string[] = [];
  if (!sealValid) blockers.push('baseline_tampered');
  if (
    input.baseline.policyHash !== input.afterBundle.policyHash ||
    input.baseline.analyzerVersion !== input.afterBundle.analyzerVersion ||
    input.baseline.serializerVersion !== input.afterBundle.serializerVersion
  ) {
    blockers.push('baseline_stale');
  }
  if (unaccounted.length) blockers.push('unaccounted_changed_file');
  if (newBlocking.length) blockers.push('blocking_findings');

  const verification = Object.freeze({
    baselineValid: input.baseline.schema === 'sks.architecture-baseline.v1',
    baselineTimely: input.baseline.capturedBeforeMutation === true,
    baselineFresh: !blockers.includes('baseline_stale'),
    sealValid,
    changedPathAccounting: unaccounted.length === 0 ? 1 : 0,
    projectionAccounting: 1,
    blockers: Object.freeze([...blockers].sort(byCodePoint))
  });

  const blockingFindingIds = Object.freeze(
    [...newBlocking, ...(unaccounted.length ? ['unaccounted_changed_file'] : [])].sort(byCodePoint)
  );
  const verdict: 'pass' | 'block' =
    verification.baselineValid &&
    verification.baselineTimely &&
    verification.baselineFresh &&
    verification.sealValid &&
    verification.changedPathAccounting === 1 &&
    newBlocking.length === 0 &&
    unaccounted.length === 0
      ? 'pass'
      : 'block';

  const payload = {
    schema: ARCHITECTURE_REVIEW_SCHEMA,
    missionId: input.missionId,
    baselineSeal: input.baseline.seal,
    baselineHash: input.baseline.canonicalPayloadHash,
    afterInputHash: input.afterBundle.canonicalHash,
    changedPaths,
    accountedChangedPaths: accounted,
    unaccountedChangedPaths: unaccounted,
    beforeMetrics: input.baseline.metrics,
    afterMetrics,
    metricDelta: metricDelta(input.baseline.metrics, afterMetrics),
    newFindings: partitioned.newFindings,
    resolvedFindings: partitioned.resolvedFindings,
    persistentFindings: partitioned.persistentFindings,
    acceptedExceptions: [] as string[],
    projectionAccounting: input.projectionAccounting ?? {},
    verification,
    verdict,
    blockingFindingIds
  };
  return Object.freeze({
    ...payload,
    canonicalPayloadHash: hashCanonical(payload),
    generatedAt: input.generatedAt
  });
}
