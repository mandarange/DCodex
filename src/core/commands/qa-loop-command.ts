import path from 'node:path';
import { appendJsonlBounded, exists, nowIso, readJson, sksRoot, writeJsonAtomic } from '../fsx.js';
import { initProject } from '../init.js';
import { getCodexInfo, runCodexExec } from '../codex-adapter.js';
import { createMission, loadMission, setCurrent, stateFile } from '../mission.js';
import { writeQuestions } from '../questions.js';
import { sealContract } from '../decision-contract.js';
import { buildQaLoopQuestionSchema, buildQaLoopPrompt, ensureQaLoopVisualEvidenceContract, evaluateQaGate, qaGptImage2AnnotatedReviewRequired, qaStatus, qaUiRequired, writeMockQaResult, writeQaLoopArtifacts, writeQaNativeAgentLedger } from '../qa-loop.js';
import { containsUserQuestion, noQuestionContinuationReason } from '../no-question-guard.js';
import { ROUTES, routePrompt, stripVisibleDecisionAnswerBlocks } from '../routes.js';
import { codexChromeExtensionStatus } from '../codex-app.js';
import { scanDbSafety } from '../db-safety.js';
import { maybeFinalizeRoute } from '../proof/auto-finalize.js';
import { runNativeAgentOrchestrator } from '../agents/agent-orchestrator.js';
import { flag, promptOf, readBoundedIntegerFlag, readFlagValue, readMaxCycles, resolveMissionId, safeReadTextFile } from './command-utils.js';
import { runCodexAppHandoff, qaLoopShouldRequestAppHandoff } from '../codex-app/codex-app-handoff.js';
import { evaluateGate } from '../stop-gate/gate-evaluator.js';
import { writeCodex0138CapabilityArtifacts } from '../codex-control/codex-0138-capability.js';
import { writeCodexAccountUsageArtifacts } from '../usage/codex-account-usage.js';
import { buildQaLoopBudgetPolicy, selectQaLoopEscalatedEffort } from '../qa-loop/qa-loop-budget-policy.js';
import { initializeQaRuntimeArtifacts } from '../qa-loop/qa-runtime-artifacts.js';
import { DEFAULT_QA_MAX_CYCLES, QA_SURFACE_SELECTION_ARTIFACT } from '../qa-loop/qa-types.js';
import { writeCodexModelEffortCapabilityArtifact } from '../codex-control/codex-model-capabilities.js';
import { prepareCodexAppServerRuntimeEnv } from '../codex-control/codex-app-server-runtime-env.js';
import { discoverImageArtifactsInDir, writeImageArtifactPathContract } from '../image/image-artifact-path-contract.js';
import { pluginAppTemplatePolicy } from '../codex-plugins/codex-plugin-json.js';
import { confirmQaLoopAppHandoff } from '../qa-loop/qa-loop-app-handoff-confirmation.js';
import { emitStreamEvent } from '../agent-bridge/agent-mode.js';
import fsp from 'node:fs/promises';

export async function qaLoopCommand(sub: any, args: any = []) {
  const known = new Set(['prepare', 'answer', 'run', 'status', 'app-confirm', 'help', '--help', '-h']);
  const action = known.has(sub) ? sub : 'prepare';
  const actionArgs = action === 'prepare' && sub && !known.has(sub) ? [sub, ...args] : args;
  if (action === 'prepare') return qaLoopPrepare(actionArgs);
  if (action === 'answer') return qaLoopAnswer(actionArgs);
  if (action === 'run') return qaLoopRun(actionArgs);
  if (action === 'status') return qaLoopStatus(actionArgs);
  if (action === 'app-confirm') return qaLoopAppConfirm(actionArgs);
  console.log(`SKS QA-LOOP

Usage:
  sks qa-loop prepare "target"
  sks qa-loop answer <mission-id|latest> <answers.json>
  sks qa-loop run <mission-id|latest> [--mock] [--max-cycles N] [--surface auto|codex_in_app_browser|codex_chrome_extension|codex_computer_use] [--report-only] [--app-handoff] [--app-handoff-required] [--app-handoff-launch] [--app-handoff-artifact-only] [--stream]
  sks qa-loop app-confirm <mission-id|latest> --verdict pass|fail --notes "..."
  sks qa-loop status <mission-id|latest> [--desktop]
`);
}

function qaRoute() {
  return ROUTES.find((route: any) => route.id === 'QALoop') || routePrompt('$QA-LOOP');
}

async function qaLoopPrepare(args: any) {
  const root = await sksRoot();
  if (!(await exists(path.join(root, '.sneakoscope')))) await initProject(root, {});
  const prompt = stripVisibleDecisionAnswerBlocks(promptOf(args));
  if (!prompt) throw new Error('Missing QA target prompt.');
  const { id, dir } = await createMission(root, { mode: 'qaloop', prompt });
  const schema = buildQaLoopQuestionSchema(prompt);
  const route = qaRoute();
  await writeQuestions(dir, schema);
  await writeJsonAtomic(path.join(dir, 'route-context.json'), { route: 'QALoop', command: '$QA-LOOP', mode: 'QALOOP', task: prompt, required_skills: route?.requiredSkills || [], context7_required: false, original_stop_gate: 'qa-gate.json', clarification_gate: true });
  if (schema.slots.length === 0) {
    await writeJsonAtomic(path.join(dir, 'answers.json'), schema.inferred_answers || {});
    const result = await sealContract(dir, { id, prompt, mode: 'qaloop' });
    if (!result.ok) {
      console.error('Inferred QA-LOOP answers failed validation.');
      console.error(JSON.stringify(result.validation, null, 2));
      process.exitCode = 2;
      return;
    }
    const artifactResult = await writeQaLoopArtifacts(dir, { id, prompt, mode: 'qaloop' }, result.contract);
    const nativeAgentPlan = await writeQaNativeAgentLedger(dir, { id, prompt, reportFile: artifactResult.report_file });
    await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.prepare.auto_sealed', slots: 0, hash: result.contract.sealed_hash, checklist_count: artifactResult.checklist_count });
    const clarificationPassed = true;
    const ambiguityGatePassed = true;
    await setCurrent(root, { mission_id: id, route: 'QALoop', route_command: '$QA-LOOP', mode: 'QALOOP', phase: 'QALOOP_CLARIFICATION_CONTRACT_SEALED', questions_allowed: false, implementation_allowed: true, clarification_required: false, clarification_passed: clarificationPassed, ambiguity_gate_required: true, ambiguity_gate_passed: ambiguityGatePassed, stop_gate: 'qa-gate.json', qa_loop_artifacts_ready: true, qa_report_file: artifactResult.report_file, qa_checklist_count: artifactResult.checklist_count, reasoning_effort: 'high', reasoning_profile: 'sks-logic-high', reasoning_temporary: true });
    if (flag(args, '--json')) return console.log(JSON.stringify({ schema: 'sks.qa-loop-prepare.v1', ok: true, mission_id: id, report_file: artifactResult.report_file, checklist_count: artifactResult.checklist_count, native_agent_plan: nativeAgentPlan }, null, 2));
    console.log(`QA-LOOP mission created: ${id}`);
    console.log('QA-LOOP contract auto-sealed from prompt, TriWiki/current-code defaults, and conservative safety policy.');
    console.log(`Checklist: ${artifactResult.checklist_count} cases`);
    console.log(`Report: ${path.relative(root, path.join(dir, artifactResult.report_file))}`);
    console.log(`Run: sks qa-loop run ${id} --max-cycles ${schema.inferred_answers?.MAX_QA_CYCLES || 1}`);
    return;
  }
  const nativeAgentPlan = await writeQaNativeAgentLedger(dir, { id, prompt });
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.prepare.questions_created', slots: schema.slots.length });
  await setCurrent(root, { mission_id: id, route: 'QALoop', route_command: '$QA-LOOP', mode: 'QALOOP', phase: 'QALOOP_CLARIFICATION_AWAITING_ANSWERS', questions_allowed: true, implementation_allowed: false, clarification_required: true, ambiguity_gate_required: true, stop_gate: 'clarification-gate', reasoning_effort: 'high', reasoning_profile: 'sks-logic-high', reasoning_temporary: true });
  if (flag(args, '--json')) return console.log(JSON.stringify({ schema: 'sks.qa-loop-prepare.v1', ok: true, mission_id: id, questions_required: true, native_agent_plan: nativeAgentPlan }, null, 2));
  console.log(`QA-LOOP mission created: ${id}`);
  console.log(`Answer schema: ${path.relative(root, path.join(dir, 'required-answers.schema.json'))}`);
}

async function qaLoopAnswer(args: any) {
  const root = await sksRoot();
  const [missionArg, answerFile] = args;
  const id = await resolveMissionId(root, missionArg);
  if (!id || !answerFile) throw new Error('Usage: sks qa-loop answer <mission-id|latest> <answers.json>');
  const { dir, mission } = await loadMission(root, id);
  const answers = await readJson(path.resolve(answerFile));
  await writeJsonAtomic(path.join(dir, 'answers.json'), answers);
  const result = await sealContract(dir, mission);
  if (!result.ok) {
    console.error('Answer validation failed. QA-LOOP remains locked.');
    console.error(JSON.stringify(result.validation, null, 2));
    process.exitCode = 2;
    return;
  }
  const artifactResult = await writeQaLoopArtifacts(dir, mission, result.contract);
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.contract.sealed', hash: result.contract.sealed_hash, checklist_count: artifactResult.checklist_count });
  const clarificationPassed = true;
  const ambiguityGatePassed = true;
  await setCurrent(root, { mission_id: id, route: 'QALoop', route_command: '$QA-LOOP', mode: 'QALOOP', phase: 'QALOOP_CLARIFICATION_CONTRACT_SEALED', questions_allowed: false, implementation_allowed: true, clarification_required: false, clarification_passed: clarificationPassed, ambiguity_gate_passed: ambiguityGatePassed, stop_gate: 'qa-gate.json', reasoning_effort: 'high', reasoning_profile: 'sks-logic-high', reasoning_temporary: true });
  console.log(`QA-LOOP contract sealed for ${id}`);
}

async function qaLoopRun(args: any) {
  const root = await sksRoot();
  const id = await resolveMissionId(root, args[0]);
  if (!id) throw new Error('Usage: sks qa-loop run <mission-id|latest> [--mock] [--max-cycles N]');
  const stream = flag(args, '--stream');
  const { dir, mission } = await loadMission(root, id);
  if (stream) emitStreamEvent('start', { schema: 'sks.qa-loop-run.v1', mission_id: id });
  const contractPath = path.join(dir, 'decision-contract.json');
  if (!(await exists(contractPath))) throw new Error('QA-LOOP cannot run: decision-contract.json is missing.');
  const contract = await readJson(contractPath, {});
  if (!(await exists(path.join(dir, 'qa-ledger.json')))) await writeQaLoopArtifacts(dir, mission, contract);
  else await ensureQaLoopVisualEvidenceContract(dir, mission, contract);
  const requestedSurface = readFlagValue(args, '--surface', 'auto');
  const reportOnly = flag(args, '--report-only');
  await initializeQaRuntimeArtifacts(dir, {
    ...contract,
    prompt: mission.prompt || contract.prompt,
    mission_id: id
  }, {
    missionId: id,
    requestedSurface,
    reportOnly
  }).catch(() => null);
  const safetyScan = await scanDbSafety(root);
  if (!safetyScan.ok) {
    console.error('QA-LOOP cannot run: SKS safety scan found unsafe project data-tool configuration.');
    console.error(JSON.stringify(safetyScan.findings, null, 2));
    process.exitCode = 2;
    if (stream) emitStreamEvent('result', { schema: 'sks.qa-loop-run.v1', ok: false, mission_id: id, status: 'blocked', blocker: 'db_safety_scan_failed', findings: safetyScan.findings });
    return;
  }
  const fallbackCycles = Number.parseInt(contract.answers?.MAX_QA_CYCLES, 10) || DEFAULT_QA_MAX_CYCLES;
  const maxCycles = readMaxCycles(args, fallbackCycles);
  const requestedAgents = readBoundedIntegerFlag(args, '--agents', 3, 1, 20);
  const targetActiveSlots = readBoundedIntegerFlag(args, '--target-active-slots', Math.min(requestedAgents, 4), 1, 4);
  const desiredWorkItemCount = readBoundedIntegerFlag(args, '--work-items', targetActiveSlots, 1, 200);
  const minimumWorkItems = readBoundedIntegerFlag(args, '--minimum-work-items', targetActiveSlots, 1, 200);
  const maxQueueExpansion = readBoundedIntegerFlag(args, '--max-queue-expansion', 10, 0, 200);
  const profile = readFlagValue(args, '--profile', 'sks-logic-high') || 'sks-logic-high';
  const mock = flag(args, '--mock');
  const sourceFixesEnabled = !reportOnly;
  const writeMode = readFlagValue(args, '--write-mode', sourceFixesEnabled && !mock ? (flag(args, '--parallel-write') ? 'parallel' : 'proof-safe') : 'off');
  const applyPatches = sourceFixesEnabled && !mock && !flag(args, '--no-fix');
  const dryRunPatches = flag(args, '--dry-run-patches') || flag(args, '--dryrun-patches');
  const maxWriteAgents = readBoundedIntegerFlag(args, '--max-write-agents', Math.min(requestedAgents, 5), 1, 20);
  const qaGate = await readJson(path.join(dir, 'qa-gate.json'), {});
  const reportFile = qaGate.qa_report_file;
  const executionProfile = await readJson(path.join(dir, 'qa-loop', 'execution-profile.json'), null);
  const uiRequired = qaUiRequired(contract.answers || {});
  const surfaceSelection = await readJson(path.join(dir, QA_SURFACE_SELECTION_ARTIFACT), null);
  const selectedSurface = surfaceSelection?.selected_surface || null;
  const gptImage2ReviewRequired = qaGptImage2AnnotatedReviewRequired(contract, mission.prompt);
  const capabilityArtifact = await writeCodex0138CapabilityArtifacts(root, { missionId: id }).catch((err: any) => ({ error: err?.message || String(err), report: null }));
  const usageArtifact = await writeCodexAccountUsageArtifacts(root, { missionId: id }).catch((err: any) => ({ error: err?.message || String(err), snapshot: null }));
  const budgetPolicy = buildQaLoopBudgetPolicy({ usage: (usageArtifact as any)?.snapshot || null, provider: 'codex-sdk' });
  await writeJsonAtomic(path.join(dir, 'qa-loop', 'qa-loop-budget-policy.json'), budgetPolicy);
  const effortCapabilityArtifact = await writeCodexModelEffortCapabilityArtifact(root, { missionId: id }).catch((err: any) => ({ error: err?.message || String(err), capability: null }));
  const effortEscalation = selectQaLoopEscalatedEffort({
    failureCount: Number(qaGate.safe_fix_attempts || qaGate.failure_count || 0),
    currentEffort: String(profile || 'high').replace(/^sks-(?:logic|agent)-/, '').replace(/-fast$/, '') || 'high',
    capability: (effortCapabilityArtifact as any)?.capability || undefined
  });
  await writeJsonAtomic(path.join(dir, 'qa-loop', 'qa-loop-effort-escalation.json'), effortEscalation);
  const discoveredImages = await discoverImageArtifactsInDir(dir).catch(() => []);
  const imagePathContract = discoveredImages.length
    ? await writeQaLoopImagePathContract(root, dir, id, discoveredImages)
    : null;
  const pluginInventory = await readJson(path.join(root, '.sneakoscope', 'codex-plugin-inventory.json'), null);
  const pluginPolicy = pluginInventory?.schema === 'sks.codex-plugin-inventory.v1' ? pluginAppTemplatePolicy(pluginInventory) : null;
  const appHandoffRequired = flag(args, '--app-handoff-required') || process.env.SKS_QA_LOOP_APP_HANDOFF_REQUIRED === '1';
  const launchMode = flag(args, '--app-handoff-launch') || process.env.SKS_QA_LOOP_APP_HANDOFF_LAUNCH === '1'
    ? 'attempt-launch'
    : 'artifact-only';
  const appHandoffRequested = qaLoopShouldRequestAppHandoff({
    args,
    uiRequired,
    visualArtifactsPresent: discoveredImages.length > 0,
    pluginAppTemplateUnavailable: Boolean(pluginPolicy?.unavailable_app_templates?.length),
    userRequestedDesktopReview: appHandoffRequired
  });
  const appHandoff = appHandoffRequested || appHandoffRequired
    ? await runCodexAppHandoff(root, {
        schema: 'sks.codex-app-handoff-request.v1',
        mission_id: id,
        route: '$QA-LOOP',
        reason: appHandoffRequired ? 'desktop_app_review_required' : 'desktop_app_review_requested',
        thread_ref: null,
        workspace_path: root,
        artifacts: [
          'decision-contract.json',
          'qa-gate.json',
          'qa-ledger.json',
          reportFile,
          capabilityArtifact && !(capabilityArtifact as any).error ? 'codex-0138-capability.json' : '',
          imagePathContract ? 'qa-loop/image-artifact-path-contract.json' : ''
        ].filter(Boolean),
        prompt: mission.prompt || 'QA-LOOP desktop handoff',
        require_desktop: appHandoffRequired,
        capability_required: 'codex-0.138',
        launch_mode: flag(args, '--app-handoff-artifact-only') ? 'artifact-only' : launchMode
      }).catch((err: any) => ({
        ok: false,
        status: 'blocked_for_desktop_review',
        artifact_path: path.join(dir, 'qa-loop', 'app-handoff.json'),
        blockers: [`codex_app_handoff_failed:${err?.message || String(err)}`],
        desktop_handoff_supported: false,
        launch_attempt: null
      }))
    : null;
  if (appHandoff || imagePathContract) {
    const latestGate = await readJson(path.join(dir, 'qa-gate.json'), qaGate);
    const nextGate = {
      ...latestGate,
      desktop_app_handoff_required: appHandoffRequired,
      desktop_app_handoff_status: appHandoff ? appHandoff.status : 'not_requested',
      desktop_app_handoff_artifact: appHandoff ? path.relative(dir, appHandoff.artifact_path) : null,
      desktop_app_handoff_supported: appHandoff ? appHandoff.desktop_handoff_supported === true : false,
      desktop_app_handoff_confirmed: latestGate.desktop_app_handoff_confirmed === true,
      desktop_app_handoff_verdict: latestGate.desktop_app_handoff_verdict || null,
      desktop_app_handoff_launch_attempt: appHandoff ? appHandoff.launch_attempt || null : null,
      desktop_app_handoff_is_web_ui_evidence: false,
      image_artifact_path_contract_present: Boolean(imagePathContract),
      image_artifact_path_contract_artifact: imagePathContract ? 'qa-loop/image-artifact-path-contract.json' : null,
      image_artifact_path_contract_blockers: imagePathContract?.contract?.blockers || [],
      blockers: Array.from(new Set([
        ...(latestGate.blockers || []),
        ...(appHandoffRequired && appHandoff && appHandoff.ok !== true ? ['blocked_for_desktop_review'] : []),
        ...(appHandoffRequired && latestGate.desktop_app_handoff_confirmed !== true ? ['desktop_app_handoff_confirmation_missing'] : []),
        ...(imagePathContract?.contract?.blockers || [])
      ])),
      notes: [
        ...(latestGate.notes || []),
        ...(appHandoff ? ['Codex Desktop /app handoff is tracked separately and is not web UI verification evidence.'] : []),
        ...(imagePathContract ? ['Image artifacts expose real saved file paths for follow-up visual edits.'] : [])
      ]
    };
    await writeJsonAtomic(path.join(dir, 'qa-gate.json'), nextGate);
    if (appHandoffRequired && appHandoff && appHandoff.ok !== true) {
      await maybeFinalizeRoute(root, { missionId: id, route: '$QA-LOOP', gateFile: 'qa-gate.json', gate: nextGate, artifacts: ['qa-gate.json', 'qa-ledger.json', reportFile, 'qa-loop/app-handoff.json', 'completion-proof.json'], statusHint: 'blocked', blockers: nextGate.blockers, command: { cmd: `sks qa-loop run ${id} --app-handoff-required`, status: 2 } });
      await setCurrent(root, { mission_id: id, mode: 'QALOOP', phase: 'QALOOP_BLOCKED_DESKTOP_APP_HANDOFF', questions_allowed: true });
      const handoffResult = { schema: 'sks.qa-loop-run.v1', ok: false, status: 'blocked_for_desktop_review', mission_id: id, app_handoff: appHandoff, gate: nextGate };
      if (stream) emitStreamEvent('result', handoffResult);
      if (flag(args, '--json')) return console.log(JSON.stringify(handoffResult, null, 2));
      console.error('QA-LOOP blocked: Codex Desktop /app handoff is required but unavailable or still pending.');
      process.exitCode = 2;
      return;
    }
  }
  if (uiRequired && !mock && selectedSurface === 'codex_chrome_extension') {
    const chrome = await codexChromeExtensionStatus();
    if (!chrome.ok) {
      const blockedGate = {
        ...qaGate,
        passed: false,
        chrome_extension_preflight_passed: false,
        ui_chrome_extension_evidence: false,
        ui_computer_use_evidence: false,
        ui_evidence_source: 'blocked_chrome_extension_setup_required',
        ui_chrome_extension_screenshot_required: true,
        ui_chrome_extension_screenshot_captured: false,
        ui_chrome_extension_screenshot_artifact: null,
        ui_chrome_extension_screenshot_sha256: null,
        gpt_image_2_annotated_review_required: gptImage2ReviewRequired,
        gpt_image_2_annotated_review_generated: false,
        gpt_image_2_annotated_review_artifact: null,
        gpt_image_2_annotated_review_sha256: null,
        gpt_image_2_annotated_review_model: gptImage2ReviewRequired ? null : 'not_required',
        gpt_image_2_annotated_review_provider: gptImage2ReviewRequired ? null : 'not_required',
        blocker: 'codex_chrome_extension_setup_required',
        blockers: Array.from(new Set([...(qaGate.blockers || []), 'codex_chrome_extension_setup_required', ...(chrome.blockers || [])])),
        evidence: [...(qaGate.evidence || []), 'Codex Chrome Extension preflight failed before web QA execution.'],
        notes: [...(qaGate.notes || []), 'Rapid halt: install/enable Codex Chrome Extension, then tell SKS installation is complete before resuming.'],
        chrome_extension: chrome
      };
      await writeJsonAtomic(path.join(dir, 'qa-gate.json'), blockedGate);
      await maybeFinalizeRoute(root, { missionId: id, route: '$QA-LOOP', gateFile: 'qa-gate.json', gate: blockedGate, artifacts: ['qa-gate.json', 'qa-ledger.json', reportFile, 'completion-proof.json'], statusHint: 'blocked', blockers: blockedGate.blockers, command: { cmd: `sks qa-loop run ${id}`, status: 2 } });
      await setCurrent(root, { mission_id: id, mode: 'QALOOP', phase: 'QALOOP_BLOCKED_CHROME_EXTENSION_SETUP_REQUIRED', questions_allowed: true });
      const chromeBlockedResult = { schema: 'sks.qa-loop-run.v1', ok: false, status: 'blocked', blocker: 'codex_chrome_extension_setup_required', mission_id: id, chrome_extension: chrome, gate: blockedGate };
      if (stream) emitStreamEvent('result', chromeBlockedResult);
      if (flag(args, '--json')) return console.log(JSON.stringify(chromeBlockedResult, null, 2));
      console.error('QA-LOOP blocked: this journey was routed to @Chrome, but the Codex Chrome Extension is not connected. Install/enable it, then resume.');
      console.error(chrome.docs_url);
      process.exitCode = 2;
      return;
    }
  }
  await setCurrent(root, { mission_id: id, route: 'QALoop', route_command: '$QA-LOOP', mode: 'QALOOP', phase: 'QALOOP_RUNNING_NO_QUESTIONS', questions_allowed: false, stop_gate: 'qa-gate.json', reasoning_effort: 'high', reasoning_profile: 'sks-logic-high', reasoning_temporary: true });
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.run.started', maxCycles, mock });
  if (stream) emitStreamEvent('progress', { mission_id: id, type: 'qaloop.run.started', max_cycles: maxCycles, mock });
  const nativeAgentPlan = await readJson(path.join(dir, 'qa-agent-plan.json'), null);
  const nativeRoster = requestedAgents === 3 ? nativeAgentPlan : null;
  const nativeAgentRun = await runNativeAgentOrchestrator({ root, missionId: id, route: '$QA-LOOP', prompt: mission.prompt || 'QA-LOOP run', backend: mock ? 'fake' : 'codex-sdk', mock, agents: requestedAgents, targetActiveSlots, desiredWorkItemCount, minimumWorkItems, maxQueueExpansion, concurrency: Math.min(requestedAgents, 4), readonly: !(applyPatches && writeMode !== 'off'), profile, writeMode: writeMode as any, applyPatches, dryRunPatches, maxWriteAgents, roster: nativeRoster, routeCommand: 'sks qa-loop run', routeBlackboxKind: 'actual_qa_command', env: { SKS_CODEX_APP_EXECUTION_PROFILE: executionProfile?.mode || 'unknown', SKS_CODEX_AGENT_ROLE_STRATEGY: executionProfile?.agent_role_strategy || 'message-role' } });
  await writeJsonAtomic(path.join(dir, 'qa-native-agent-run.json'), nativeAgentRun);
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.native_agents.completed', backend: nativeAgentRun.backend, ok: nativeAgentRun.ok, proof: nativeAgentRun.proof?.status });
  if (stream) emitStreamEvent('progress', { mission_id: id, type: 'qaloop.native_agents.completed', backend: nativeAgentRun.backend, ok: nativeAgentRun.ok, proof: nativeAgentRun.proof?.status });
  if (flag(args, '--native-proof-only')) {
    const proofOnlyGate = {
      schema: 'sks.qa-native-proof-only-gate.v1',
      ok: nativeAgentRun.proof?.ok === true,
      native_agent_proof: nativeAgentRun.proof?.ok === true,
      proof_status: nativeAgentRun.proof?.status || null,
      blockers: nativeAgentRun.proof?.blockers || []
    };
    const proofOnlyResult = {
      schema: 'sks.qa-loop-run.v1',
      ok: proofOnlyGate.ok,
      status: proofOnlyGate.ok ? 'native_proof_ready' : 'blocked',
      mission_id: id,
      gate: proofOnlyGate,
      proof: nativeAgentRun.proof,
      native_agent_run: nativeAgentRun,
      native_proof_only: true
    };
    if (stream) emitStreamEvent('result', proofOnlyResult);
    if (flag(args, '--json')) return console.log(JSON.stringify(proofOnlyResult, null, 2));
    console.log(`QA-LOOP native proof ready: ${id}`);
    return;
  }
  if (mock) {
    let gate = await writeMockQaResult(dir, mission, contract);
    const needsVisual = uiRequired;
    if (needsVisual && gate.gate) {
      const nextGate = {
        ...gate.gate,
        passed: false,
        chrome_extension_preflight_passed: false,
        ui_chrome_extension_evidence: false,
        ui_computer_use_evidence: false,
        ui_evidence_source: 'mock_codex_chrome_extension_fixture_not_live',
        mock_web_ui_evidence: true,
        evidence: [...(gate.gate.evidence || []), 'mock Codex Chrome Extension fixture marker; not live web UI evidence'],
        notes: [...(gate.gate.notes || []), 'Mock fixture does not satisfy the Codex Chrome Extension web verification gate or claim a live UI run.']
      };
      await writeJsonAtomic(path.join(dir, 'qa-gate.json'), nextGate);
      gate = await evaluateQaGate(dir);
    }
    const nativeGate = { ...(gate.gate || gate), native_agent_proof: nativeAgentRun.proof?.ok === true, agent_central_ledger: true };
    await writeJsonAtomic(path.join(dir, 'qa-gate.json'), nativeGate);
    gate = { ...gate, gate: nativeGate, passed: nativeGate.passed };
    const proof = await maybeFinalizeRoute(root, {
      missionId: id,
      route: '$QA-LOOP',
      gateFile: 'qa-gate.json',
      gate: gate.gate || gate,
      artifacts: ['agents/agent-proof-evidence.json', 'qa-native-agent-run.json', 'qa-gate.json', 'qa-ledger.json', reportFile, 'completion-proof.json'],
      visual: needsVisual,
      mock,
      unverified: needsVisual ? ['Mock QA-LOOP did not run live Codex Chrome Extension web UI verification; web UI evidence remains unverified.'] : [],
      command: { cmd: `sks qa-loop run ${id} --mock`, status: 0 }
    });
    await setCurrent(root, { mission_id: id, mode: 'QALOOP', phase: gate.passed ? 'QALOOP_DONE' : 'QALOOP_PAUSED', questions_allowed: true });
    const mockResult = {
      schema: 'sks.qa-loop-run.v1',
      ok: proof.ok && (!needsVisual || gate.passed === true),
      status: needsVisual && gate.passed !== true ? 'verified_partial_mock_no_live_web_evidence' : (gate.passed ? 'passed' : 'blocked'),
      mission_id: id,
      gate,
      proof: proof.validation,
      native_agent_run: nativeAgentRun,
      mock_only: true,
      live_web_evidence: !needsVisual || gate.passed === true
    };
    if (stream) emitStreamEvent('result', mockResult);
    if (flag(args, '--json')) return console.log(JSON.stringify(mockResult, null, 2));
    console.log(`Mock QA-LOOP done: ${id}`);
    console.log(`Gate: ${gate.passed ? 'passed' : 'blocked'}`);
    return;
  }
  if (!nativeAgentRun.ok) {
    await maybeFinalizeRoute(root, { missionId: id, route: '$QA-LOOP', gateFile: 'qa-gate.json', gate: await readJson(path.join(dir, 'qa-gate.json'), null), artifacts: ['agents/agent-proof-evidence.json', 'qa-native-agent-run.json', 'completion-proof.json'], statusHint: 'blocked', blockers: nativeAgentRun.proof?.blockers || ['native_agent_backend_blocked'], command: { cmd: `sks qa-loop run ${id}`, status: 2 } });
    await setCurrent(root, { mission_id: id, mode: 'QALOOP', phase: 'QALOOP_BLOCKED_NATIVE_AGENTS', questions_allowed: true });
    process.exitCode = 2;
    if (stream) emitStreamEvent('result', { schema: 'sks.qa-loop-run.v1', ok: false, mission_id: id, status: 'blocked', blocker: 'native_agent_backend_blocked', blockers: nativeAgentRun.proof?.blockers || ['native_agent_backend_blocked'] });
    return;
  }
  const codex = await getCodexInfo();
  if (!codex.bin) {
    console.error('Codex CLI not found. QA-LOOP cannot fall back to mock output after native agent runtime selection.');
    await maybeFinalizeRoute(root, { missionId: id, route: '$QA-LOOP', gateFile: 'qa-gate.json', gate: await readJson(path.join(dir, 'qa-gate.json'), null), artifacts: ['agents/agent-proof-evidence.json', 'qa-native-agent-run.json', 'completion-proof.json'], statusHint: 'blocked', blockers: ['codex_cli_missing'], command: { cmd: `sks qa-loop run ${id}`, status: 2 } });
    await setCurrent(root, { mission_id: id, mode: 'QALOOP', phase: 'QALOOP_BLOCKED_REAL_RUN_REQUIRED', questions_allowed: true });
    process.exitCode = 2;
    if (stream) emitStreamEvent('result', { schema: 'sks.qa-loop-run.v1', ok: false, mission_id: id, status: 'blocked', blocker: 'codex_cli_missing' });
    return;
  }
  const codexRuntimeEnv = await prepareCodexAppServerRuntimeEnv({ env: process.env });
  let last = '';
  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const cycleDir = path.join(dir, 'qa-loop', `cycle-${cycle}`);
    const outputFile = path.join(cycleDir, 'final.md');
    const prompt = buildQaLoopPrompt({ id, mission, contract, cycle, previous: last, reportFile, imagePathContract: imagePathContract?.contract || null, appHandoff, executionProfile });
    await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.cycle.start', cycle });
    if (stream) emitStreamEvent('progress', { mission_id: id, type: 'qaloop.cycle.start', cycle, max_cycles: maxCycles });
    const result = await runCodexExec({ root, prompt, outputFile, json: true, profile, logDir: cycleDir, env: codexRuntimeEnv });
    await writeJsonAtomic(path.join(cycleDir, 'process.json'), { code: result.code, stdout_tail: result.stdout, stderr_tail: result.stderr, stdout_bytes: result.stdoutBytes, stderr_bytes: result.stderrBytes, truncated: result.truncated, timed_out: result.timedOut });
    last = await safeReadTextFile(fsp, outputFile, result.stdout || result.stderr || '');
    if (containsUserQuestion(last)) {
      await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.guard.question_blocked', cycle });
      if (stream) emitStreamEvent('progress', { mission_id: id, type: 'qaloop.guard.question_blocked', cycle });
      last = `${last}\n\n${noQuestionContinuationReason()}`;
      continue;
    }
    const gate = await evaluateQaGate(dir);
    if (gate.passed) {
      const proof = await maybeFinalizeRoute(root, { missionId: id, route: '$QA-LOOP', gateFile: 'qa-gate.json', gate: gate.gate || gate, artifacts: ['agents/agent-proof-evidence.json', 'qa-native-agent-run.json', 'qa-gate.json', 'qa-ledger.json', reportFile, 'completion-proof.json'], visual: uiRequired, command: { cmd: `sks qa-loop run ${id}`, status: 0 } });
      await setCurrent(root, { mission_id: id, mode: 'QALOOP', phase: 'QALOOP_DONE', questions_allowed: true });
      await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.done', cycle });
      const doneResult = { schema: 'sks.qa-loop-run.v1', ok: proof.ok, mission_id: id, gate, proof: proof.validation };
      if (stream) emitStreamEvent('result', doneResult);
      if (flag(args, '--json')) return console.log(JSON.stringify(doneResult, null, 2));
      console.log(`QA-LOOP done: ${id}`);
      return;
    }
    await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.cycle.continue', cycle, reasons: gate.reasons });
    if (stream) emitStreamEvent('progress', { mission_id: id, type: 'qaloop.cycle.continue', cycle, reasons: gate.reasons });
  }
  const gate = await evaluateQaGate(dir);
  const proof = await maybeFinalizeRoute(root, { missionId: id, route: '$QA-LOOP', gateFile: 'qa-gate.json', gate: gate.gate || gate, artifacts: ['agents/agent-proof-evidence.json', 'qa-native-agent-run.json', 'qa-gate.json', 'qa-ledger.json', reportFile, 'completion-proof.json'], mock: false, statusHint: 'blocked', reason: 'max_cycles', command: { cmd: `sks qa-loop run ${id}`, status: 2 } });
  await setCurrent(root, { mission_id: id, mode: 'QALOOP', phase: 'QALOOP_PAUSED_MAX_CYCLES', questions_allowed: true });
  const pausedResult = { schema: 'sks.qa-loop-run.v1', ok: false, mission_id: id, gate, proof: proof.validation };
  if (stream) emitStreamEvent('result', pausedResult);
  if (flag(args, '--json')) return console.log(JSON.stringify(pausedResult, null, 2));
  console.log(`QA-LOOP paused after max cycles: ${id}`);
}

async function qaLoopStatus(args: any) {
  const root = await sksRoot();
  const id = await resolveMissionId(root, args[0]);
  if (!id) throw new Error('Usage: sks qa-loop status <mission-id|latest>');
  const { dir, mission } = await loadMission(root, id);
  const state = await readJson(stateFile(root), {});
  const status = await qaStatus(dir);
  const nativeAgentPlan = await readJson(path.join(dir, 'qa-agent-plan.json'), null);
  const agentSessions = await readJson(path.join(dir, 'agents', 'agent-sessions.json'), null);
  const desktop = await readJson(path.join(dir, 'qa-loop', 'app-handoff.json'), null);
  const desktopConfirmation = await readJson(path.join(dir, 'qa-loop', 'app-handoff-confirmation.json'), null);
  const desktopReviewComplete = desktopConfirmation?.verdict === 'pass';
  const gateVerdict = await evaluateGate(root, id, 'qa-gate.json');
  if (flag(args, '--json')) return console.log(JSON.stringify({ mission, state, qa: status, desktop_app_handoff: desktop, desktop_app_confirmation: desktopConfirmation, desktop_review_complete: desktopReviewComplete, native_agent_plan: nativeAgentPlan, agent_sessions: agentSessions?.sessions || null, gate_verdict: gateVerdict }, null, 2));
  console.log(gateVerdict.verdict);
  console.log('SKS QA-LOOP Status\n');
  console.log(`Mission:   ${id}`);
  console.log(`Phase:     ${state.phase || mission.phase}`);
  console.log(`Checklist: ${status.checklist_count ?? 'none'}`);
  console.log(`Report:    ${status.report_written ? `present ${status.report_file || ''}`.trim() : 'missing'}`);
  console.log(`Gate:      ${status.gate?.passed ? 'passed' : 'not passed'}`);
  if (status.gate?.reasons?.length) console.log(`Reasons:   ${status.gate.reasons.join(', ')}`);
  if (flag(args, '--desktop')) {
    console.log('Desktop:');
    console.log(`  /app handoff: ${desktop?.status || 'not_requested'}`);
    console.log(`  launch:       ${desktop?.launch_attempt?.attempted ? desktop?.launch_attempt?.launched ? 'launched' : 'attempted_fallback' : 'not_attempted'}`);
    console.log(`  confirmation: ${desktopConfirmation?.verdict || 'missing'}`);
    console.log(`  complete:     ${desktopReviewComplete ? 'yes' : 'no'}`);
    if (desktop?.operator_instruction?.prompt_artifact) console.log(`  prompt:       ${desktop.operator_instruction.prompt_artifact}`);
    console.log('  web evidence: not a substitute for Codex Chrome Extension web UI verification');
  }
}

async function qaLoopAppConfirm(args: any) {
  const root = await sksRoot();
  const id = await resolveMissionId(root, args[0]);
  const verdict = String(readFlagValue(args, '--verdict', '') || '').trim();
  const notes = String(readFlagValue(args, '--notes', '') || '');
  if (!id || !['pass', 'fail'].includes(verdict)) throw new Error('Usage: sks qa-loop app-confirm <mission-id|latest> --verdict pass|fail --notes "..."');
  const result = await confirmQaLoopAppHandoff(root, { missionId: id, verdict: verdict as 'pass' | 'fail', notes });
  const evaluated = await evaluateQaGate(path.join(root, '.sneakoscope', 'missions', id));
  if (flag(args, '--json')) return console.log(JSON.stringify({ schema: 'sks.qa-loop-app-confirm.v1', ok: verdict === 'pass', mission_id: id, confirmation: result.confirmation, artifact_path: result.artifact_path, gate: result.gate, evaluated }, null, 2));
  console.log(`QA-LOOP Desktop app handoff confirmation recorded: ${id} (${verdict})`);
  console.log(path.relative(root, result.artifact_path));
}

async function writeQaLoopImagePathContract(root: string, dir: string, missionId: string, images: any[]) {
  const primary = await writeImageArtifactPathContract(root, {
    missionId,
    images,
    artifactPath: path.join(dir, 'image-artifact-path-contract.json')
  });
  await writeJsonAtomic(path.join(dir, 'qa-loop', 'image-artifact-path-contract.json'), primary.contract);
  return primary;
}
