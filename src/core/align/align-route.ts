import fs from 'node:fs';
import path from 'node:path';
import { commandManifestNames } from '../../cli/command-manifest-lite.js';
import { nowIso, readJson, sha256, writeJsonAtomic } from '../fsx.js';
import { MANAGED_ROUTE_SKILL_NAMES } from '../routes.js';

export const ALIGN_PLAN_ARTIFACT = 'align-plan.json';
export const ALIGN_LEDGER_ARTIFACT = 'align-ledger.json';
export const ALIGN_GATE_ARTIFACT = 'align-gate.json';

export const ALIGN_OFFICIAL_SOURCES = Object.freeze([
  Object.freeze({
    source_id: 'gpt_5_6_migration_prompting',
    url: 'https://developers.openai.com/api/docs/guides/latest-model'
  }),
  Object.freeze({
    source_id: 'programmatic_tool_calling',
    url: 'https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling'
  }),
  Object.freeze({
    source_id: 'agents_guide',
    url: 'https://developers.openai.com/api/docs/guides/agents'
  }),
  Object.freeze({
    source_id: 'codex_skills',
    url: 'https://developers.openai.com/codex/skills'
  }),
  Object.freeze({
    source_id: 'codex_plugins',
    url: 'https://developers.openai.com/codex/plugins'
  }),
  Object.freeze({
    source_id: 'openai_plugins_repository',
    url: 'https://github.com/openai/plugins'
  })
] as const);

export const ALIGN_DEPRECATED_MIGRATION_SOURCES = Object.freeze([
  Object.freeze({
    source_id: 'openai_skills_repository',
    url: 'https://github.com/openai/skills',
    disposition: 'deprecated_migration_evidence'
  })
] as const);

export const ALIGN_WORKSTREAMS = Object.freeze([
  'latest_model_prompt_grammar',
  'programmatic_tool_calling',
  'agents_guidance',
  'plugins_guidance_and_skills_migration',
  'latest_only_cleanup',
  'deduplicate_prompt_config'
] as const);

export const ALIGN_REQUIRED_VERIFICATIONS = Object.freeze([
  'typecheck',
  'build',
  'focused_tests',
  'skill_surface_audit',
  'release_affected'
] as const);
export const ALIGN_PROMPT_EVALUATION_MIN_CASES = 12;

export type AlignWorkstream = (typeof ALIGN_WORKSTREAMS)[number];
export type AlignVerificationKind = (typeof ALIGN_REQUIRED_VERIFICATIONS)[number];
export type AlignOfficialSourceId = (typeof ALIGN_OFFICIAL_SOURCES)[number]['source_id'];
export type AlignDeprecatedSourceId = (typeof ALIGN_DEPRECATED_MIGRATION_SOURCES)[number]['source_id'];
export type AlignEvidenceStatus = 'pending' | 'pass' | 'fail';
export type AlignDecision = 'pending' | 'adopt' | 'do_not_adopt' | 'not_applicable';

export interface AlignPlan {
  schema: 'sks.align-plan.v2';
  schema_version: 2;
  generated_at: string;
  mission_id: string;
  task: string;
  official_sources: typeof ALIGN_OFFICIAL_SOURCES;
  deprecated_migration_sources: typeof ALIGN_DEPRECATED_MIGRATION_SOURCES;
  workstreams: readonly AlignWorkstream[];
  required_verifications: readonly AlignVerificationKind[];
  prompt_evaluation_min_cases: 12;
  surface_inventory: {
    commands: AlignSealedInventory;
    skills: AlignSealedInventory;
  };
  policy: {
    latest_only: true;
    no_legacy_compat: true;
    deduplicate: true;
    immutable_core_skills_protected: true;
    exhaustive_command_skill_audit: true;
    evidence_required: true;
  };
  next_actions: string[];
}

export interface AlignWorkstreamReceipt {
  workstream: AlignWorkstream;
  status: 'pending' | 'complete' | 'blocked';
  evidence: string[];
}

export interface AlignOfficialSourceReceipt {
  source_id: AlignOfficialSourceId;
  url: string;
  status: 'verified';
  retrieved_at: string;
  evidence: string[];
}

export interface AlignDeprecatedSourceReceipt {
  source_id: AlignDeprecatedSourceId;
  url: string;
  disposition: 'deprecated_migration_evidence';
  evidence: string[];
}

export interface AlignSurfaceCoverage {
  receipt_kind: 'exhaustive_inventory_audit';
  inventory_sha256: string;
  expected_count: number;
  audited_count: number;
  audited_surfaces: string[];
  missing_surfaces: string[];
  evidence: string[];
}

export interface AlignSealedInventory {
  count: number;
  sha256: string;
  surfaces: string[];
}

export interface AlignDecisionRecord {
  decision: AlignDecision;
  reason: string;
  evidence: string[];
}

export interface AlignLedger {
  schema: 'sks.align-ledger.v2';
  schema_version: 2;
  generated_at: string;
  mission_id: string;
  workstream_receipts: AlignWorkstreamReceipt[];
  official_source_receipts: AlignOfficialSourceReceipt[];
  deprecated_source_receipts: AlignDeprecatedSourceReceipt[];
  surface_coverage: {
    commands: AlignSurfaceCoverage;
    skills: AlignSurfaceCoverage;
  };
  decisions: {
    programmatic_tool_calling: AlignDecisionRecord;
    agents_sdk: AlignDecisionRecord;
  };
  prompt_evaluation: {
    status: AlignEvidenceStatus;
    cases_expected: number;
    cases_passed: number;
    failures: string[];
    evidence: string[];
  };
  immutable_core_integrity: {
    status: AlignEvidenceStatus;
    evidence: string[];
  };
  verification_receipts: Array<{
    kind: AlignVerificationKind;
    command: string;
    status: AlignEvidenceStatus;
    exit_code: number | null;
    evidence: string[];
  }>;
  changed_paths: string[];
  change_review: {
    outcome: 'pending' | 'changed' | 'none_required';
    evidence: string[];
  };
  deleted_legacy_settings: string[];
  deduplicated_surfaces: string[];
  deduplication_review: {
    outcome: 'pending' | 'deduplicated' | 'none_required';
    reviewed_surfaces: string[];
    evidence: string[];
  };
  blockers: string[];
  notes: string[];
}

export interface AlignGate {
  schema: 'sks.align-gate.v2';
  schema_version: 2;
  generated_at: string;
  mission_id: string;
  passed: boolean;
  ok: boolean;
  status: 'pass' | 'blocked';
  plan_present: boolean;
  ledger_present: boolean;
  mission_id_consistent: boolean;
  artifact_metadata_valid: boolean;
  official_source_plan_complete: boolean;
  deprecated_source_plan_complete: boolean;
  workstream_plan_complete: boolean;
  surface_inventory_plan_complete: boolean;
  verification_plan_complete: boolean;
  prompt_evaluation_plan_complete: boolean;
  policy_contract_complete: boolean;
  official_source_receipts_complete: boolean;
  deprecated_source_migration_recorded: boolean;
  deprecated_source_not_active: boolean;
  workstreams_complete: boolean;
  command_coverage_complete: boolean;
  skill_coverage_complete: boolean;
  programmatic_tool_calling_decision_recorded: boolean;
  agents_sdk_decision_recorded: boolean;
  prompt_evaluation_passed: boolean;
  immutable_core_integrity_passed: boolean;
  verification_receipts_passed: boolean;
  changed_paths_recorded: boolean;
  latest_only_cleanup_review_complete: boolean;
  deduplication_review_complete: boolean;
  ledger_blockers_clear: boolean;
  no_blockers: boolean;
  latest_only: boolean;
  no_legacy_compat: boolean;
  dedupe_recorded: boolean;
  blockers: string[];
}

export function buildAlignPlan(missionId: string, task: string): AlignPlan {
  const surfaceInventory = buildAlignSurfaceInventory();
  return {
    schema: 'sks.align-plan.v2',
    schema_version: 2,
    generated_at: nowIso(),
    mission_id: missionId,
    task: String(task || '').trim() || 'Align SKS prompts, settings, and skills to the latest GPT-5.6 official guides',
    official_sources: ALIGN_OFFICIAL_SOURCES,
    deprecated_migration_sources: ALIGN_DEPRECATED_MIGRATION_SOURCES,
    workstreams: ALIGN_WORKSTREAMS,
    required_verifications: ALIGN_REQUIRED_VERIFICATIONS,
    prompt_evaluation_min_cases: ALIGN_PROMPT_EVALUATION_MIN_CASES,
    surface_inventory: surfaceInventory,
    policy: {
      latest_only: true,
      no_legacy_compat: true,
      deduplicate: true,
      immutable_core_skills_protected: true,
      exhaustive_command_skill_audit: true,
      evidence_required: true
    },
    next_actions: [
      'Retrieve every exact official source and record a receipt with evidence',
      'Apply GPT-5.6 prompting, programmatic tool calling, Agents, Codex Skills, and Codex Plugins guidance',
      'Treat openai/skills only as deprecated migration evidence; use openai/plugins as the active repository',
      'Audit the plan-sealed command and skill inventories with exact exhaustive receipts and zero missing surfaces',
      'Record evidence-backed Programmatic Tool Calling and Agents SDK adoption decisions',
      `Run at least ${ALIGN_PROMPT_EVALUATION_MIN_CASES} prompt evaluation cases, immutable core integrity, and verification checks`,
      'Record changed paths; keep latest-version only, delete legacy settings, and record deduplication results or an evidenced none-required review',
      'Pass align-gate.json with mission-consistent evidence and no blockers, then finish with Honest Mode'
    ]
  };
}

export function buildAlignLedgerSeed(missionId: string): AlignLedger {
  const surfaceInventory = buildAlignSurfaceInventory();
  const emptyCoverage = (inventory: AlignSealedInventory): AlignSurfaceCoverage => ({
    receipt_kind: 'exhaustive_inventory_audit',
    inventory_sha256: inventory.sha256,
    expected_count: inventory.count,
    audited_count: 0,
    audited_surfaces: [],
    missing_surfaces: [...inventory.surfaces],
    evidence: []
  });
  const pendingDecision = (): AlignDecisionRecord => ({
    decision: 'pending',
    reason: '',
    evidence: []
  });
  return {
    schema: 'sks.align-ledger.v2',
    schema_version: 2,
    generated_at: nowIso(),
    mission_id: missionId,
    workstream_receipts: ALIGN_WORKSTREAMS.map((workstream) => ({
      workstream,
      status: 'pending',
      evidence: []
    })),
    official_source_receipts: [],
    deprecated_source_receipts: [],
    surface_coverage: {
      commands: emptyCoverage(surfaceInventory.commands),
      skills: emptyCoverage(surfaceInventory.skills)
    },
    decisions: {
      programmatic_tool_calling: pendingDecision(),
      agents_sdk: pendingDecision()
    },
    prompt_evaluation: {
      status: 'pending',
      cases_expected: 0,
      cases_passed: 0,
      failures: [],
      evidence: []
    },
    immutable_core_integrity: {
      status: 'pending',
      evidence: []
    },
    verification_receipts: [],
    changed_paths: [],
    change_review: {
      outcome: 'pending',
      evidence: []
    },
    deleted_legacy_settings: [],
    deduplicated_surfaces: [],
    deduplication_review: {
      outcome: 'pending',
      reviewed_surfaces: [],
      evidence: []
    },
    blockers: [],
    notes: []
  };
}

export function evaluateAlignGate(
  plan: AlignPlan | null,
  ledger: AlignLedger | null,
  missionId: string,
  options: { missionDir?: string } = {}
): AlignGate {
  const blockers: string[] = [];
  const officialSourceReceipts = arrayOrEmpty(ledger?.official_source_receipts);
  const deprecatedSourceReceipts = arrayOrEmpty(ledger?.deprecated_source_receipts);
  const workstreamReceipts = arrayOrEmpty(ledger?.workstream_receipts);
  const verificationReceipts = arrayOrEmpty(ledger?.verification_receipts);
  const currentSurfaceInventory = buildAlignSurfaceInventory();
  const planPresent = Boolean(plan && plan.schema === 'sks.align-plan.v2' && plan.schema_version === 2);
  const ledgerPresent = Boolean(ledger && ledger.schema === 'sks.align-ledger.v2' && ledger.schema_version === 2);
  if (!planPresent) blockers.push('align_plan_v2_missing');
  if (!ledgerPresent) blockers.push('align_ledger_v2_missing');

  const missionIdConsistent = Boolean(
    planPresent
    && ledgerPresent
    && missionId
    && plan?.mission_id === missionId
    && ledger?.mission_id === missionId
  );
  if (planPresent && ledgerPresent && !missionIdConsistent) blockers.push('align_mission_id_mismatch');
  const artifactMetadataValid = Boolean(
    planPresent
    && ledgerPresent
    && isIsoTimestamp(plan?.generated_at)
    && isIsoTimestamp(ledger?.generated_at)
    && isNonEmptyString(plan?.task)
  );
  if (!artifactMetadataValid) blockers.push('align_artifact_metadata_invalid');

  const officialSourcePlanComplete = hasExactSourceSet(
    plan?.official_sources,
    ALIGN_OFFICIAL_SOURCES
  );
  if (!officialSourcePlanComplete) blockers.push('align_official_source_plan_incomplete');

  const deprecatedSourcePlanComplete = hasExactDeprecatedSourceSet(
    plan?.deprecated_migration_sources,
    ALIGN_DEPRECATED_MIGRATION_SOURCES
  );
  if (!deprecatedSourcePlanComplete) blockers.push('align_deprecated_source_plan_incomplete');

  const workstreamPlanComplete = exactStringSet(plan?.workstreams, ALIGN_WORKSTREAMS);
  if (!workstreamPlanComplete) blockers.push('align_workstream_plan_incomplete');

  const surfaceInventoryPlanComplete = inventoryMatches(
    plan?.surface_inventory?.commands,
    currentSurfaceInventory.commands
  ) && inventoryMatches(
    plan?.surface_inventory?.skills,
    currentSurfaceInventory.skills
  );
  if (!surfaceInventoryPlanComplete) blockers.push('align_surface_inventory_plan_stale_or_incomplete');
  const verificationPlanComplete = exactStringSet(
    plan?.required_verifications,
    ALIGN_REQUIRED_VERIFICATIONS
  );
  if (!verificationPlanComplete) blockers.push('align_required_verification_plan_incomplete');
  const promptEvaluationPlanComplete = (
    plan?.prompt_evaluation_min_cases === ALIGN_PROMPT_EVALUATION_MIN_CASES
  );
  if (!promptEvaluationPlanComplete) blockers.push('align_prompt_evaluation_plan_incomplete');
  const policyContractComplete = Boolean(
    plan?.policy?.latest_only === true
    && plan?.policy?.no_legacy_compat === true
    && plan?.policy?.deduplicate === true
    && plan?.policy?.immutable_core_skills_protected === true
    && plan?.policy?.exhaustive_command_skill_audit === true
    && plan?.policy?.evidence_required === true
  );
  if (!policyContractComplete) blockers.push('align_policy_contract_incomplete');

  const deprecatedUrl = ALIGN_DEPRECATED_MIGRATION_SOURCES[0].url;
  const deprecatedSourceNotActive = !containsUrl(plan?.official_sources, deprecatedUrl)
    && !containsUrl(officialSourceReceipts, deprecatedUrl);
  if (!deprecatedSourceNotActive) blockers.push('deprecated_openai_skills_source_active');

  const officialSourceReceiptsComplete = ALIGN_OFFICIAL_SOURCES.every((required) => {
    const matches = officialSourceReceipts.filter((receipt) => (
      receipt?.source_id === required.source_id && receipt?.url === required.url
    ));
    return matches.length === 1
      && matches[0]?.status === 'verified'
      && isIsoTimestamp(matches[0]?.retrieved_at)
      && evidenceComplete(matches[0]?.evidence, options);
  }) && officialSourceReceipts.length === ALIGN_OFFICIAL_SOURCES.length;
  if (!officialSourceReceiptsComplete) blockers.push('align_official_source_receipts_incomplete');

  const deprecatedSourceMigrationRecorded = ALIGN_DEPRECATED_MIGRATION_SOURCES.every((required) => {
    const matches = deprecatedSourceReceipts.filter((receipt) => (
      receipt?.source_id === required.source_id && receipt?.url === required.url
    ));
    return matches.length === 1
      && matches[0]?.disposition === required.disposition
      && evidenceComplete(matches[0]?.evidence, options);
  }) && deprecatedSourceReceipts.length === ALIGN_DEPRECATED_MIGRATION_SOURCES.length;
  if (!deprecatedSourceMigrationRecorded) blockers.push('deprecated_openai_skills_migration_evidence_missing');

  const workstreamsComplete = ALIGN_WORKSTREAMS.every((required) => {
    const matches = workstreamReceipts.filter((receipt) => receipt?.workstream === required);
    return matches.length === 1
      && matches[0]?.status === 'complete'
      && evidenceComplete(matches[0]?.evidence, options);
  }) && workstreamReceipts.length === ALIGN_WORKSTREAMS.length;
  if (!workstreamsComplete) blockers.push('align_workstream_evidence_incomplete');

  const commandCoverageComplete = coverageComplete(
    ledger?.surface_coverage?.commands,
    plan?.surface_inventory?.commands,
    currentSurfaceInventory.commands,
    options
  );
  const skillCoverageComplete = coverageComplete(
    ledger?.surface_coverage?.skills,
    plan?.surface_inventory?.skills,
    currentSurfaceInventory.skills,
    options
  );
  if (!commandCoverageComplete) blockers.push('align_command_surface_coverage_incomplete');
  if (!skillCoverageComplete) blockers.push('align_skill_surface_coverage_incomplete');

  const programmaticToolCallingDecisionRecorded = decisionComplete(
    ledger?.decisions?.programmatic_tool_calling,
    options
  );
  const agentsSdkDecisionRecorded = decisionComplete(ledger?.decisions?.agents_sdk, options);
  if (!programmaticToolCallingDecisionRecorded) blockers.push('align_programmatic_tool_calling_decision_missing');
  if (!agentsSdkDecisionRecorded) blockers.push('align_agents_sdk_decision_missing');

  const promptEvaluationPassed = Boolean(
    promptEvaluationPlanComplete
    && ledger?.prompt_evaluation?.status === 'pass'
    && Number.isInteger(ledger.prompt_evaluation.cases_expected)
    && ledger.prompt_evaluation.cases_expected >= ALIGN_PROMPT_EVALUATION_MIN_CASES
    && ledger.prompt_evaluation.cases_passed === ledger.prompt_evaluation.cases_expected
    && Array.isArray(ledger.prompt_evaluation.failures)
    && ledger.prompt_evaluation.failures.length === 0
    && evidenceComplete(ledger.prompt_evaluation.evidence, options)
  );
  if (!promptEvaluationPassed) blockers.push('align_prompt_evaluation_not_passed');

  const immutableCoreIntegrityPassed = Boolean(
    ledger?.immutable_core_integrity?.status === 'pass'
    && evidenceComplete(ledger.immutable_core_integrity.evidence, options)
  );
  if (!immutableCoreIntegrityPassed) blockers.push('align_immutable_core_integrity_not_passed');

  const verificationReceiptsPassed = verificationPlanComplete
    && ALIGN_REQUIRED_VERIFICATIONS.every((kind) => {
      const matches = verificationReceipts.filter((receipt) => receipt?.kind === kind);
      return matches.length === 1
        && matches[0]?.status === 'pass'
        && matches[0]?.exit_code === 0
        && verificationCommandMatchesKind(kind, matches[0]?.command)
        && evidenceComplete(matches[0]?.evidence, options);
    })
    && verificationReceipts.length === ALIGN_REQUIRED_VERIFICATIONS.length;
  if (!verificationReceiptsPassed) blockers.push('align_verification_receipts_not_passed');

  const latestOnly = plan?.policy?.latest_only === true;
  const noLegacyCompat = plan?.policy?.no_legacy_compat === true;
  if (!latestOnly) blockers.push('latest_only_policy_missing');
  if (!noLegacyCompat) blockers.push('no_legacy_compat_policy_missing');

  const changedPaths = ledger?.changed_paths;
  const changeReview = ledger?.change_review;
  const changedPathsRecorded = Boolean(
    evidenceComplete(changeReview?.evidence, options)
    && (
      changeReview?.outcome === 'changed'
        ? hasUniqueStringList(changedPaths)
        : changeReview?.outcome === 'none_required'
          && hasUniqueStringList(changedPaths, { allowEmpty: true })
          && changedPaths.length === 0
    )
  );
  if (!changedPathsRecorded) blockers.push('align_changed_paths_missing');

  const latestOnlyCleanupReviewComplete = Boolean(
    workstreamReceiptComplete(ledger, 'latest_only_cleanup', options)
    && hasUniqueStringList(ledger?.deleted_legacy_settings, { allowEmpty: true })
  );
  if (!latestOnlyCleanupReviewComplete) blockers.push('align_latest_only_cleanup_review_incomplete');

  const deduplicatedSurfaces = ledger?.deduplicated_surfaces;
  const deduplicationReview = ledger?.deduplication_review;
  const reviewedSurfaces = deduplicationReview?.reviewed_surfaces;
  const deduplicationReviewComplete = Boolean(
    workstreamReceiptComplete(ledger, 'deduplicate_prompt_config', options)
    && hasUniqueStringList(reviewedSurfaces)
    && evidenceComplete(deduplicationReview?.evidence, options)
    && (
      deduplicationReview?.outcome === 'deduplicated'
        ? hasUniqueStringList(deduplicatedSurfaces)
          && deduplicatedSurfaces.every((surface) => reviewedSurfaces?.includes(surface))
        : deduplicationReview?.outcome === 'none_required'
          && hasUniqueStringList(deduplicatedSurfaces, { allowEmpty: true })
          && deduplicatedSurfaces.length === 0
    )
  );
  if (!deduplicationReviewComplete) blockers.push('dedupe_evidence_missing');
  const ledgerBlockersClear = Boolean(
    ledgerPresent
    && Array.isArray(ledger?.blockers)
    && ledger.blockers.length === 0
  );
  if (ledgerPresent && !Array.isArray(ledger?.blockers)) blockers.push('align_blocker_ledger_missing');
  if (Array.isArray(ledger?.blockers) && ledger.blockers.length > 0) {
    blockers.push(...ledger.blockers.map((item) => `ledger:${item}`));
  }

  const passed = blockers.length === 0;
  return {
    schema: 'sks.align-gate.v2',
    schema_version: 2,
    generated_at: nowIso(),
    mission_id: missionId,
    passed,
    ok: passed,
    status: passed ? 'pass' : 'blocked',
    plan_present: planPresent,
    ledger_present: ledgerPresent,
    mission_id_consistent: missionIdConsistent,
    artifact_metadata_valid: artifactMetadataValid,
    official_source_plan_complete: officialSourcePlanComplete,
    deprecated_source_plan_complete: deprecatedSourcePlanComplete,
    workstream_plan_complete: workstreamPlanComplete,
    surface_inventory_plan_complete: surfaceInventoryPlanComplete,
    official_source_receipts_complete: officialSourceReceiptsComplete,
    deprecated_source_migration_recorded: deprecatedSourceMigrationRecorded,
    deprecated_source_not_active: deprecatedSourceNotActive,
    workstreams_complete: workstreamsComplete,
    command_coverage_complete: commandCoverageComplete,
    skill_coverage_complete: skillCoverageComplete,
    verification_plan_complete: verificationPlanComplete,
    prompt_evaluation_plan_complete: promptEvaluationPlanComplete,
    policy_contract_complete: policyContractComplete,
    programmatic_tool_calling_decision_recorded: programmaticToolCallingDecisionRecorded,
    agents_sdk_decision_recorded: agentsSdkDecisionRecorded,
    prompt_evaluation_passed: promptEvaluationPassed,
    immutable_core_integrity_passed: immutableCoreIntegrityPassed,
    verification_receipts_passed: verificationReceiptsPassed,
    changed_paths_recorded: changedPathsRecorded,
    latest_only_cleanup_review_complete: latestOnlyCleanupReviewComplete,
    deduplication_review_complete: deduplicationReviewComplete,
    ledger_blockers_clear: ledgerBlockersClear,
    no_blockers: passed,
    latest_only: latestOnly,
    no_legacy_compat: noLegacyCompat,
    dedupe_recorded: deduplicationReviewComplete,
    blockers
  };
}

export async function writeAlignRouteArtifacts(dir: string, missionId: string, task: string) {
  const plan = buildAlignPlan(missionId, task);
  const ledger = buildAlignLedgerSeed(missionId);
  const gate = evaluateAlignGate(plan, ledger, missionId, { missionDir: dir });
  await writeJsonAtomic(path.join(dir, ALIGN_PLAN_ARTIFACT), plan);
  await writeJsonAtomic(path.join(dir, ALIGN_LEDGER_ARTIFACT), ledger);
  await writeJsonAtomic(path.join(dir, ALIGN_GATE_ARTIFACT), gate);
  return { plan, ledger, gate };
}

export async function readAlignGate(dir: string) {
  return readJson(path.join(dir, ALIGN_GATE_ARTIFACT), null) as Promise<AlignGate | null>;
}

export async function refreshAlignGate(dir: string, missionId: string) {
  const plan = await readJson(path.join(dir, ALIGN_PLAN_ARTIFACT), null) as AlignPlan | null;
  const ledger = await readJson(path.join(dir, ALIGN_LEDGER_ARTIFACT), null) as AlignLedger | null;
  const gate = evaluateAlignGate(plan, ledger, missionId, { missionDir: dir });
  await writeJsonAtomic(path.join(dir, ALIGN_GATE_ARTIFACT), gate);
  return { plan, ledger, gate };
}

export function alignNextActionText(missionId: string): string {
  return [
    `Execute the $sks-align modernization mission ${missionId}.`,
    'Read align-plan.json and retrieve every exact active GPT-5.6, Programmatic Tool Calling, Agents, Codex Skills, Codex Plugins, and openai/plugins source.',
    'Treat openai/skills only as deprecated migration evidence. Audit every command and skill surface, record PTC and Agents SDK decisions,',
    'run prompt evaluation, immutable-core integrity, and verification checks, then pass the mission-consistent align-gate.json with no blockers.'
  ].join(' ');
}

function coverageComplete(
  coverage: AlignSurfaceCoverage | undefined,
  planInventory: AlignSealedInventory | undefined,
  currentInventory: AlignSealedInventory,
  options: { missionDir?: string }
): boolean {
  return Boolean(
    coverage
    && coverage.receipt_kind === 'exhaustive_inventory_audit'
    && inventoryMatches(planInventory, currentInventory)
    && coverage.inventory_sha256 === currentInventory.sha256
    && coverage.expected_count === currentInventory.count
    && coverage.audited_count === coverage.expected_count
    && exactStringSet(coverage.audited_surfaces, currentInventory.surfaces)
    && Array.isArray(coverage.missing_surfaces)
    && coverage.missing_surfaces.length === 0
    && evidenceComplete(coverage.evidence, options)
  );
}

function decisionComplete(
  record: AlignDecisionRecord | undefined,
  options: { missionDir?: string }
): boolean {
  return Boolean(
    record
    && record.decision !== 'pending'
    && ['adopt', 'do_not_adopt', 'not_applicable'].includes(record.decision)
    && isNonEmptyString(record.reason)
    && evidenceComplete(record.evidence, options)
  );
}

function workstreamReceiptComplete(
  ledger: AlignLedger | null,
  workstream: AlignWorkstream,
  options: { missionDir?: string }
): boolean {
  const matches = arrayOrEmpty(ledger?.workstream_receipts)
    .filter((receipt) => receipt?.workstream === workstream);
  return matches.length === 1
    && matches[0]?.status === 'complete'
    && evidenceComplete(matches[0]?.evidence, options);
}

function hasExactSourceSet(
  actual: readonly { source_id?: string; url?: string }[] | undefined,
  expected: readonly { source_id: string; url: string }[]
): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((required) => (
    actual.filter((source) => (
      source?.source_id === required.source_id && source?.url === required.url
    )).length === 1
  ));
}

function hasExactDeprecatedSourceSet(
  actual: readonly { source_id?: string; url?: string; disposition?: string }[] | undefined,
  expected: readonly { source_id: string; url: string; disposition: string }[]
): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((required) => (
    actual.filter((source) => (
      source?.source_id === required.source_id
      && source?.url === required.url
      && source?.disposition === required.disposition
    )).length === 1
  ));
}

function containsUrl(actual: readonly { url?: string }[] | undefined, url: string): boolean {
  return Array.isArray(actual) && actual.some((source) => source?.url === url);
}

function hasStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function hasUniqueStringList(
  value: unknown,
  options: { allowEmpty?: boolean } = {}
): value is string[] {
  if (!Array.isArray(value)) return false;
  if (!options.allowEmpty && value.length === 0) return false;
  if (!value.every(isNonEmptyString)) return false;
  if (!value.every((item) => item === item.trim())) return false;
  const normalized = value.map((item) => item.trim());
  return new Set(normalized).size === normalized.length;
}

function evidenceComplete(
  value: unknown,
  options: { missionDir?: string }
): value is string[] {
  if (!hasStringList(value)) return false;
  const references = value as string[];
  if (!references.every(isSafeMissionEvidenceReference)) return false;
  if (new Set(references).size !== references.length) return false;
  if (!options.missionDir) return true;
  const missionDir = path.resolve(options.missionDir);
  let realMissionDir: string;
  try {
    realMissionDir = fs.realpathSync(missionDir);
  } catch {
    return false;
  }
  return references.every((reference) => {
    const target = path.resolve(missionDir, reference);
    if (!isPathInside(missionDir, target)) return false;
    try {
      const realTarget = fs.realpathSync(target);
      if (!isPathInside(realMissionDir, realTarget)) return false;
      const stat = fs.lstatSync(target);
      return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
    } catch {
      return false;
    }
  });
}

function isSafeMissionEvidenceReference(value: string): boolean {
  if (!value.startsWith('evidence/') || value.includes('\\') || value.includes('\0')) return false;
  if (path.isAbsolute(value)) return false;
  const segments = value.split('/');
  return segments.length > 1
    && segments.every((segment) => (
      segment.length > 0
      && segment !== '.'
      && segment !== '..'
      && /^[a-zA-Z0-9._-]+$/.test(segment)
    ));
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function verificationCommandMatchesKind(
  kind: AlignVerificationKind,
  value: unknown
): boolean {
  if (!isNonEmptyString(value)) return false;
  const command = value.trim().replace(/\s+/g, ' ');
  if (/[;&|`$<>]/u.test(command)) return false;
  switch (kind) {
    case 'typecheck':
      return /^npm run typecheck(?: --silent)?$/.test(command);
    case 'build':
      return /^npm run build(?::(?:clean|incremental))?(?: --silent)?$/.test(command);
    case 'focused_tests':
      return /^(?:bun test(?: .+)?|npm test(?: -- .+)?)$/.test(command);
    case 'skill_surface_audit':
      return command === 'node ./dist/scripts/skill-surface-modernization-check.js';
    case 'release_affected':
      return /^npm run release:check:affected(?: --silent)?$/.test(command);
  }
}

function arrayOrEmpty<T>(value: T[] | readonly T[] | undefined): T[] {
  return Array.isArray(value) ? [...value] : [];
}

function buildAlignSurfaceInventory(): { commands: AlignSealedInventory; skills: AlignSealedInventory } {
  const commands = uniqueSorted(commandManifestNames());
  const skills = uniqueSorted(MANAGED_ROUTE_SKILL_NAMES);
  return {
    commands: sealedInventory(commands),
    skills: sealedInventory(skills)
  };
}

function sealedInventory(surfaces: string[]): AlignSealedInventory {
  return {
    count: surfaces.length,
    sha256: sha256(JSON.stringify(surfaces)),
    surfaces
  };
}

function inventoryMatches(
  actual: AlignSealedInventory | undefined,
  expected: AlignSealedInventory
): boolean {
  return Boolean(
    actual
    && actual.count === expected.count
    && actual.sha256 === expected.sha256
    && exactStringSet(actual.surfaces, expected.surfaces)
  );
}

function exactStringSet(actual: unknown, expected: readonly string[]): boolean {
  const expectedSorted = [...expected].sort();
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every(isNonEmptyString)
    && [...actual].sort().every((item, index) => item === expectedSorted[index]);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(isNonEmptyString))].sort();
}
