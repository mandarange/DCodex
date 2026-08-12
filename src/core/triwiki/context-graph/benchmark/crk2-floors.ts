/**
 * CRK2 hard floors.
 *
 * Every floor here is an **equality**, not a threshold. `Crk2FloorResult` has no
 * `gte` variant and no tolerance field, so there is nowhere to put a "0.98 is
 * close enough" — the only way to make a failing floor pass is to fix the engine
 * or to delete the floor, and deleting one is visible in the diff.
 *
 * ADR §10 fixes the list: provenance coverage 1.0, protected-gate recall 1.0,
 * conflict recall 1.0, determinism 0 mismatches, corrupt-input rejection 100%.
 * The two additions — forbidden-node count and unsupported-language exact
 * mislabels — are the same claims stated per node rather than per run, and both
 * appear in work order §12.3 as hard quality targets.
 */
import { CRK2_FLOOR_IDS, type Crk2CaseMetrics, type Crk2EngineSummary, type Crk2FloorId, type Crk2FloorReport, type Crk2FloorResult } from './crk2-types.js';

interface Crk2FloorSpec {
  readonly id: Crk2FloorId;
  readonly label: string;
  readonly required: number;
  read(summary: Crk2EngineSummary): number;
  /** Case ids that account for the shortfall. Ids only; never a path or a matched string. */
  detail(rows: readonly Crk2CaseMetrics[]): readonly string[];
}

export const CRK2_FLOOR_SPECS: readonly Crk2FloorSpec[] = [
  {
    id: 'provenance_coverage_exact',
    label: 'every returned node carries provenance',
    required: 1,
    read: (summary) => summary.provenanceCoverage,
    detail: (rows) => rows.filter((row) => row.provenanceCoverage < 1).map((row) => `${row.caseId}:provenance_gap`)
  },
  {
    id: 'protected_gate_recall_exact',
    label: 'every protected gate a case declares is returned',
    required: 1,
    read: (summary) => summary.protectedGateRecall,
    detail: (rows) =>
      rows
        .filter((row) => row.declaredProtectedGateCount > 0 && row.protectedGateRecall < 1)
        .map((row) => `${row.caseId}:protected_gate_missed`)
  },
  {
    id: 'conflict_recall_exact',
    label: 'every declared write-scope conflict is detected',
    required: 1,
    read: (summary) => summary.conflictRecall,
    detail: (rows) =>
      rows.filter((row) => row.declaredConflictCount > 0 && row.conflictRecall < 1).map((row) => `${row.caseId}:conflict_missed`)
  },
  {
    id: 'determinism_zero_mismatch',
    label: 'repeated runs of one case produce byte-identical answers',
    required: 0,
    read: (summary) => summary.determinismMismatches,
    detail: (rows) => rows.filter((row) => row.determinismMismatches > 0).map((row) => `${row.caseId}:answer_not_reproducible`)
  },
  {
    id: 'corrupt_input_rejection_exact',
    label: 'corrupt or unusable index input is rejected with its declared error code',
    required: 1,
    read: (summary) => summary.rejectionRate,
    detail: (rows) => rows.filter((row) => row.rejectionCorrect === false).map((row) => `${row.caseId}:rejection_missed`)
  },
  {
    id: 'forbidden_node_zero',
    label: 'no case returns a node its gold set forbids',
    required: 0,
    read: (summary) => summary.forbiddenViolations,
    detail: (rows) => rows.filter((row) => row.forbiddenViolations.length > 0).map((row) => `${row.caseId}:forbidden_node_returned`)
  },
  {
    id: 'unsupported_language_exact_mislabel_zero',
    label: 'no text or unsupported-language hit is labelled an exact relation',
    required: 0,
    read: (summary) => summary.confidenceViolations,
    detail: (rows) => rows.filter((row) => row.confidenceViolations.length > 0).map((row) => `${row.caseId}:confidence_above_ceiling`)
  }
];

export function crk2FloorIds(): readonly Crk2FloorId[] {
  return CRK2_FLOOR_SPECS.map((spec) => spec.id);
}

/**
 * A floor passes only on exact equality.
 *
 * Floating-point means `1.0` can arrive as `0.9999999999999998` after averaging,
 * so the comparison snaps to a fixed number of decimals rather than widening the
 * floor. The tolerance is arithmetic noise, not measurement slack: it is far
 * tighter than one missed item in any corpus this size.
 */
const ARITHMETIC_NOISE = 1e-9;

function equals(observed: number, required: number): boolean {
  if (!Number.isFinite(observed)) return false;
  return Math.abs(observed - required) < ARITHMETIC_NOISE;
}

export function evaluateCrk2Floors(
  summary: Crk2EngineSummary,
  rows: readonly Crk2CaseMetrics[]
): Crk2FloorReport {
  const results: Crk2FloorResult[] = CRK2_FLOOR_SPECS.map((spec) => {
    const observed = spec.read(summary);
    return {
      id: spec.id,
      label: spec.label,
      engineId: summary.engineId,
      engineVersion: summary.engineVersion,
      passed: equals(observed, spec.required),
      observed,
      required: spec.required,
      comparison: 'eq',
      detail: [...spec.detail(rows)].sort()
    };
  });
  const failed = results.filter((result) => !result.passed).length;
  return { ok: failed === 0, evaluated: results.length, failed, results };
}

/** Guards against a floor being dropped from the spec list without touching the id list. */
export function crk2FloorCoverageGap(): readonly Crk2FloorId[] {
  const covered = new Set(CRK2_FLOOR_SPECS.map((spec) => spec.id));
  return CRK2_FLOOR_IDS.filter((id) => !covered.has(id));
}
