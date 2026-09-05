import path from 'node:path';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { printJson } from '../../cli/output.js';
import { appendJsonlBounded, exists, nowIso, readJson, readText, runProcess, sksRoot, writeJsonAtomic } from '../fsx.js';
import { initProject } from '../init.js';
import { createMission, findLatestMission, loadMission, setCurrent, stateFile } from '../mission.js';
import { RESEARCH_AGENT_COUNCIL, RESEARCH_SOURCE_SKILL_ARTIFACT, countResearchPaperSections, evaluateResearchGate, findResearchPaperArtifact, researchPaperArtifactForPlan, writeResearchPlan } from '../research.js';
import { ROUTES, reflectionRequiredForRoute, routeNeedsContext7, routePrompt, routeReasoning } from '../routes.js';
import { PIPELINE_PLAN_ARTIFACT, validatePipelinePlan, writePipelinePlan } from '../pipeline.js';
import { enforceRetention } from '../retention.js';
import { scanDbSafety } from '../db-safety.js';
import { maybeFinalizeRoute } from '../proof/auto-finalize.js';
import { flag, readFlagValue, resolveMissionId } from './command-utils.js';
import { writeResearchWorkGraph } from '../research/research-work-graph.js';
import { runResearchCycle } from '../research/research-cycle-runner.js';
import { readResearchQualityContract } from '../research/research-quality-contract.js';
import { readClaimEvidenceMatrix } from '../research/claim-evidence-matrix.js';
import { readSourceQualityReport } from '../research/source-quality-report.js';
import { readImplementationBlueprint, validateImplementationBlueprint } from '../research/implementation-blueprint.js';
import { readExperimentPlan, validateExperimentPlan } from '../research/experiment-plan.js';
import { readReplicationPack, validateReplicationPack } from '../research/replication-pack.js';
import { readResearchFinalReview } from '../research/research-final-reviewer.js';
import { evaluateGate } from '../stop-gate/gate-evaluator.js';
import {
  RESEARCH_ADVERSARIAL_PLAN_ARTIFACT,
  RESEARCH_ADVERSARIAL_REVIEW_ARTIFACT,
  RESEARCH_CONVERGENCE_GATE_ARTIFACT,
  RESEARCH_HONEST_MODE_ARTIFACT,
  RESEARCH_REVISION_LEDGER_ARTIFACT,
  buildResearchAdversarialPlan
} from '../research/research-adversarial-review.js';

const RESEARCH_DEFAULT_MAX_CYCLES = 3;
const RESEARCH_REVIEWER_COUNT = RESEARCH_AGENT_COUNCIL.length;
const RESEARCH_DEFAULT_CYCLE_TIMEOUT_MINUTES = 20;
const RESEARCH_MIN_CYCLE_TIMEOUT_MINUTES = 15;
const RESEARCH_MAX_CYCLE_TIMEOUT_MINUTES = 60;

export async function researchCommand(sub: any, args: any = []) {
  if (sub === 'prepare') return researchPrepare(args);
  if (sub === 'run') return researchRun(args);
  if (sub === 'status') return researchStatus(args);
  console.error('Usage: sks research <prepare|run|status>');
  process.exitCode = 1;
}

export async function autoresearchCommand(sub: any, args: any = []) {
  return researchCommand(sub || 'status', args);
}

const REMOVED_RESEARCH_RUNTIME_FLAGS = new Set([
  '--native-proof-only',
  '--legacy-research-cycle',
  '--work-items',
  '--target-active-slots',
  '--minimum-work-items',
  '--max-queue-expansion',
  '--profile',
  '--write-mode',
  '--parallel-write',
  '--apply-patches',
  '--dry-run-patches',
  '--dryrun-patches',
  '--max-write-agents',
  '--backend',
  '--backend-mode',
  '--provider',
  '--scheduler',
  '--scheduler-mode',
  '--pool',
  '--pool-size',
  '--model',
  '--parent-model',
  '--worker-model',
  '--concurrency'
]);

const RESEARCH_COMMAND_OPTIONS = Object.freeze({
  prepare: {
    booleans: new Set(['--json', '--autoresearch']),
    values: new Set(['--depth'])
  },
  run: {
    booleans: new Set(['--json', '--mock', '--autoresearch']),
    values: new Set(['--agents', '--max-threads', '--max-cycles', '--cycle-timeout-minutes', '--research-stage-parallelism'])
  },
  status: {
    booleans: new Set(['--json']),
    values: new Set<string>()
  }
});

export function parseResearchCommandArgs(sub: 'prepare' | 'run' | 'status', rawArgs: any[] = []) {
  const contract = RESEARCH_COMMAND_OPTIONS[sub];
  const args = rawArgs.map((arg) => String(arg));
  const normalizedArgs: string[] = [];
  const positionals: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    const optionName = arg.startsWith('--') ? arg.split('=', 1)[0] || arg : null;
    if (!optionName) {
      positionals.push(arg);
      normalizedArgs.push(arg);
      continue;
    }
    if (REMOVED_RESEARCH_RUNTIME_FLAGS.has(optionName)) {
      throw new Error(`Unsupported legacy Research runtime option: ${optionName}. Research now uses one read-only Super Search pipeline plus the Codex official subagent adversarial review workflow.`);
    }
    if (contract.booleans.has(optionName)) {
      if (arg.includes('=')) throw new Error(`Research option ${optionName} does not accept a value.`);
      if (seen.has(optionName)) throw new Error(`Duplicate Research option: ${optionName}.`);
      seen.add(optionName);
      normalizedArgs.push(optionName);
      continue;
    }
    if (contract.values.has(optionName)) {
      if (seen.has(optionName)) throw new Error(`Duplicate Research option: ${optionName}.`);
      seen.add(optionName);
      let value: string;
      if (arg.includes('=')) {
        value = arg.slice(arg.indexOf('=') + 1);
      } else {
        const next = args[index + 1];
        if (next === undefined || String(next).startsWith('--')) throw new Error(`Missing value for ${optionName}.`);
        value = String(next);
        index += 1;
      }
      if (!value.trim()) throw new Error(`Missing value for ${optionName}.`);
      normalizedArgs.push(optionName, value);
      continue;
    }
    throw new Error(`Unsupported Research option: ${optionName}.`);
  }
  if (sub === 'prepare' && positionals.join(' ').trim().length === 0) throw new Error('Missing research topic.');
  if ((sub === 'run' || sub === 'status') && positionals.length === 0) {
    throw new Error(`Missing Research ${sub === 'run' ? 'mission id' : 'status mission id'}.`);
  }
  if ((sub === 'run' || sub === 'status') && positionals.length > 1) {
    throw new Error(`Unexpected Research positional argument: ${positionals[1]}.`);
  }
  return { args: normalizedArgs, positionals };
}

async function researchPrepare(args: any) {
  const parsed = parseResearchCommandArgs('prepare', args);
  args = parsed.args;
  const root = await sksRoot();
  if (!(await exists(path.join(root, '.sneakoscope')))) await initProject(root, {});
  const prompt = parsed.positionals.join(' ').trim();
  const { id, dir } = await createMission(root, { mode: 'research', prompt });
  const route = ROUTES.find((entry: any) => entry.id === 'Research') || routePrompt('$Research');
  const context7Required = routeNeedsContext7(route, prompt);
  const reasoning = routeReasoning(route, prompt);
  const autoresearch = flag(args, '--autoresearch');
  const plan = await writeResearchPlan(dir, prompt, { root, depth: readFlagValue(args, '--depth', 'frontier'), missionId: id, autoresearch, context7Required });
  const officialSubagentPlan = buildResearchAdversarialPlan(plan, RESEARCH_DEFAULT_MAX_CYCLES, RESEARCH_REVIEWER_COUNT);
  await writeJsonAtomic(path.join(dir, RESEARCH_ADVERSARIAL_PLAN_ARTIFACT), officialSubagentPlan);
  const pipelinePlan = await writePipelinePlan(dir, { missionId: id, route, task: prompt, required: context7Required, ambiguity: { required: false, status: 'direct_research_cli' } });
  await writeJsonAtomic(path.join(dir, 'route-context.json'), {
    route: route.id,
    route_command: route.command,
    command: route.command,
    mode: route.mode,
    task: prompt,
    required_skills: route.requiredSkills,
    context7_required: context7Required,
    subagents_required: true,
    native_sessions_required: false,
    reflection_required: reflectionRequiredForRoute(route),
    original_stop_gate: route.stopGate,
    stop_gate: route.stopGate,
    clarification_gate: false,
    pipeline_plan_ready: validatePipelinePlan(pipelinePlan).ok,
    pipeline_plan_path: PIPELINE_PLAN_ARTIFACT,
    goal_continuation: pipelinePlan.goal_continuation
  });
  await setCurrent(root, {
    mission_id: id,
    route: route.id,
    route_command: route.command,
    mode: route.mode,
    phase: 'RESEARCH_PREPARED',
    questions_allowed: false,
    implementation_allowed: false,
    context7_required: context7Required,
    context7_verified: false,
    subagents_required: true,
    subagents_verified: false,
    native_sessions_required: false,
    native_sessions_verified: false,
    reflection_required: reflectionRequiredForRoute(route),
    visible_progress_required: true,
    context_tracking: 'triwiki',
    required_skills: route.requiredSkills,
    stop_gate: route.stopGate,
    reasoning_effort: reasoning.effort,
    reasoning_profile: reasoning.profile,
    reasoning_temporary: true,
    goal_continuation: pipelinePlan.goal_continuation,
    pipeline_plan_ready: validatePipelinePlan(pipelinePlan).ok,
    pipeline_plan_path: PIPELINE_PLAN_ARTIFACT,
    prompt
  });
  if (flag(args, '--json')) return printJson({
    schema: autoresearch ? 'sks.autoresearch-prepare.v1' : 'sks.research-prepare.v1',
    ok: true,
    mission_id: id,
    methodology: 'super-search-evidence-plus-official-subagent-adversarial-convergence',
    paper: researchPaperArtifactForPlan(plan),
    pipeline_plan: PIPELINE_PLAN_ARTIFACT,
    official_subagent_plan: officialSubagentPlan,
    honest_guarantees: officialSubagentPlan.guarantees
  });
  console.log(`Research mission created: ${id}`);
  console.log('Methodology: Super Search evidence + official subagent adversarial convergence');
  console.log(`Plan: ${path.relative(root, path.join(dir, 'research-plan.md'))}`);
  console.log(`Run: sks research run ${id} --max-cycles ${RESEARCH_DEFAULT_MAX_CYCLES} --cycle-timeout-minutes ${RESEARCH_DEFAULT_CYCLE_TIMEOUT_MINUTES}`);
}

async function researchRun(args: any) {
  const parsed = parseResearchCommandArgs('run', args);
  args = parsed.args;
  const root = await sksRoot();
  const id = await resolveResearchRunMissionId(root, parsed.positionals[0]);
  if (!id) throw new Error('Usage: sks research run <mission-id|latest> [--mock] [--agents 3] [--max-threads 1..3] [--max-cycles 1..3] [--cycle-timeout-minutes 15..60]');
  const { dir, mission } = await loadMission(root, id);
  const planPath = path.join(dir, 'research-plan.json');
  if (!(await exists(planPath))) await writeResearchPlan(dir, mission.prompt || '', { root, missionId: id, autoresearch: flag(args, '--autoresearch') });
  const plan: any = await readJson(planPath);
  const dbScan = await scanDbSafety(root);
  if (!dbScan.ok) {
    console.error('Research cannot run: DB Guardian found unsafe Supabase/MCP/database configuration.');
    console.error(JSON.stringify(dbScan.findings, null, 2));
    process.exitCode = 2;
    return;
  }
  const maxCycles = readStrictResearchIntegerFlag(args, '--max-cycles', RESEARCH_DEFAULT_MAX_CYCLES, 1, RESEARCH_DEFAULT_MAX_CYCLES);
  const requestedReviewers = readStrictResearchIntegerFlag(args, '--agents', RESEARCH_REVIEWER_COUNT, RESEARCH_REVIEWER_COUNT, RESEARCH_REVIEWER_COUNT);
  const maxThreads = readStrictResearchIntegerFlag(args, '--max-threads', requestedReviewers, 1, requestedReviewers);
  const cycleTimeoutMinutes = readResearchCycleTimeoutMinutes(args);
  const cycleTimeoutMs = cycleTimeoutMinutes * 60 * 1000;
  const mock = flag(args, '--mock');
  const researchWorkGraph = await writeResearchWorkGraph(dir, plan);
  await setCurrent(root, { mission_id: id, mode: 'RESEARCH', phase: 'RESEARCH_RUNNING_NO_QUESTIONS', questions_allowed: false, implementation_allowed: false, research_real_run_required: !mock, research_cycle_timeout_minutes: cycleTimeoutMinutes });
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), {
    ts: nowIso(),
    type: 'research.run.started',
    maxCycles,
    mock,
    cycleTimeoutMinutes,
    requestedReviewers,
    maxThreads,
    source_acquisition: 'super-search',
    reviewer_workflow: 'official_codex_subagent',
    real_run_required: !mock
  });
  const sourceMutationBaseline = await researchCodeMutationSnapshot(root, id);
  const cycleResult = await runResearchCycle({
    root,
    dir,
    plan,
    graph: researchWorkGraph,
    cycle: 1,
    backend: mock ? 'mock' : 'codex-sdk',
    timeoutMs: cycleTimeoutMs,
    maxParallelStages: readStrictResearchIntegerFlag(args, '--research-stage-parallelism', 4, 1, 8),
    maxReviewCycles: maxCycles,
    maxReviewThreads: maxThreads,
    mock
  });
  const mutation = await researchCodeMutationDelta(root, sourceMutationBaseline, id);
  if (mutation.blocked) {
    const blocker = {
      schema_version: 1,
      mission_id: id,
      ts: nowIso(),
      phase: 'RESEARCH_BLOCKED_CODE_MUTATION',
      reason: 'Research mode must not modify repository source files. Only route-local mission artifacts are allowed.',
      changed_paths: mutation.changed_paths,
      allowed_prefixes: mutation.allowed_prefixes,
      implementation_allowed: false
    };
    await writeJsonAtomic(path.join(dir, 'research-code-mutation-blocker.json'), blocker);
    await maybeFinalizeRoute(root, { missionId: id, route: '$Research', gateFile: 'research-gate.json', gate: await readJson(path.join(dir, 'research-gate.json'), null), artifacts: ['research-code-mutation-blocker.json', 'completion-proof.json'], statusHint: 'blocked', blockers: ['research_code_mutation_detected'], command: { cmd: `sks research run ${id}`, status: 2 }, agents: false });
    await setCurrent(root, { mission_id: id, mode: 'RESEARCH', phase: 'RESEARCH_BLOCKED_CODE_MUTATION', questions_allowed: true, implementation_allowed: false, blocker: 'research-code-mutation-blocker.json' });
    process.exitCode = 2;
    return;
  }
  const gate = await evaluateResearchGate(dir);
  const passed = cycleResult.status === 'passed' && gate.passed === true;
  const adversarial = await readJson(path.join(dir, RESEARCH_CONVERGENCE_GATE_ARTIFACT), null);
  const honestMode = gate.gate?.honest_mode
    ?? (gate as any).honest_mode
    ?? await readJson(path.join(dir, RESEARCH_HONEST_MODE_ARTIFACT), null);
  const proof = await maybeFinalizeRoute(root, {
    missionId: id,
    route: '$Research',
    gateFile: 'research-gate.json',
    gate: gate.gate || gate,
    artifacts: [
      'research-cycle-runner.json',
      'research-gate.json',
      'research-report.md',
      researchPaperArtifactForPlan(plan),
      'source-ledger.json',
      'claim-evidence-matrix.json',
      'implementation-blueprint.json',
      'naruto-handoff-goal.md',
      RESEARCH_ADVERSARIAL_REVIEW_ARTIFACT,
      RESEARCH_REVISION_LEDGER_ARTIFACT,
      RESEARCH_CONVERGENCE_GATE_ARTIFACT,
      RESEARCH_HONEST_MODE_ARTIFACT,
      'completion-proof.json'
    ],
    statusHint: passed ? undefined : 'blocked',
    blockers: passed ? [] : [...(cycleResult.blockers || []), ...(gate.reasons || [])],
    mock,
    agents: false,
    command: { cmd: `sks research run ${id}${mock ? ' --mock' : ''}`, status: passed ? 0 : 2 }
  });
  await setCurrent(root, {
    mission_id: id,
    mode: 'RESEARCH',
    phase: passed ? 'RESEARCH_DONE' : 'RESEARCH_BLOCKED_STAGE_CYCLE',
    questions_allowed: true,
    implementation_allowed: false,
    subagents_verified: adversarial?.passed === true,
    context7_verified: plan?.current_docs_policy?.context7_required === true ? gate.metrics?.context7_verified === true : true
  });
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: passed ? 'research.done' : 'research.stage_cycle.blocked', cycle: 1, cycle_status: cycleResult.status, official_subagent_review_passed: adversarial?.passed === true });
  await enforceRetention(root).catch(() => {});
  if (flag(args, '--json')) {
    const output = {
      schema: flag(args, '--autoresearch') ? 'sks.autoresearch-run.v1' : 'sks.research-run.v1',
      ok: proof.ok && passed,
      mission_id: id,
      gate,
      quality_metrics: gate.metrics || null,
      proof: proof.validation,
      official_subagent_review: adversarial,
      research_work_graph: researchWorkGraph,
      research_cycle: cycleResult,
      honest_mode: honestMode
    };
    if (!output.ok) process.exitCode = 2;
    return printJson(output);
  }
  printResearchCompletion(id, root, dir, plan, gate);
  if (!passed) process.exitCode = 2;
}

function printResearchCompletion(id: string, root: string, dir: string, plan: any, gate: any) {
  const metrics = gate?.metrics || {};
  const synthesis = metrics.synthesis || {};
  const rel = (artifact: string) => path.relative(root, path.join(dir, artifact));
  console.log(`Research done: ${id}`);
  console.log(`Synthesis: ${synthesis.writer || 'missing'}`);
  console.log(`Report: ${rel('research-report.md')}`);
  console.log(`Paper: ${rel(researchPaperArtifactForPlan(plan))}`);
  console.log(`Implementation blueprint: ${rel('implementation-blueprint.json')}`);
  console.log(`Claim-evidence matrix: ${rel('claim-evidence-matrix.json')}`);
  console.log(`Experiment plan: ${rel('experiment-plan.json')}`);
  console.log(`Replication pack: ${rel('replication-pack.json')}`);
  console.log(`Gate: ${gate?.passed ? 'passed' : 'blocked'}`);
  console.log(`Quality: ${metrics.report_word_count ?? 0} words / ${metrics.source_entries_total_with_counterevidence ?? metrics.source_entries ?? 0} sources / ${metrics.key_claims ?? 0} key claims / repetition ${synthesis.repetition_ratio ?? metrics.report_repetition?.repeated_paragraph_ratio ?? 'n/a'}`);
  console.log(`Final review: static ${metrics.final_review_blockers?.length ? 'block' : 'pass'} / codex ${synthesis.codex_final_review_verdict || 'missing'}`);
  console.log(`Handoff: ${rel('naruto-handoff-goal.md')}`);
}

async function researchStatus(args: any) {
  const parsed = parseResearchCommandArgs('status', args);
  args = parsed.args;
  const root = await sksRoot();
  const id = await resolveResearchRunMissionId(root, parsed.positionals[0]);
  if (!id) throw new Error('Usage: sks research status <mission-id|latest>');
  const { dir, mission } = await loadMission(root, id);
  const state = await readJson(stateFile(root), {});
  const gate = await readJson(path.join(dir, 'research-gate.evaluated.json'), await readJson(path.join(dir, 'research-gate.json'), null));
  const gateVerdict = await evaluateGate(root, id, 'research-gate.json');
  if (!flag(args, '--json')) console.log(gateVerdict.verdict);
  const ledger = await readJson(path.join(dir, 'novelty-ledger.json'), null);
  const sourceLedger = await readJson(path.join(dir, 'source-ledger.json'), null);
  const falsificationLedger = await readJson(path.join(dir, 'falsification-ledger.json'), null);
  const sourceSkillText = await readText(path.join(dir, RESEARCH_SOURCE_SKILL_ARTIFACT), '');
  const plan = await readJson(path.join(dir, 'research-plan.json'), null);
  const officialSubagentPlan = await readJson(path.join(dir, RESEARCH_ADVERSARIAL_PLAN_ARTIFACT), null);
  const adversarialReview = await readJson(path.join(dir, RESEARCH_ADVERSARIAL_REVIEW_ARTIFACT), null);
  const revisionLedger = await readJson(path.join(dir, RESEARCH_REVISION_LEDGER_ARTIFACT), null);
  const adversarialConvergence = await readJson(path.join(dir, RESEARCH_CONVERGENCE_GATE_ARTIFACT), null);
  const honestMode = await readJson(path.join(dir, RESEARCH_HONEST_MODE_ARTIFACT), null);
  const paperArtifact = await findResearchPaperArtifact(dir, plan);
  const paperText = paperArtifact.exists ? await readText(paperArtifact.path, '') : '';
  const sourceLayerRows = Array.isArray(sourceLedger?.source_layers) ? sourceLedger.source_layers : [];
  const sourceLayersCovered = sourceLayerRows.filter((layer: any) => layer.status === 'covered' && ((Array.isArray(layer.source_ids) && layer.source_ids.length) || (Array.isArray(layer.counterevidence_ids) && layer.counterevidence_ids.length))).length;
  const qualityContract = await readResearchQualityContract(dir);
  const claimMatrix = await readClaimEvidenceMatrix(dir);
  const sourceQualityReport = await readSourceQualityReport(dir);
  const implementationBlueprint = await readImplementationBlueprint(dir);
  const experimentPlan = await readExperimentPlan(dir);
  const replicationPack = await readReplicationPack(dir);
  const finalReview = await readResearchFinalReview(dir);
  const synthesisOutput = await readJson(path.join(dir, 'research-synthesis-output.json'), null);
  const blueprintValidation = validateImplementationBlueprint(implementationBlueprint, qualityContract);
  const experimentValidation = validateExperimentPlan(experimentPlan, qualityContract);
  const replicationValidation = validateReplicationPack(replicationPack);
  console.log(JSON.stringify({
    mission,
    state,
    agent_backend: 'official_codex_subagent',
    official_subagent_plan: officialSubagentPlan,
    adversarial_review: adversarialReview,
    revision_ledger: revisionLedger,
    adversarial_convergence: adversarialConvergence,
    honest_mode: honestMode,
    gate,
    gate_verdict: gateVerdict,
    novelty_entries: ledger?.entries?.length ?? null,
    source_entries: sourceLedger?.sources?.length ?? null,
    source_layers_required: sourceLayerRows.length || gate?.metrics?.source_layers_required || gate?.source_layers_required || null,
    source_layers_covered: gate?.metrics?.source_layers_covered ?? gate?.source_layers_covered ?? (sourceLayerRows.length ? sourceLayersCovered : null),
    triangulation_checks: sourceLedger?.triangulation?.cross_layer_checks?.length ?? gate?.metrics?.triangulation_checks ?? gate?.triangulation_checks ?? null,
    counterevidence_sources: sourceLedger?.counterevidence_sources?.length ?? null,
    xhigh_agents: 0,
    research_source_skill_present: Boolean(sourceSkillText.trim()),
    research_paper_artifact: paperArtifact.name,
    paper_present: Boolean(paperText.trim()),
    paper_sections: countResearchPaperSections(paperText),
    falsification_cases: falsificationLedger?.cases?.length ?? null,
    research_quality: {
      contract: qualityContract,
      report_word_count: gate?.metrics?.report_word_count ?? null,
      synthesis: {
        writer: gate?.metrics?.synthesis?.writer ?? (synthesisOutput ? 'evidence-bound writer artifact present' : null),
        repetition_ratio: gate?.metrics?.synthesis?.repetition_ratio ?? gate?.metrics?.report_repetition?.repeated_paragraph_ratio ?? null,
        source_density_per_1000_words: gate?.metrics?.synthesis?.source_density_per_1000_words ?? gate?.metrics?.source_density_per_1000_words ?? null,
        claim_density_per_1000_words: gate?.metrics?.synthesis?.claim_density_per_1000_words ?? gate?.metrics?.claim_density_per_1000_words ?? null,
        template_phrase_hits: gate?.metrics?.synthesis?.template_phrase_hits ?? gate?.metrics?.template_phrase_hits ?? [],
        codex_final_review_verdict: finalReview?.codex_review?.verdict || null
      },
      claim_evidence_matrix_present: claimMatrix.present,
      key_claims: claimMatrix.key_claim_ids.length,
      triangulated_claims: claimMatrix.triangulated_claim_count,
      claim_matrix_blockers: claimMatrix.blockers,
      source_quality_report_ok: sourceQualityReport?.ok === true,
      implementation_blueprint_sections: Array.isArray(implementationBlueprint?.sections) ? implementationBlueprint.sections.length : null,
      implementation_blueprint_ok: blueprintValidation.ok,
      experiment_steps: Array.isArray(experimentPlan?.steps) ? experimentPlan.steps.length : null,
      experiment_plan_ok: experimentValidation.ok,
      replication_pack_ok: replicationValidation.ok,
      final_review_approved: finalReview?.approved === true,
      final_review_blockers: finalReview?.blockers || []
    }
  }, null, 2));
}

async function researchCodeMutationSnapshot(root: any, missionId: any = null) {
  const tracked = await runProcess('git', ['ls-files'], { cwd: root, timeoutMs: 15000, maxOutputBytes: 2 * 1024 * 1024 }).catch((err: any) => ({ code: 1, stderr: err.message, stdout: '' }));
  const status = await runProcess('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, timeoutMs: 15000, maxOutputBytes: 2 * 1024 * 1024 }).catch((err: any) => ({ code: 1, stderr: err.message, stdout: '' }));
  if (tracked.code !== 0 || status.code !== 0) return { ok: false, reason: 'git_unavailable', hashes: {}, status_rows: [], error: tracked.stderr || status.stderr };
  const allowedPrefixes = researchAllowedMutationPrefixes(missionId);
  const hashes: Record<string, string | null> = {};
  for (const rel of tracked.stdout.split(/\r?\n/).map((line: any) => line.trim()).filter(Boolean)) {
    if (researchMutationAllowedPath(rel, allowedPrefixes)) continue;
    const file = path.join(root, rel);
    try {
      const bytes = await fsp.readFile(file);
      hashes[rel] = createHash('sha256').update(bytes).digest('hex');
    } catch {
      hashes[rel] = null;
    }
  }
  return { ok: true, hashes, status_rows: status.stdout.split(/\r?\n/).filter(Boolean), allowed_prefixes: allowedPrefixes };
}

async function researchCodeMutationDelta(root: any, baseline: any, missionId: any) {
  if (!baseline?.ok) return { blocked: false, changed_paths: [], reason: baseline?.reason || 'baseline_unavailable' };
  const current = await researchCodeMutationSnapshot(root, missionId);
  if (!current.ok) return { blocked: false, changed_paths: [], reason: current.reason || 'current_snapshot_unavailable' };
  const changed = new Set();
  for (const [rel, hash] of Object.entries(current.hashes)) {
    if (baseline.hashes[rel] !== hash) changed.add(rel);
  }
  for (const rel of Object.keys(baseline.hashes)) {
    if (!(rel in current.hashes)) changed.add(rel);
  }
  const baselineRows = new Set(baseline.status_rows || []);
  for (const row of current.status_rows || []) {
    if (baselineRows.has(row)) continue;
    const rel = porcelainStatusPath(row);
    if (rel && !researchMutationAllowedPath(rel, current.allowed_prefixes)) changed.add(rel);
  }
  const changedPaths = [...changed].sort();
  return { blocked: changedPaths.length > 0, changed_paths: changedPaths, allowed_prefixes: current.allowed_prefixes };
}

function researchAllowedMutationPrefixes(missionId: any = null) {
  return missionId ? [`.sneakoscope/missions/${missionId}/`] : ['.sneakoscope/missions/'];
}

function researchMutationAllowedPath(rel: any = '', prefixes: any = []) {
  const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return prefixes.some((prefix: any) => normalized.startsWith(prefix));
}

function porcelainStatusPath(row: any = '') {
  const payload = String(row || '').slice(3).trim();
  if (!payload) return '';
  const renamed = payload.split(' -> ').pop();
  return String(renamed || '').replace(/^"|"$/g, '');
}

function readResearchCycleTimeoutMinutes(args: any) {
  return readStrictResearchIntegerFlag(args, '--cycle-timeout-minutes', RESEARCH_DEFAULT_CYCLE_TIMEOUT_MINUTES, RESEARCH_MIN_CYCLE_TIMEOUT_MINUTES, RESEARCH_MAX_CYCLE_TIMEOUT_MINUTES);
}

export function readStrictResearchIntegerFlag(args: any[] = [], name: string, fallback: number, min: number, max: number): number {
  const matches: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? '');
    if (arg === name) {
      const next = args[index + 1];
      if (next === undefined || String(next).startsWith('--')) throw new Error(`Missing value for ${name}. Expected an integer from ${min} to ${max}.`);
      matches.push(String(next));
      index += 1;
      continue;
    }
    if (arg.startsWith(`${name}=`)) matches.push(arg.slice(name.length + 1));
  }
  if (!matches.length) return fallback;
  if (matches.length > 1) throw new Error(`Duplicate Research option: ${name}.`);
  const raw = matches[0] || '';
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid value for ${name}: ${raw || '<empty>'}. Expected an integer from ${min} to ${max}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Out-of-range value for ${name}: ${raw}. Expected an integer from ${min} to ${max}.`);
  }
  return value;
}

export async function resolveResearchRunMissionId(root: string, requested: unknown) {
  if (String(requested || '') !== 'latest') return resolveMissionId(root, requested);
  const state = await readJson<any>(stateFile(root), {});
  const route = String(state?.route || state?.route_command || state?.mode || '').replace(/^\$/, '').replace(/[-_]/g, '').toUpperCase();
  const active = Boolean(state?.mission_id)
    && state?.route_closed !== true
    && ['RESEARCH', 'AUTORESEARCH'].includes(route)
    && !/(?:DONE|COMPLETE|CLOSED|BLOCKED|FAILED)$/i.test(String(state?.phase || ''));
  if (active) {
    const loaded = await loadMission(root, String(state.mission_id)).catch(() => null);
    if (String(loaded?.mission?.mode || '').toLowerCase() === 'research') return String(state.mission_id);
  }
  return findLatestMission(root, { mode: 'research' });
}
