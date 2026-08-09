/**
 * Compact architecture-capsule.txt for LLM injection (WO §11.5).
 */
import {
  byCodePoint,
  type ArchitectureBaselineV1,
  type ArchitectureCapsuleV1,
  type ArchitectureFinding,
  type ArchitectureMapProfile,
  type ArchitectureMetricsV1
} from './contracts.js';
import { hashCanonical } from './fingerprint.js';

export function renderArchitectureCapsule(input: {
  profile: ArchitectureMapProfile;
  missionId: string;
  routeId?: string;
  baseline?: ArchitectureBaselineV1 | null;
  metrics: ArchitectureMetricsV1;
  findings: readonly ArchitectureFinding[];
  affectedGates?: readonly string[];
  mapArtifact?: string;
  seedPaths?: readonly string[];
}): ArchitectureCapsuleV1 {
  const blocking = input.findings
    .filter((finding) => finding.severity === 'blocking')
    .sort((left, right) => byCodePoint(left.id, right.id));
  const baselineShort = input.baseline ? input.baseline.seal.slice(0, 12) : 'none';
  const lines = [
    `schema=sks.architecture-capsule.v1`,
    `profile=${input.profile}`,
    `mission=${input.missionId}`,
    `route=${input.routeId ?? 'unknown'}`,
    `baseline=${baselineShort}`,
    `modules=${input.metrics.moduleCount}`,
    `scc=${input.metrics.sccCount}`,
    `fan_in_max=${input.metrics.maxFanIn}`,
    `fan_out_max=${input.metrics.maxFanOut}`,
    `layer_violations=${input.metrics.layerViolationCount}`,
    `ssot_collisions=${input.metrics.ssotCollisionCount}`,
    `verification_gaps=${input.metrics.protectedVerificationGapCount}`,
    `affected_gates=${(input.affectedGates ?? []).slice().sort(byCodePoint).join(',') || 'none'}`,
    `blocking_findings=${blocking.map((finding) => `${finding.id}:${finding.code}`).join(',') || 'none'}`,
    `seeds=${(input.seedPaths ?? []).slice().sort(byCodePoint).join(',') || 'none'}`,
    `map=${input.mapArtifact ?? 'architecture-map-delta.mmd'}`
  ];
  const text = `${lines.join('\n')}\n`;
  return Object.freeze({
    schema: 'sks.architecture-capsule.v1',
    text,
    byteLength: Buffer.byteLength(text, 'utf8'),
    profile: input.profile,
    contentHash: hashCanonical(text)
  });
}
