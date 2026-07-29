import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMANDS } from '../../../cli/command-registry.js';
import { COMMAND_MANIFEST_BY_NAME } from '../../../cli/command-manifest-lite.js';
import {
  CORE_SKILL_MANAGED_BEGIN,
  CORE_SKILL_MANAGED_END,
  buildSksCoreSkillManifest,
  isCoreSkillName,
  renderCoreSkillTemplate
} from '../../codex-native/core-skill-manifest.js';
import { syncCoreSkillsIntegrity } from '../../codex-native/core-skill-integrity.js';
import { createMission } from '../../mission.js';
import { prepareRoute } from '../../pipeline-internals/runtime-core.js';
import { DOLLAR_COMMANDS_LITE } from '../../routes/dollar-manifest-lite.js';
import {
  MANAGED_ROUTE_SKILL_NAMES,
  routePrompt,
  reflectionRequiredForRoute
} from '../../routes.js';
import {
  ALIGN_DEPRECATED_MIGRATION_SOURCES,
  ALIGN_GATE_ARTIFACT,
  ALIGN_LEDGER_ARTIFACT,
  ALIGN_OFFICIAL_SOURCES,
  ALIGN_PLAN_ARTIFACT,
  ALIGN_PROMPT_EVALUATION_MIN_CASES,
  ALIGN_REQUIRED_VERIFICATIONS,
  ALIGN_WORKSTREAMS,
  buildAlignLedgerSeed,
  buildAlignPlan,
  evaluateAlignGate
} from '../../align/align-route.js';
import { alignCommand } from '../align-command.js';

test('align is registered as an immutable core skill with doctor/update/setup locks', () => {
  assert.equal(isCoreSkillName('sks-align'), true);
  const body = renderCoreSkillTemplate('sks-align');
  assert.match(body, new RegExp(CORE_SKILL_MANAGED_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(body, new RegExp(CORE_SKILL_MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(body, /mutable_by_doctor: false/);
  assert.match(body, /mutable_by_update: false/);
  assert.match(body, /mutable_by_setup: false/);
  assert.match(body, /Route: \$sks-align/);
  assert.match(body, /CLI entrypoint: sks align prepare\|run\|status\|proof/);
  assert.match(body, /work-order-ledger\.json/);
  assert.match(body, /completion-proof\.json/);

  const manifest = buildSksCoreSkillManifest('1970-01-01T00:00:00.000Z');
  const row = manifest.skills.find((skill) => skill.canonical_name === 'sks-align');
  assert.ok(row);
  assert.equal(row?.mutable_by_doctor, false);
  assert.equal(row?.mutable_by_update, false);
  assert.equal(row?.mutable_by_setup, false);
  assert.equal(row?.route, '$sks-align');
});

test('align dollar route, CLI command, and lite manifest stay wired together', () => {
  const routed = routePrompt('$sks-align modernize prompts and skills');
  assert.equal(routed?.id, 'Align');
  assert.equal(routed?.command, '$Align');
  assert.equal(routed?.stopGate, 'align-gate.json');
  assert.ok(routed?.requiredSkills.includes('sks-align'));
  assert.ok(routed?.lifecycle.includes('codex_skills_and_plugins'));
  assert.equal(routed?.lifecycle.includes('openai_skills_and_plugins'), false);
  assert.equal(reflectionRequiredForRoute(routed), true);

  assert.ok(COMMANDS.align);
  assert.equal(COMMAND_MANIFEST_BY_NAME.align?.name, 'align');
  assert.equal(COMMANDS.align.mutatesRouteState, true);
  assert.deepEqual(COMMANDS.align.ownedGateFiles, ['align-gate.json']);

  const lite = DOLLAR_COMMANDS_LITE.find((entry) => entry.command === '$sks-align');
  assert.ok(lite);
  assert.match(String(lite?.description || ''), /GPT-5\.6|openai\/plugins|modernization/i);
});

test('sks align prepare creates mission artifacts through the official prepareRoute path', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-align-prepare-'));
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    await fsp.mkdir(path.join(root, '.sneakoscope', 'wiki'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), JSON.stringify({
      attention: { use_first: [], hydrate_first: [] }
    }));

    const prepared: any = await prepareRoute(root, '$sks-align align prompts to latest GPT-5.6', {});
    assert.equal(prepared.route.id, 'Align');
    assert.ok(prepared.mission_id);
    const dir = path.join(root, '.sneakoscope', 'missions', prepared.mission_id);
    const plan = JSON.parse(await fsp.readFile(path.join(dir, ALIGN_PLAN_ARTIFACT), 'utf8'));
    const ledger = JSON.parse(await fsp.readFile(path.join(dir, ALIGN_LEDGER_ARTIFACT), 'utf8'));
    const workOrderLedger = JSON.parse(await fsp.readFile(path.join(dir, 'work-order-ledger.json'), 'utf8'));
    const gate = JSON.parse(await fsp.readFile(path.join(dir, ALIGN_GATE_ARTIFACT), 'utf8'));
    const routeContext = JSON.parse(await fsp.readFile(path.join(dir, 'route-context.json'), 'utf8'));
    assert.equal(plan.schema, 'sks.align-plan.v2');
    assert.equal(plan.schema_version, 2);
    assert.equal(plan.policy.latest_only, true);
    assert.equal(plan.policy.no_legacy_compat, true);
    assert.deepEqual(plan.official_sources, ALIGN_OFFICIAL_SOURCES);
    assert.deepEqual(plan.deprecated_migration_sources, ALIGN_DEPRECATED_MIGRATION_SOURCES);
    assert.deepEqual(plan.required_verifications, ALIGN_REQUIRED_VERIFICATIONS);
    assert.equal(plan.prompt_evaluation_min_cases, ALIGN_PROMPT_EVALUATION_MIN_CASES);
    assert.deepEqual(routeContext.required_verifications, ALIGN_REQUIRED_VERIFICATIONS);
    assert.equal(routeContext.prompt_evaluation_min_cases, ALIGN_PROMPT_EVALUATION_MIN_CASES);
    assert.equal(routeContext.artifacts.work_order_ledger, 'work-order-ledger.json');
    assert.equal(plan.official_sources.some((source: any) => source.url === 'https://github.com/openai/skills'), false);
    assert.equal(ledger.schema, 'sks.align-ledger.v2');
    assert.equal(ledger.schema_version, 2);
    assert.equal(workOrderLedger.route, '$Align');
    assert.equal(workOrderLedger.source_inventory_complete, true);
    assert.equal(workOrderLedger.items.length, 1);
    assert.equal(workOrderLedger.items[0].source.verbatim, 'align prompts to latest GPT-5.6');
    assert.equal(workOrderLedger.items[0].status, 'pending');
    assert.ok(plan.surface_inventory.commands.count > 1);
    assert.deepEqual(
      plan.surface_inventory.skills.surfaces,
      [...MANAGED_ROUTE_SKILL_NAMES].sort()
    );
    assert.equal(ledger.surface_coverage.commands.expected_count, plan.surface_inventory.commands.count);
    assert.equal(ledger.surface_coverage.commands.audited_count, 0);
    assert.deepEqual(ledger.surface_coverage.commands.missing_surfaces, plan.surface_inventory.commands.surfaces);
    assert.equal(gate.passed, false);
    assert.equal(gate.schema, 'sks.align-gate.v2');
    assert.equal(gate.ledger_blockers_clear, true);
    assert.equal(gate.no_blockers, false);
    assert.ok(gate.blockers.length > 0);
    assert.ok(gate.blockers.includes('align_workstream_evidence_incomplete'));
    assert.ok(gate.blockers.includes('align_official_source_receipts_incomplete'));
    assert.ok(gate.blockers.includes('align_command_surface_coverage_incomplete'));
    assert.ok(gate.blockers.includes('align_prompt_evaluation_not_passed'));
    assert.ok(gate.blockers.includes('align_verification_receipts_not_passed'));
    assert.ok(gate.blockers.includes('align_changed_paths_missing'));
    assert.ok(gate.blockers.includes('dedupe_evidence_missing'));
    assert.match(String(prepared.additionalContext || ''), /align-plan\.json|latest GPT-5\.6|openai\/plugins/i);
  } finally {
    process.chdir(previousCwd);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('align CLI prepare --json returns a mission and gate paths', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-align-cli-'));
  const previousCwd = process.cwd();
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    process.chdir(root);
    console.log = (...parts: unknown[]) => {
      logs.push(parts.map(String).join(' '));
    };
    await fsp.mkdir(path.join(root, '.sneakoscope', 'wiki'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), JSON.stringify({
      attention: { use_first: [], hydrate_first: [] }
    }));

    const result: any = await alignCommand('prepare', ['modernize skills', '--json']);
    assert.equal(result.ok, true);
    assert.ok(result.mission_id);
    assert.equal(result.route, '$sks-align');
    assert.match(String(result.artifacts?.gate || ''), /align-gate\.json$/);
    assert.match(String(result.artifacts?.work_order_ledger || ''), /work-order-ledger\.json$/);
    assert.ok(logs.some((line) => line.includes('"schema": "sks.align-command.v2"') || line.includes('"ok": true')));
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('align latest is route-scoped and explicit foreign mission ids fail without mutation', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-align-scope-'));
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  const originalError = console.error;
  try {
    process.chdir(root);
    console.log = () => {};
    console.error = () => {};
    process.exitCode = 0;
    await fsp.mkdir(path.join(root, '.sneakoscope', 'wiki'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), JSON.stringify({
      attention: { use_first: [], hydrate_first: [] }
    }));

    const align: any = await prepareRoute(root, '$sks-align route-scoped latest', {});
    const foreign: any = await createMission(root, {
      mode: 'research',
      prompt: 'newer non-align mission'
    });

    const latest: any = await alignCommand('status', ['latest', '--json']);
    assert.equal(latest.ok, true);
    assert.equal(latest.mission_id, align.mission_id);

    const rejected: any = await alignCommand('proof', [foreign.id, '--json']);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'align_mission_missing');
    await assert.rejects(
      fsp.access(path.join(foreign.dir, ALIGN_GATE_ARTIFACT))
    );
    await assert.rejects(
      fsp.access(path.join(foreign.dir, 'completion-proof.json'))
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = previousExitCode ?? 0;
    process.chdir(previousCwd);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('core skill integrity restores a drifted sks-align skill and never treats it as doctor-mutable', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-align-integrity-'));
  const root = path.join(fixture, 'home');
  const skillFile = path.join(root, '.agents', 'skills', 'sks-align', 'SKILL.md');
  const drifted = `${renderCoreSkillTemplate('sks-align')}mutated-by-doctor\n`;
  try {
    await fsp.mkdir(path.dirname(skillFile), { recursive: true });
    await fsp.writeFile(skillFile, drifted, 'utf8');

    const report = await syncCoreSkillsIntegrity({
      root,
      apply: true,
      skillsRoot: path.join(root, '.agents', 'skills')
    });

    const row = report.rows.find((entry) => entry.canonical_name === 'sks-align');
    assert.equal(report.ok, true);
    assert.equal(row?.action, 'restore-corrupted-managed-copy');
    assert.equal(await fsp.readFile(skillFile, 'utf8'), renderCoreSkillTemplate('sks-align'));
    assert.equal(buildSksCoreSkillManifest().skills.find((skill) => skill.canonical_name === 'sks-align')?.mutable_by_doctor, false);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('align v2 seed cannot pass by listing completed workstream names', () => {
  const plan = buildAlignPlan('M-align', 'fixture');
  const weakLedger = {
    schema: 'sks.align-ledger.v2',
    schema_version: 2,
    generated_at: '1970-01-01T00:00:00.000Z',
    mission_id: 'M-align',
    completed_workstreams: [...ALIGN_WORKSTREAMS],
    blockers: []
  };
  const incomplete = evaluateAlignGate(plan, weakLedger as any, 'M-align');
  assert.equal(incomplete.passed, false);
  assert.ok(incomplete.blockers.includes('align_workstream_evidence_incomplete'));
  assert.ok(incomplete.blockers.includes('align_official_source_receipts_incomplete'));
  assert.ok(incomplete.blockers.includes('align_command_surface_coverage_incomplete'));
  assert.ok(incomplete.blockers.includes('align_agents_sdk_decision_missing'));
  assert.ok(incomplete.blockers.includes('align_prompt_evaluation_not_passed'));
  assert.ok(incomplete.blockers.includes('align_immutable_core_integrity_not_passed'));
  assert.ok(incomplete.blockers.includes('align_verification_receipts_not_passed'));
});

test('align v2 gate passes only a fully evidenced mission-consistent ledger', () => {
  const plan = buildAlignPlan('M-align', 'fixture');
  const ledger = passingLedger('M-align');
  const gate = evaluateAlignGate(plan, ledger, 'M-align');
  assert.equal(gate.passed, true);
  assert.equal(gate.status, 'pass');
  assert.deepEqual(gate.blockers, []);
  assert.equal(gate.official_source_receipts_complete, true);
  assert.equal(gate.deprecated_source_migration_recorded, true);
  assert.equal(gate.deprecated_source_not_active, true);
  assert.equal(gate.command_coverage_complete, true);
  assert.equal(gate.skill_coverage_complete, true);
  assert.equal(gate.artifact_metadata_valid, true);
  assert.equal(gate.workstream_plan_complete, true);
  assert.equal(gate.surface_inventory_plan_complete, true);
  assert.equal(gate.verification_plan_complete, true);
  assert.equal(gate.prompt_evaluation_plan_complete, true);
  assert.equal(gate.policy_contract_complete, true);
  assert.equal(gate.programmatic_tool_calling_decision_recorded, true);
  assert.equal(gate.agents_sdk_decision_recorded, true);
  assert.equal(gate.prompt_evaluation_passed, true);
  assert.equal(gate.immutable_core_integrity_passed, true);
  assert.equal(gate.verification_receipts_passed, true);
  assert.equal(gate.changed_paths_recorded, true);
  assert.equal(gate.latest_only_cleanup_review_complete, true);
  assert.equal(gate.deduplication_review_complete, true);
  assert.equal(gate.ledger_blockers_clear, true);
  assert.equal(gate.no_blockers, true);

  const noneRequired = passingLedger('M-align');
  noneRequired.deduplicated_surfaces = [];
  noneRequired.deduplication_review = {
    outcome: 'none_required',
    reviewed_surfaces: ['src/core/example.ts'],
    evidence: ['evidence/deduplication-none-required-review.json']
  };
  assert.equal(evaluateAlignGate(plan, noneRequired, 'M-align').passed, true);

  const noChangesRequired = passingLedger('M-align');
  noChangesRequired.changed_paths = [];
  noChangesRequired.change_review = {
    outcome: 'none_required',
    evidence: ['evidence/change-none-required-review.json']
  };
  assert.equal(evaluateAlignGate(plan, noChangesRequired, 'M-align').passed, true);
});

test('align v2 gate rejects missing surfaces, deprecated active guidance, and mission drift', () => {
  const plan = buildAlignPlan('M-align', 'fixture');

  const missingSurface = passingLedger('M-align');
  missingSurface.surface_coverage.commands.missing_surfaces = ['$sks-missing'];
  missingSurface.surface_coverage.commands.audited_count -= 1;
  missingSurface.surface_coverage.commands.audited_surfaces.pop();
  const missingSurfaceGate = evaluateAlignGate(plan, missingSurface, 'M-align');
  assert.ok(missingSurfaceGate.blockers.includes('align_command_surface_coverage_incomplete'));

  const deprecatedActive = passingLedger('M-align');
  const firstOfficialReceipt = deprecatedActive.official_source_receipts[0];
  assert.ok(firstOfficialReceipt);
  deprecatedActive.official_source_receipts[0] = {
    ...firstOfficialReceipt,
    url: 'https://github.com/openai/skills'
  };
  const deprecatedActiveGate = evaluateAlignGate(plan, deprecatedActive, 'M-align');
  assert.ok(deprecatedActiveGate.blockers.includes('deprecated_openai_skills_source_active'));
  assert.ok(deprecatedActiveGate.blockers.includes('align_official_source_receipts_incomplete'));

  const missionDrift = passingLedger('M-other');
  const missionDriftGate = evaluateAlignGate(plan, missionDrift, 'M-align');
  assert.ok(missionDriftGate.blockers.includes('align_mission_id_mismatch'));

  const missingBlockerLedger = passingLedger('M-align') as any;
  delete missingBlockerLedger.blockers;
  const missingBlockerLedgerGate = evaluateAlignGate(plan, missingBlockerLedger, 'M-align');
  assert.ok(missingBlockerLedgerGate.blockers.includes('align_blocker_ledger_missing'));

  const inventedCounts = passingLedger('M-align');
  inventedCounts.surface_coverage.commands = {
    receipt_kind: 'exhaustive_inventory_audit',
    inventory_sha256: 'invented',
    expected_count: 1,
    audited_count: 1,
    audited_surfaces: ['align'],
    missing_surfaces: [],
    evidence: ['evidence/invented-audit.json']
  };
  const inventedCountsGate = evaluateAlignGate(plan, inventedCounts, 'M-align');
  assert.ok(inventedCountsGate.blockers.includes('align_command_surface_coverage_incomplete'));
});

test('align v2 gate seals workstreams, policy, artifact metadata, and mutation inventories', () => {
  const plan = buildAlignPlan('M-align', 'fixture');

  const missingWorkstream = {
    ...plan,
    workstreams: plan.workstreams.slice(1)
  };
  assert.ok(
    evaluateAlignGate(missingWorkstream as any, passingLedger('M-align'), 'M-align').blockers
      .includes('align_workstream_plan_incomplete')
  );

  const weakenedPolicy = {
    ...plan,
    policy: {
      ...plan.policy,
      evidence_required: false
    }
  };
  assert.ok(
    evaluateAlignGate(weakenedPolicy as any, passingLedger('M-align'), 'M-align').blockers
      .includes('align_policy_contract_incomplete')
  );

  const malformedMetadata = {
    ...plan,
    generated_at: 'not-an-iso-timestamp'
  };
  assert.ok(
    evaluateAlignGate(malformedMetadata as any, passingLedger('M-align'), 'M-align').blockers
      .includes('align_artifact_metadata_invalid')
  );

  const missingCleanupInventory = passingLedger('M-align') as any;
  delete missingCleanupInventory.deleted_legacy_settings;
  assert.ok(
    evaluateAlignGate(plan, missingCleanupInventory, 'M-align').blockers
      .includes('align_latest_only_cleanup_review_incomplete')
  );

  const duplicateChangedPath = passingLedger('M-align');
  duplicateChangedPath.changed_paths = ['src/core/example.ts', 'src/core/example.ts'];
  assert.ok(
    evaluateAlignGate(plan, duplicateChangedPath, 'M-align').blockers
      .includes('align_changed_paths_missing')
  );

  const missingChangeReview = passingLedger('M-align') as any;
  delete missingChangeReview.change_review;
  assert.ok(
    evaluateAlignGate(plan, missingChangeReview, 'M-align').blockers
      .includes('align_changed_paths_missing')
  );

  const unrelatedDeduplication = passingLedger('M-align');
  unrelatedDeduplication.deduplicated_surfaces = ['src/core/other.ts'];
  assert.ok(
    evaluateAlignGate(plan, unrelatedDeduplication, 'M-align').blockers
      .includes('dedupe_evidence_missing')
  );
});

test('align v2 gate requires reasoned PTC and Agents SDK dispositions plus passing receipts', () => {
  const plan = buildAlignPlan('M-align', 'fixture');
  const ledger = passingLedger('M-align');
  ledger.decisions.programmatic_tool_calling.reason = '';
  ledger.decisions.agents_sdk.evidence = [];
  ledger.prompt_evaluation.cases_passed = 1;
  ledger.immutable_core_integrity.evidence = [];
  const firstVerificationReceipt = ledger.verification_receipts[0];
  assert.ok(firstVerificationReceipt);
  firstVerificationReceipt.exit_code = 1;
  const gate = evaluateAlignGate(plan, ledger, 'M-align');
  assert.ok(gate.blockers.includes('align_programmatic_tool_calling_decision_missing'));
  assert.ok(gate.blockers.includes('align_agents_sdk_decision_missing'));
  assert.ok(gate.blockers.includes('align_prompt_evaluation_not_passed'));
  assert.ok(gate.blockers.includes('align_immutable_core_integrity_not_passed'));
  assert.ok(gate.blockers.includes('align_verification_receipts_not_passed'));
});

test('align v2 gate requires each sealed verification kind exactly once', () => {
  const plan = buildAlignPlan('M-align', 'fixture');
  const missingPlanKind = {
    ...plan,
    required_verifications: ALIGN_REQUIRED_VERIFICATIONS.slice(1)
  };
  const missingPlanGate = evaluateAlignGate(missingPlanKind as any, passingLedger('M-align'), 'M-align');
  assert.ok(missingPlanGate.blockers.includes('align_required_verification_plan_incomplete'));
  assert.ok(missingPlanGate.blockers.includes('align_verification_receipts_not_passed'));

  const weakPromptPlan = {
    ...plan,
    prompt_evaluation_min_cases: ALIGN_PROMPT_EVALUATION_MIN_CASES - 1
  };
  const weakPromptPlanGate = evaluateAlignGate(weakPromptPlan as any, passingLedger('M-align'), 'M-align');
  assert.ok(weakPromptPlanGate.blockers.includes('align_prompt_evaluation_plan_incomplete'));
  assert.ok(weakPromptPlanGate.blockers.includes('align_prompt_evaluation_not_passed'));

  const duplicateKind = passingLedger('M-align');
  const firstKind = duplicateKind.verification_receipts[0]?.kind;
  assert.ok(firstKind);
  duplicateKind.verification_receipts[duplicateKind.verification_receipts.length - 1]!.kind = firstKind;
  const duplicateGate = evaluateAlignGate(plan, duplicateKind, 'M-align');
  assert.ok(duplicateGate.blockers.includes('align_verification_receipts_not_passed'));

  const mislabeledCommand = passingLedger('M-align');
  mislabeledCommand.verification_receipts[0]!.command = 'printf pass';
  assert.ok(
    evaluateAlignGate(plan, mislabeledCommand, 'M-align').blockers
      .includes('align_verification_receipts_not_passed')
  );

  const shellChainedFocusedTest = passingLedger('M-align');
  shellChainedFocusedTest.verification_receipts
    .find((receipt) => receipt.kind === 'focused_tests')!.command = 'bun test src/core && echo pass';
  assert.ok(
    evaluateAlignGate(plan, shellChainedFocusedTest, 'M-align').blockers
      .includes('align_verification_receipts_not_passed')
  );
});

test('align v2 gate rejects malformed timestamps and unsafe evidence references', () => {
  const plan = buildAlignPlan('M-align', 'fixture');
  const malformedTimestamp = passingLedger('M-align');
  malformedTimestamp.official_source_receipts[0]!.retrieved_at = 'July 29, 2026';
  assert.ok(
    evaluateAlignGate(plan, malformedTimestamp, 'M-align').blockers
      .includes('align_official_source_receipts_incomplete')
  );

  const traversal = passingLedger('M-align');
  traversal.decisions.programmatic_tool_calling.evidence = ['evidence/../outside.json'];
  assert.ok(
    evaluateAlignGate(plan, traversal, 'M-align').blockers
      .includes('align_programmatic_tool_calling_decision_missing')
  );

  const absolute = passingLedger('M-align');
  absolute.prompt_evaluation.evidence = ['/tmp/evidence.json'];
  assert.ok(
    evaluateAlignGate(plan, absolute, 'M-align').blockers
      .includes('align_prompt_evaluation_not_passed')
  );

  const duplicateEvidence = passingLedger('M-align');
  duplicateEvidence.immutable_core_integrity.evidence = [
    'evidence/immutable-core-integrity.json',
    'evidence/immutable-core-integrity.json'
  ];
  assert.ok(
    evaluateAlignGate(plan, duplicateEvidence, 'M-align').blockers
      .includes('align_immutable_core_integrity_not_passed')
  );

  const controlCharacter = passingLedger('M-align');
  controlCharacter.decisions.agents_sdk.evidence = ['evidence/decisions/agents\nsdk.md'];
  assert.ok(
    evaluateAlignGate(plan, controlCharacter, 'M-align').blockers
      .includes('align_agents_sdk_decision_missing')
  );
});

test('align v2 runtime gate requires non-empty mission-local evidence without symlink escapes', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-align-evidence-'));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-align-outside-'));
  try {
    const plan = buildAlignPlan('M-align', 'fixture');
    const ledger = passingLedger('M-align');
    await writeLedgerEvidence(root, ledger);
    assert.equal(evaluateAlignGate(plan, ledger, 'M-align', { missionDir: root }).passed, true);

    const missingEvidence = ledger.verification_receipts[0]!.evidence[0]!;
    await fsp.rm(path.join(root, missingEvidence));
    assert.ok(
      evaluateAlignGate(plan, ledger, 'M-align', { missionDir: root }).blockers
        .includes('align_verification_receipts_not_passed')
    );

    await fsp.writeFile(path.join(root, missingEvidence), '');
    assert.ok(
      evaluateAlignGate(plan, ledger, 'M-align', { missionDir: root }).blockers
        .includes('align_verification_receipts_not_passed')
    );

    await fsp.writeFile(path.join(root, missingEvidence), '{"ok":true}\n');
    const sourceEvidence = ledger.official_source_receipts[0]!.evidence[0]!;
    await fsp.rm(path.join(root, sourceEvidence));
    const outsideEvidence = path.join(outside, 'source.json');
    await fsp.writeFile(outsideEvidence, '{"verified":true}\n');
    await fsp.symlink(outsideEvidence, path.join(root, sourceEvidence));
    assert.ok(
      evaluateAlignGate(plan, ledger, 'M-align', { missionDir: root }).blockers
        .includes('align_official_source_receipts_incomplete')
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test('align proof closes the work-order ledger only after a verified Completion Proof', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-align-proof-'));
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  try {
    process.chdir(root);
    console.log = () => {};
    process.exitCode = 0;
    await fsp.mkdir(path.join(root, '.sneakoscope', 'wiki'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), JSON.stringify({
      attention: { use_first: [], hydrate_first: [] }
    }));

    const prepared: any = await prepareRoute(root, '$sks-align verify the complete route', {});
    const dir = path.join(root, '.sneakoscope', 'missions', prepared.mission_id);
    const ledger = passingLedger(prepared.mission_id);
    await writeLedgerEvidence(dir, ledger);
    await fsp.writeFile(
      path.join(dir, ALIGN_LEDGER_ARTIFACT),
      `${JSON.stringify(ledger, null, 2)}\n`
    );

    const result: any = await alignCommand('proof', [prepared.mission_id, '--json']);
    assert.equal(result.ok, true, JSON.stringify(result.proof));
    const proof = JSON.parse(await fsp.readFile(path.join(dir, 'completion-proof.json'), 'utf8'));
    assert.equal(proof.status, 'verified');
    const trust = JSON.parse(await fsp.readFile(path.join(dir, 'trust-report.json'), 'utf8'));
    assert.equal(trust.ok, true, JSON.stringify(trust.issues));
    assert.equal(trust.status, 'verified');

    const workOrderLedger = JSON.parse(await fsp.readFile(
      path.join(dir, 'work-order-ledger.json'),
      'utf8'
    ));
    assert.equal(workOrderLedger.all_work_items_verified, true);
    assert.equal(workOrderLedger.all_work_items_resolved, true);
    assert.ok(workOrderLedger.items.every((item: any) => item.status === 'verified'));
    assert.ok(workOrderLedger.items.every((item: any) => item.blocker.blocked === false));
    assert.ok(workOrderLedger.items.every((item: any) => (
      item.verification_evidence.includes('completion-proof.json')
    )));
    assert.ok(workOrderLedger.items.every((item: any) => (
      item.verification_evidence.includes('trust-report.json')
    )));
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode ?? 0;
    process.chdir(previousCwd);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('align fixture writes a canonical honestly blocked Completion Proof', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-align-fixture-'));
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  try {
    process.chdir(root);
    console.log = () => {};
    process.exitCode = 0;
    await fsp.mkdir(path.join(root, '.sneakoscope', 'wiki'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), JSON.stringify({
      attention: { use_first: [], hydrate_first: [] }
    }));

    const result: any = await alignCommand('fixture', ['--json']);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.ok(result.mission_id);
    assert.equal(result.schema, 'sks.align-fixture.v2');
    assert.ok(result.blockers.includes('align_workstream_evidence_incomplete'));
    assert.ok(result.blockers.includes('align_official_source_receipts_incomplete'));

    const proof = JSON.parse(await fsp.readFile(path.join(
      root,
      '.sneakoscope',
      'missions',
      result.mission_id,
      'completion-proof.json'
    ), 'utf8'));
    assert.equal(proof.schema, 'sks.completion-proof.v1');
    assert.equal(proof.route, '$sks-align');
    assert.equal(proof.status, 'blocked');
    assert.ok(proof.blockers.includes('align_workstream_evidence_incomplete'));
    const workOrderLedger = JSON.parse(await fsp.readFile(path.join(
      root,
      '.sneakoscope',
      'missions',
      result.mission_id,
      'work-order-ledger.json'
    ), 'utf8'));
    assert.equal(workOrderLedger.all_work_items_resolved, true);
    assert.ok(workOrderLedger.items.every((item: any) => item.status === 'blocked'));
    assert.ok(workOrderLedger.items.every((item: any) => item.blocker.blocked === true));
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode ?? 0;
    process.chdir(previousCwd);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

function passingLedger(missionId: string) {
  const plan = buildAlignPlan(missionId, 'passing ledger inventory');
  const ledger = buildAlignLedgerSeed(missionId);
  ledger.workstream_receipts = ledger.workstream_receipts.map((receipt) => ({
    ...receipt,
    status: 'complete',
    evidence: [`evidence/workstreams/${receipt.workstream}.json`]
  }));
  ledger.official_source_receipts = ALIGN_OFFICIAL_SOURCES.map((source) => ({
    ...source,
    status: 'verified',
    retrieved_at: '2026-07-29T00:00:00.000Z',
    evidence: [`evidence/sources/${source.source_id}.json`]
  }));
  ledger.deprecated_source_receipts = ALIGN_DEPRECATED_MIGRATION_SOURCES.map((source) => ({
    ...source,
    evidence: [`evidence/deprecations/${source.source_id}.json`]
  }));
  ledger.surface_coverage = {
    commands: {
      receipt_kind: 'exhaustive_inventory_audit',
      inventory_sha256: plan.surface_inventory.commands.sha256,
      expected_count: plan.surface_inventory.commands.count,
      audited_count: plan.surface_inventory.commands.count,
      audited_surfaces: [...plan.surface_inventory.commands.surfaces],
      missing_surfaces: [],
      evidence: ['evidence/command-audit.json']
    },
    skills: {
      receipt_kind: 'exhaustive_inventory_audit',
      inventory_sha256: plan.surface_inventory.skills.sha256,
      expected_count: plan.surface_inventory.skills.count,
      audited_count: plan.surface_inventory.skills.count,
      audited_surfaces: [...plan.surface_inventory.skills.surfaces],
      missing_surfaces: [],
      evidence: ['evidence/skill-audit.json']
    }
  };
  ledger.decisions = {
    programmatic_tool_calling: {
      decision: 'adopt',
      reason: 'Bounded parallel retrieval benefits from programmatic orchestration.',
      evidence: ['evidence/decisions/programmatic-tool-calling.md']
    },
    agents_sdk: {
      decision: 'do_not_adopt',
      reason: 'The existing official Codex subagent runtime owns orchestration.',
      evidence: ['evidence/decisions/agents-sdk.md']
    }
  };
  ledger.prompt_evaluation = {
    status: 'pass',
    cases_expected: ALIGN_PROMPT_EVALUATION_MIN_CASES,
    cases_passed: ALIGN_PROMPT_EVALUATION_MIN_CASES,
    failures: [],
    evidence: ['evidence/prompt-evaluation.json']
  };
  ledger.immutable_core_integrity = {
    status: 'pass',
    evidence: ['evidence/immutable-core-integrity.json']
  };
  const verificationCommands = {
    typecheck: 'npm run typecheck',
    build: 'npm run build:incremental',
    focused_tests: 'bun test src/core/commands/__tests__/align-command.test.ts',
    skill_surface_audit: 'node ./dist/scripts/skill-surface-modernization-check.js',
    release_affected: 'npm run release:check:affected'
  } as const;
  ledger.verification_receipts = ALIGN_REQUIRED_VERIFICATIONS.map((kind) => ({
    kind,
    command: verificationCommands[kind],
    status: 'pass',
    exit_code: 0,
    evidence: [`evidence/verification/${kind}.txt`]
  }));
  ledger.changed_paths = ['src/core/example.ts'];
  ledger.change_review = {
    outcome: 'changed',
    evidence: ['evidence/change-review.json']
  };
  ledger.deduplicated_surfaces = ['src/core/example.ts'];
  ledger.deduplication_review = {
    outcome: 'deduplicated',
    reviewed_surfaces: ['src/core/example.ts'],
    evidence: ['evidence/deduplication-review.json']
  };
  return ledger;
}

async function writeLedgerEvidence(root: string, ledger: unknown) {
  const references = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === 'string' && value.startsWith('evidence/')) {
      references.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(ledger);
  for (const reference of references) {
    const target = path.join(root, reference);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, '{"verified":true}\n');
  }
}
