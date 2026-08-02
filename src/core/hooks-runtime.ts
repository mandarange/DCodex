import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectRoot, readJson, writeJsonAtomic, writeTextAtomic, appendJsonl, nowIso, sha256, packageRoot, type JsonData } from './fsx.js';
import { looksInteractiveCommand, interactiveCommandReason } from './no-question-guard.js';
import {
  loadStateForSession,
  missionDir,
  sessionStateKey,
  setCurrent,
  stateFileForSession
} from './mission.js';
import { checkDbOperation, dbBlockReason, handleMadSksUserConfirmation } from './db-safety.js';
import { maybeRecordMadSksSqlPlaneToolResultFromToolUse } from './mad-sks/sql-plane/result-lifecycle.js';
import { checkHarnessModification, harnessGuardBlockReason, isHarnessSourceProject } from './harness-guard.js';
import { isMadSksRouteState } from './permission-gates.js';
import { classifyMadSksShellCommand } from './mad-sks/write-guard.js';
import { activeRouteContext, evaluateStop, prepareRoute, promptPipelineContext as routePipelineContext, recordContext7Evidence, recordSubagentEvidence, routePrompt } from './pipeline.js';
import { localizedFinalizationReason } from './language-preference.js';
import { classifyToolError } from './evaluation.js';
import { dollarCommand, managedSkillNamesForPrompt, stripVisibleDecisionAnswerBlocks } from './routes.js';
import { coreEngineeringDirectiveReferenceText } from './lean-engineering-policy.js';
import { scanAgentTextForRecursion } from './agents/agent-recursion-guard.js';
import { evaluateLoopContinuation } from './loops/loop-continuation-enforcer.js';
import { diagnosticPromptAllowedDuringNoQuestions } from './routes/diagnostic-allowlist.js';
import { maybeReconcileProjectSkillsPreflight } from './hooks-runtime/skill-reconcile-preflight.js';
import { codePackFreshnessNote } from './hooks-runtime/code-pack-freshness-preflight.js';
import { claimHookInvocation } from './hooks-runtime/hook-invocation-dedupe.js';
import { armLightTurnStopBypass, clearLightTurnStopBypass, consumeLightTurnStopBypass, hasMatchingLightTurnStopBypass } from './hooks-runtime/light-turn.js';
import { evaluateHookNarutoDecisionGate, looksLikeActiveContinuationPrompt } from './hooks-runtime/naruto-decision-gate.js';
import {
  ensureOfficialSubagentArtifactDirConfined,
  inspectActiveOfficialSubagentWorkflow,
  recordOfficialSubagentLifecycleCaptureFailure,
  officialSubagentArtifactDir,
  recordAndRefreshSubagentEvidence,
  refreshOfficialSubagentCompletionArtifacts
} from './hooks-runtime/official-subagent-lifecycle.js';
import { finalizationRepeatDecision } from './hooks-runtime/stop-repeat-guard.js';
import {
  activeNarutoParentLaunchMissionId,
  claimStandaloneParentHostCapabilityRuntime
} from './hooks-runtime/standalone-parent-host-capability.js';
import { classifyTaskProfile } from './runtime/task-profile.js';
import { resolveSubagentThreadBudget } from './subagents/thread-budget.js';
import { readOfficialSubagentConfig } from './subagents/official-subagent-config.js';
import { withFileLock } from './locks/file-lock.js';
import {
  ensureConfinedDirectory,
  inspectConfinedPath,
  removeManagedPathVerified
} from './managed-path-safety.js';
import { buildBoundWaveParentGuidance, renderWaveParentGuidance } from './subagents/wave-parent-guidance.js';
import {
  renderAuthoritativeSksSkillContext
} from './codex-native/sks-skill-paths.js';
import { resolveManagedSkillSourcesForAdmission } from './hooks-runtime/managed-skill-admission.js';
import { handleSubagentStop } from './hooks-runtime/subagent-stop-hook.js';
import {
  authoritativeSksSkillResolutionBlockers,
  clearSubagentSkillAvailabilityGuards,
  isSubagentSkillAvailabilityAdmissionMissingReason,
  persistSubagentSkillAvailabilityBlocker,
  recoverResumedOfficialSubagentSkillAvailabilityAdmission,
  renderSubagentSkillAvailabilityHandoff,
  subagentSkillAvailabilityPreToolBlockReason
} from './hooks-runtime/subagent-skill-availability.js';
import {
  HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME,
  HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME,
  HOST_CAPABILITY_HOOK_RUNTIME_FILENAME,
  acasHostToolName,
  authorizeAndMergeHostCapabilityPreToolObservation,
  buildHostCapabilityEvidenceFromHookObservations,
  explicitlyDeniedHostCapabilityTool,
  mergeHostCapabilityPostToolObservation,
  requestHostCapabilities,
  resolveHostCapabilityHookRuntimeBinding,
  sanitizeHostCapabilityPostToolUse,
  sanitizeHostCapabilityPreToolUse,
  type HostCapabilityHookRuntimeBinding
} from './agent-bridge/host-capability-runtime.js';
const LIGHT_ROUTE_STOP_ARTIFACT = 'light-route-stop.json';
const CODEX_GIT_ACTION_STOP_ARTIFACT = 'codex-git-action-stop-bypass.json';
const CODEX_GIT_ACTION_STOP_TTL_MS = 15 * 60 * 1000;
const UPDATE_CHECK_HOOK_INVOCATION_POLICY = 'function-only:no-runSksUpdateCheck-call-in-hooks';
const MAX_ACTIVE_WORKFLOW_QUEUE_ENTRIES = 256;
const MAX_ACTIVE_WORKFLOW_PROMPT_BYTES = 32 * 1024;
const MAX_ACTIVE_WORKFLOW_QUEUE_BYTES = MAX_ACTIVE_WORKFLOW_QUEUE_ENTRIES
  * (MAX_ACTIVE_WORKFLOW_PROMPT_BYTES + 1024);
// Update checks stay function-only in hooks: the policy marker above is checked
// by release readiness so ordinary Codex hook flow cannot grow a hidden update
// prompt path.
import { loadHookPayload, normalizeHookResult, visibleHookMessage } from './hooks-runtime/hook-io.js';
import {
  codexGitActionMetadataSignal,
  codexGitActionMetadataText,
  compactAnswerContext,
  conversationId,
  explicitConversationId,
  extractCommand,
  extractLastMessage,
  extractUserPrompt,
  hookTurnId,
  looksLikeCodexGitAction,
  looksLikeCodexGitActionStopCompletion,
  looksLikeCodexUiSettingsEvent,
  looksLikeMadSksConfirmationPrompt,
  observedParentModel,
  toolFailed
} from './hooks-runtime/payload-signals.js';
import {
  interruptedToolOutputRecoveryBlockReason,
  missingToolOutputCallId,
  missingToolOutputCallIdFromPayload,
  quarantineMissingToolOutput,
  readToolOutputQuarantine
} from './hooks-runtime/tool-output-quarantine.js';
import {
  activeAuthoritativeSksSkillRefresh,
  activeGoalOverlayContext,
  attachAuthoritativeSksSkillContext,
  attachOfficialSubagentSpawnCompatibilityContext,
  authoritativeSksSkillAdmission,
  hookActiveSkillContextRefresh,
  isBlockingClarificationAwaiting,
  looksLikeExplicitActiveWorkflowReplacementPrompt,
  looksLikeClarificationCancel,
  routeBypassesActiveContext,
  routeIsGitOnly,
  selectedSksSkillNamesForActiveState,
  shouldPrepareFreshRouteOnActivePrompt,
  standaloneParentManagedSkillNames
} from './hooks-runtime/hook-context.js';
import {
  sealedSubagentRoutingContext,
  subagentRouteContext
} from './hooks-runtime/subagent-context.js';
export { loadHookPayload, normalizeHookResult };
export { refreshOfficialSubagentCompletionArtifacts };
export { selftestCodexCommitHooks } from './hooks-runtime/codex-commit-hooks-selftest.js';
async function loadState(root: any, payload: any = {}) {
  const sessionKey = conversationId(payload);
  if (!explicitConversationId(payload)) return loadStateForSession(root, sessionKey);
  const hashed = sessionStateKey(sessionKey);
  const sessionState = await readJson(stateFileForSession(root, sessionKey), null).catch(() => null);
  return sessionState ? { ...sessionState, _session_key: sessionState._session_key || hashed } : {};
}
function isNoQuestionRunning(state: any) {
  return (state.mode === 'RESEARCH' && state.phase === 'RESEARCH_RUNNING_NO_QUESTIONS')
    || (state.mode === 'QALOOP' && state.phase === 'QALOOP_RUNNING_NO_QUESTIONS');
}
export async function hookMain(name: any): Promise<JsonData> {
  const payload = await loadHookPayload();
  const root = await projectRoot(payload.cwd || process.cwd());
  return evaluateHookPayloadOnce(name, payload, { root });
}
export async function evaluateHookPayloadOnce(name: any, payload: any = {}, opts: any = {}): Promise<JsonData> {
  const root = opts.root || await projectRoot(payload.cwd || process.cwd());
  if (name === 'user-prompt-submit' && hookPayloadIsLightTurnCandidate(payload)) {
    return evaluateHookPayload(name, payload, { root });
  }
  const claim = await claimHookInvocation(root, name, payload).catch(() => ({ duplicate: false }));
  if (claim.duplicate) return { continue: true, suppressedDuplicate: true };
  return evaluateHookPayload(name, payload, { root });
}
function hookPayloadIsLightTurnCandidate(payload: any = {}) {
  const prompt = stripVisibleDecisionAnswerBlocks(extractUserPrompt(payload));
  if (dollarCommand(prompt)) return false;
  const profile = classifyTaskProfile(prompt);
  if (profile === 'passthrough') return true;
  return routePrompt(prompt)?.id === 'Answer';
}
export async function evaluateHookPayload(name: any, payload: any = {}, opts: any = {}): Promise<JsonData> {
  const root = opts.root || await projectRoot(payload.cwd || process.cwd());
  const sessionKey = conversationId(payload);
  const greetingFastPath = name === 'user-prompt-submit'
    && !dollarCommand(stripVisibleDecisionAnswerBlocks(extractUserPrompt(payload)))
    && classifyTaskProfile(stripVisibleDecisionAnswerBlocks(extractUserPrompt(payload))) === 'passthrough';
  const matchingLightStop = name === 'stop'
    && await hasMatchingLightTurnStopBypass(root, { sessionKey, turnId: hookTurnId(payload) }).catch(() => false);
  if (!explicitConversationId(payload) && !greetingFastPath && !matchingLightStop) {
    await appendJsonl(path.join(root, '.sneakoscope', 'state', 'session-id-fallback-warning.jsonl'), {
      ts: nowIso(),
      warning: 'hook_payload_missing_explicit_session_id',
      conversation_id: sessionKey,
      cwd_hash: sha256(String(payload.cwd || root)).slice(0, 12),
      hook: name
    }).catch(() => null);
  }
  // Hook decisions use persisted session state. Codex hook payloads do not
  // define a trusted `state` field; accepting a partial/spoofed value can hide
  // an active mission or bypass route gates. Explicit opts.state remains for
  // internal replay and focused tests.
  const loadedState = opts.state || await loadState(root, payload);
  const state = { ...loadedState, _session_key: loadedState?._session_key || sessionKey };
  const noQuestion = isNoQuestionRunning(state);
  const sksNarutoDecision = await evaluateHookNarutoDecisionGate({
    root,
    name,
    payload,
    state,
    sessionKey,
    noQuestion,
    parentLaunchMissionId: activeNarutoParentLaunchMissionId()
  });
  const withNarutoDecision = (result: any) => ({ ...result, sksNarutoDecision });
  if (name === 'user-prompt-submit') {
    const result = await hookUserPrompt(root, state, payload, noQuestion, sessionKey);
    const withSkillContext = await attachAuthoritativeSksSkillContext(root, state, payload, result);
    return withNarutoDecision(attachOfficialSubagentSpawnCompatibilityContext(state, payload, withSkillContext));
  }
  if (name === 'session-start' || name === 'pre-compact' || name === 'post-compact') {
    return withNarutoDecision(await hookActiveSkillContextRefresh(root, state, name));
  }
  if (name === 'pre-tool') return withNarutoDecision(await hookPreTool(root, state, payload, noQuestion, sessionKey));
  if (name === 'post-tool') return withNarutoDecision(await hookPostTool(root, state, payload, noQuestion, sessionKey));
  if (name === 'permission-request') return withNarutoDecision(await hookPermission(root, state, payload, noQuestion, sessionKey));
  if (name === 'stop') return withNarutoDecision(await hookStop(root, state, payload, noQuestion, sessionKey));
  if (name === 'subagent-start') return withNarutoDecision(await hookSubagentStart(root, state, payload, sessionKey));
  if (name === 'subagent-stop') return withNarutoDecision(await handleSubagentStop(root, state, payload, sessionKey));
  return withNarutoDecision({ continue: true });
}
async function hookSubagentStart(root: any, state: any, payload: any = {}, sessionKey: any = null) {
  const artifactDir = officialSubagentArtifactDir(root, state, sessionKey);
  const sessionArtifactDir = officialSubagentArtifactDir(root, {}, sessionKey);
  const artifactDirBlockers: string[] = [];
  const artifactDirSafe = await ensureOfficialSubagentArtifactDirConfined(root, artifactDir)
    .then(() => true)
    .catch(() => false);
  if (!artifactDirSafe) artifactDirBlockers.push('subagent_skill_availability_artifact_dir_unsafe');
  // Codex can reuse an official child thread id for a later generation even
  // when the prior child never emitted SubagentStop. Clear any prior
  // generation's guard before evaluating and persisting this start's result.
  await clearSubagentSkillAvailabilityGuards(root, payload, artifactDir, {
    missionId: state?.mission_id,
    workflowRunId: state?.official_subagent_run_id
  }).catch(() => null);
  const config = await readOfficialSubagentConfig(root);
  const budget = resolveSubagentThreadBudget({ configuredMaxThreads: config.maxThreads });
  const active = subagentRouteContext(state);
  const routingContext = artifactDirSafe ? await sealedSubagentRoutingContext(artifactDir, payload) : '';
  const resourceGuard = [
    `SKS Naruto policy: max_threads frame budget is ${budget.maxThreads} (cap, not a spawn target).`,
    'GPT-5.6 four profiles are routing lanes, not an agent-count cap.',
    'Use max_depth=1. Naruto children must not spawn children.',
    'Do not duplicate an already assigned slice.',
    'Parallel writes require disjoint paths; serialize overlapping paths.',
    'Finish only your assigned slice, return a concise result, then stop so the Naruto parent can close this thread.'
  ].join(' ');
  const skillNames = selectedSksSkillNamesForActiveState(state);
  const resolution = skillNames.length
    ? await resolveManagedSkillSourcesForAdmission({
        root,
        skillNames,
        repairMode: 'stale-generation'
      }).catch(() => null)
    : null;
  const skillBlockers = [
    ...artifactDirBlockers,
    ...(skillNames.length ? authoritativeSksSkillResolutionBlockers(resolution) : [])
  ];
  try {
    await persistSubagentSkillAvailabilityBlocker({
      root,
      artifactDir,
      sessionArtifactDir,
      state,
      payload,
      blockers: skillBlockers
    });
  } catch (error: unknown) {
    const blocker = error instanceof Error
      && error.message === 'subagent_skill_availability_blocker_artifact_write_failed'
      ? 'subagent_skill_availability_blocker_artifact_write_failed'
      : 'subagent_skill_availability_guard_persistence_failed';
    skillBlockers.push(blocker);
  }
  if (artifactDirSafe) {
    try {
      await recordAndRefreshSubagentEvidence(root, state, payload, 'SubagentStart', sessionKey);
    } catch {
      const lifecycleBlocker = await recordOfficialSubagentLifecycleCaptureFailure(
        artifactDir,
        state,
        payload,
        'SubagentStart'
      ).catch(() => 'official_subagent_lifecycle_capture_failure_unpersisted');
      skillBlockers.push(lifecycleBlocker);
      await persistSubagentSkillAvailabilityBlocker({
        root,
        artifactDir,
        sessionArtifactDir,
        state,
        payload,
        blockers: skillBlockers
      }).catch(() => {
        skillBlockers.push('subagent_skill_availability_guard_persistence_failed');
      });
    }
  }
  const skillContext = skillBlockers.length
    ? renderSubagentSkillAvailabilityHandoff(skillBlockers)
    : resolution
      ? renderAuthoritativeSksSkillContext(resolution)
      : '';
  const additionalContext = [coreEngineeringDirectiveReferenceText(), resourceGuard, routingContext, active, skillContext].filter(Boolean).join('\n\n');
  return { continue: true, additionalContext, ...(skillBlockers.length ? { silent: true } : {}) };
}
async function hookUserPrompt(root: any, state: any, payload: any, noQuestion: any, sessionKey: any = null) {
  // A receipt is scoped to exactly one submitted turn. Every later prompt,
  // including Codex App git/settings events, invalidates it before returning.
  await clearLightTurnStopBypass(root, { sessionKey }).catch(() => undefined);
  const submittedPrompt = stripVisibleDecisionAnswerBlocks(extractUserPrompt(payload));
  const explicitSession = explicitConversationId(payload);
  const detectedMissingCallId = missingToolOutputCallId(submittedPrompt)
    || missingToolOutputCallIdFromPayload(payload);
  let toolOutputQuarantine = explicitSession
    ? await readToolOutputQuarantine(root, sessionKey).catch(() => null)
    : null;
  if (detectedMissingCallId && explicitSession) {
    toolOutputQuarantine = await quarantineMissingToolOutput({
      root,
      sessionKey,
      callId: detectedMissingCallId,
      missionId: state?.mission_id,
      turnId: hookTurnId(payload)
    }).catch(() => toolOutputQuarantine);
  }
  if (submittedPrompt && (detectedMissingCallId || toolOutputQuarantine)) {
    return {
      decision: 'block',
      reason: interruptedToolOutputRecoveryBlockReason({
        callId: detectedMissingCallId || toolOutputQuarantine?.call_id,
        missionId: state?.mission_id || toolOutputQuarantine?.mission_id
      })
    };
  }
  const parentLaunchMissionId = activeNarutoParentLaunchMissionId();
  if (parentLaunchMissionId) {
    const parentSkillNames = await standaloneParentManagedSkillNames(root, parentLaunchMissionId, state);
    const skillAdmission = await authoritativeSksSkillAdmission(root, parentSkillNames);
    if (skillAdmission.blocked) return skillAdmission.blocked;
    const parentHostCapability = await claimStandaloneParentHostCapabilityRuntime({
      root,
      missionId: parentLaunchMissionId,
      sessionScope: sessionKey,
      explicitSession
    });
    if (parentHostCapability.blocker) {
      return {
        decision: 'block',
        permissionDecision: 'deny',
        reason: `SKS blocked the standalone Naruto parent before host tool execution: ${parentHostCapability.blocker}`
      };
    }
    const attachedState = {
      ...state,
      mission_id: parentLaunchMissionId,
      mode: 'NARUTO',
      route: 'Naruto',
      route_command: '$Naruto',
      route_closed: false,
      required_skills: parentSkillNames,
      subagents_required: true,
      native_sessions_required: false,
      official_subagent_run_id: parentHostCapability.workflowRunId || state?.official_subagent_run_id || null,
      session_scope: sessionKey
    };
    await setCurrent(root, attachedState, { sessionKey, replace: true });
    const activeContext = await activeRouteContext(root, attachedState);
    const skillContext = skillAdmission.resolution
      ? renderAuthoritativeSksSkillContext(skillAdmission.resolution)
      : '';
    const additionalContext = [activeContext, skillContext].filter(Boolean).join('\n\n');
    return {
      continue: true,
      additionalContext,
      systemMessage: visibleHookMessage('user-prompt-submit', additionalContext),
      attached_parent_mission_id: parentLaunchMissionId
    };
  }
  if (looksLikeCodexGitAction(payload)) {
    await armCodexGitActionStopBypass(root, payload).catch(() => null);
    return {
      continue: true,
      systemMessage: 'SKS: Codex App git action bypassed route gates.'
    };
  }
  if (looksLikeCodexUiSettingsEvent(payload)) {
    return {
      continue: true,
      systemMessage: 'SKS: Codex App settings/profile event ignored; route gates unchanged.'
    };
  }
  if (!noQuestion) {
    const prompt = submittedPrompt;
    const taskProfile = classifyTaskProfile(prompt);
    const explicitCommand = Boolean(dollarCommand(prompt));
    const lightRoute = explicitCommand ? null : routePrompt(prompt);
    const clarificationPending = isBlockingClarificationAwaiting(state);
    const madConfirmationPrompt = looksLikeMadSksConfirmationPrompt(prompt);
    const activeContinuation = Boolean(state?.mission_id && state?.route_closed !== true && looksLikeActiveContinuationPrompt(prompt));
    if (!explicitCommand && !clarificationPending && !madConfirmationPrompt && !activeContinuation && taskProfile === 'passthrough') {
      const turnId = hookTurnId(payload);
      if (turnId) {
        await armLightTurnStopBypass(root, {
          sessionKey,
          turnId,
          prompt,
          profile: 'passthrough',
          ttlMs: 60_000
        });
      }
      return { continue: true, silent: true, sksTaskProfile: taskProfile };
    }
    if (!explicitCommand && !clarificationPending && !madConfirmationPrompt && !activeContinuation && lightRoute?.id === 'Answer') {
      const skillAdmission = await authoritativeSksSkillAdmission(root, lightRoute.requiredSkills || ['answer', 'honest-mode']);
      if (skillAdmission.blocked) return skillAdmission.blocked;
      const turnId = hookTurnId(payload);
      if (turnId) {
        await armLightTurnStopBypass(root, {
          sessionKey,
          turnId,
          prompt,
          profile: 'answer',
          ttlMs: 5 * 60_000
        });
      }
      const skillContext = skillAdmission.resolution
        ? renderAuthoritativeSksSkillContext(skillAdmission.resolution)
        : '';
      const additionalContext = [compactAnswerContext(prompt), skillContext].filter(Boolean).join('\n\n');
      return { continue: true, additionalContext, sksTaskProfile: 'answer' };
    }
    const madSksConfirmation = madConfirmationPrompt
      ? await handleMadSksUserConfirmation(root, state, prompt)
      : null;
    if (madSksConfirmation?.handled) {
      const additionalContext = madSksConfirmation.additionalContext;
      return { continue: true, additionalContext, systemMessage: visibleHookMessage('user-prompt-submit', additionalContext) };
    }
    if (activeContinuation) {
      const activeContext = await activeRouteContext(root, state);
      return {
        continue: true,
        additionalContext: activeContext,
        systemMessage: visibleHookMessage('user-prompt-submit', activeContext)
      };
    }
    const updateContext = '';
    const command = dollarCommand(prompt);
    const route = routePrompt(prompt);
    if (routeIsGitOnly(route)) {
      await armCodexGitActionStopBypass(root, payload).catch(() => null);
      return {
        continue: true,
        systemMessage: `SKS: ${route.command} git action bypassed pipeline route gates.`
      };
    }
    const explicitActiveWorkflowReplacement = looksLikeExplicitActiveWorkflowReplacementPrompt(prompt);
    const activeOfficialWorkflow = state?.mission_id
      && state?.route_closed !== true
      && state?.official_subagent_run_id
      && !activeGoalOverlayContext(state, route)
      ? await inspectActiveOfficialSubagentWorkflow(root, state, sessionKey)
      : { status: 'inactive' as const };
    if (activeOfficialWorkflow.status === 'invalid') {
      return {
        decision: 'block',
        reason: `SKS refused to replace the active official-subagent workflow because its parent binding could not be verified (${activeOfficialWorkflow.reason}). Active mission=${activeOfficialWorkflow.missionId}, workflow_run_id=${activeOfficialWorkflow.workflowRunId}. The root parent must inspect and explicitly settle or cancel that exact run before preparing another workflow.`
      };
    }
    if (activeOfficialWorkflow.status === 'active') {
      if (explicitActiveWorkflowReplacement && activeOfficialWorkflow.openThreads > 0) {
        return {
          decision: 'block',
          reason: `SKS refused to replace active official-subagent workflow ${activeOfficialWorkflow.workflowRunId}: ${activeOfficialWorkflow.openThreads} child thread(s) remain open in mission ${activeOfficialWorkflow.missionId}. The root parent must settle or explicitly cancel the old run before submitting the replacement.`
        };
      }
      if (explicitActiveWorkflowReplacement) {
        const consumed = await consumeActiveOfficialWorkflowQueue(
          root,
          activeOfficialWorkflow.missionId,
          activeOfficialWorkflow.workflowRunId
        );
        if (!consumed) {
          return {
            decision: 'block',
            reason: `SKS refused to replace settled workflow_run_id=${activeOfficialWorkflow.workflowRunId} because its bounded additive queue could not be consumed safely.`
          };
        }
      }
      if (!explicitActiveWorkflowReplacement) {
        const activeSkillAdmission = await authoritativeSksSkillAdmission(
          root,
          selectedSksSkillNamesForActiveState(state)
        );
        if (activeSkillAdmission.blocked) return activeSkillAdmission.blocked;
        const queued = await queueActiveOfficialWorkflowPrompt({
          root,
          missionId: activeOfficialWorkflow.missionId,
          workflowRunId: activeOfficialWorkflow.workflowRunId,
          sessionKey,
          prompt
        });
        if (!queued.ok) {
          return {
            decision: 'block',
            reason: `SKS preserved active workflow_run_id=${activeOfficialWorkflow.workflowRunId} but could not queue this addition (${queued.reason}). Wait for the root parent to drain the bounded active-run queue, then retry.`
          };
        }
        const activeContext = await activeRouteContext(root, state);
        const skillContext = activeSkillAdmission.resolution
          ? renderAuthoritativeSksSkillContext(activeSkillAdmission.resolution)
          : '';
        const queueContext = `The latest user request was queued as an addition to active workflow_run_id=${activeOfficialWorkflow.workflowRunId}; preserve that run binding and let the root parent decompose the added scope. Open child threads: ${activeOfficialWorkflow.openThreads}. Do not prepare a replacement workflow from this prompt.`;
        const additionalContext = [activeContext, skillContext, queueContext].filter(Boolean).join('\n\n');
        return {
          continue: true,
          additionalContext,
          systemMessage: visibleHookMessage('user-prompt-submit', additionalContext),
          queued_active_workflow_run_id: activeOfficialWorkflow.workflowRunId
        };
      }
    }
    const skillAdmission = await authoritativeSksSkillAdmission(root, managedSkillNamesForPrompt(route, prompt));
    if (skillAdmission.blocked) return skillAdmission.blocked;
    const skillContext = skillAdmission.resolution
      ? renderAuthoritativeSksSkillContext(skillAdmission.resolution)
      : '';
    await maybeReconcileProjectSkillsPreflight(root).catch(() => null);
    const bypassActiveRoute = routeBypassesActiveContext(route);
    const goalOverlay = activeGoalOverlayContext(state, route);
    const prepareFreshRoute = shouldPrepareFreshRouteOnActivePrompt(prompt, route, {
      command,
      bypassActiveRoute,
      goalOverlay
    });
    if (isBlockingClarificationAwaiting(state) && !looksLikeClarificationCancel(prompt)) {
      const activeContext = await activeRouteContext(root, state);
      const additionalContext = [updateContext, activeContext].filter(Boolean).join('\n\n');
      return { continue: true, additionalContext, systemMessage: visibleHookMessage('user-prompt-submit', additionalContext) };
    }
    const shouldLoadActiveContext = !command && !bypassActiveRoute && !goalOverlay && !prepareFreshRoute;
    const activeContext = shouldLoadActiveContext ? await activeRouteContext(root, state) : '';
    const contexts = [updateContext, skillContext];
    if (activeContext && shouldLoadActiveContext) contexts.push(routePipelineContext(prompt), activeContext);
    else contexts.push((await prepareRoute(root, prompt, state, {
      sessionKey,
      parentModel: observedParentModel(payload)
    })).additionalContext);
    if (goalOverlay) contexts.push(goalOverlay);
    const codePackNote = await codePackFreshnessNote(root);
    if (codePackNote) contexts.push(codePackNote);
    const additionalContext = contexts.filter(Boolean).join('\n\n');
    return { continue: true, additionalContext, systemMessage: visibleHookMessage('user-prompt-submit', additionalContext) };
  }
  const prompt = stripVisibleDecisionAnswerBlocks(extractUserPrompt(payload));
  if (diagnosticPromptAllowedDuringNoQuestions(prompt)) {
    return {
      continue: true,
      systemMessage: 'SKS: diagnostic command allowed during no-question mode by command registry contract.'
    };
  }
  const id = state.mission_id;
  if (id) await appendJsonl(path.join(missionDir(root, id), 'user_queue.jsonl'), { ts: nowIso(), payload });
  return {
    decision: 'block',
    reason: 'SKS no-question/no-interruption mode is active. User prompt has been queued until the run completes.'
  };
}

async function queueActiveOfficialWorkflowPrompt(input: {
  root: string;
  missionId: string;
  workflowRunId: string;
  sessionKey: unknown;
  prompt: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (Buffer.byteLength(input.prompt, 'utf8') > MAX_ACTIVE_WORKFLOW_PROMPT_BYTES) {
    return { ok: false, reason: 'active_workflow_prompt_too_large' };
  }
  const dir = missionDir(input.root, input.missionId);
  const queueFile = activeOfficialWorkflowQueueFile(dir, input.missionId, input.workflowRunId);
  try {
    return await withFileLock({
      lockPath: path.join(dir, '.active-workflow-user-queue.lock'),
      timeoutMs: 5_000,
      staleMs: 60_000
    }, async () => {
      await ensureConfinedDirectory(path.resolve(input.root), path.dirname(queueFile));
      const stat = await fsp.stat(queueFile).catch((error: any) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (stat && (!stat.isFile() || stat.size > MAX_ACTIVE_WORKFLOW_QUEUE_BYTES)) {
        return { ok: false as const, reason: 'active_workflow_queue_invalid_or_oversized' };
      }
      const current = stat ? await fsp.readFile(queueFile, 'utf8') : '';
      const lines = current.split(/\r?\n/).filter(Boolean);
      if (lines.length >= MAX_ACTIVE_WORKFLOW_QUEUE_ENTRIES) {
        return { ok: false as const, reason: 'active_workflow_queue_full' };
      }
      for (const line of lines) JSON.parse(line);
      const row = {
          schema: 'sks.active-official-subagent-request.v1',
          ts: nowIso(),
          disposition: 'queued_for_root_decomposition',
          mission_id: input.missionId,
          workflow_run_id: input.workflowRunId,
          session_scope_hash: sha256(String(input.sessionKey || 'default')),
          prompt: input.prompt
        };
      const next = `${current.replace(/\s*$/, current ? '\n' : '')}${JSON.stringify(row)}\n`;
      if (Buffer.byteLength(next, 'utf8') > MAX_ACTIVE_WORKFLOW_QUEUE_BYTES) {
        return { ok: false as const, reason: 'active_workflow_queue_full' };
      }
      await writeTextAtomic(queueFile, next);
      return { ok: true as const };
    });
  } catch {
    return { ok: false, reason: 'active_workflow_queue_persistence_failed' };
  }
}

function activeOfficialWorkflowQueueFile(dir: string, missionId: string, workflowRunId: string): string {
  const runKey = sha256(JSON.stringify([missionId, workflowRunId]));
  return path.join(dir, 'active-workflow-user-queue', `run-${runKey}.jsonl`);
}

async function consumeActiveOfficialWorkflowQueue(
  root: string,
  missionId: string,
  workflowRunId: string
): Promise<boolean> {
  const dir = missionDir(root, missionId);
  const queueFile = activeOfficialWorkflowQueueFile(dir, missionId, workflowRunId);
  try {
    return await withFileLock({
      lockPath: path.join(dir, '.active-workflow-user-queue.lock'),
      timeoutMs: 5_000,
      staleMs: 60_000
    }, async () => {
      const inspected = await inspectConfinedPath(path.resolve(root), queueFile);
      if (inspected.exists) {
        if (inspected.leafSymlink || !inspected.stat?.isFile()) return false;
        await removeManagedPathVerified(path.resolve(root), queueFile);
      }
      return true;
    });
  } catch {
    return false;
  }
}
async function hookPreTool(root: any, state: any, payload: any, noQuestion: any, sessionKey: any = null) {
  const artifactDir = officialSubagentArtifactDir(root, state, sessionKey);
  const activeBinding = {
    missionId: state?.mission_id,
    workflowRunId: state?.official_subagent_run_id
  };
  const evaluateSkillAvailabilityBlock = () => subagentSkillAvailabilityPreToolBlockReason(
    root,
    payload,
    artifactDir,
    activeBinding
  ).catch((error: unknown) => {
    const code = error instanceof Error && error.message === 'subagent_skill_availability_guard_invalid'
      ? 'subagent_skill_availability_guard_invalid'
      : 'subagent_skill_availability_guard_check_failed';
    return `SKS blocked this child tool call because managed skill availability failed (${code}). Return the blocker to the root parent without using tools.`;
  });
  let skillAvailabilityBlock = await evaluateSkillAvailabilityBlock();
  if (isSubagentSkillAvailabilityAdmissionMissingReason(skillAvailabilityBlock)) {
    const recovered = await recoverResumedOfficialSubagentSkillAvailabilityAdmission({
      root,
      payload,
      artifactDir,
      sessionArtifactDir: officialSubagentArtifactDir(root, {}, sessionKey),
      activeBinding,
      skillNames: selectedSksSkillNamesForActiveState(state)
    }).catch(() => false);
    if (recovered) skillAvailabilityBlock = await evaluateSkillAvailabilityBlock();
  }
  if (skillAvailabilityBlock) {
    return { decision: 'block', permissionDecision: 'deny', reason: skillAvailabilityBlock };
  }
  const skillRefresh = await activeAuthoritativeSksSkillRefresh(root, state);
  if (skillRefresh.blocked) {
    return {
      decision: 'block',
      permissionDecision: 'deny',
      reason: skillRefresh.blocked.reason,
      systemMessage: skillRefresh.blocked.systemMessage
    };
  }
  if (needsMutationSafetyCheck(payload)) {
    const madSksImmutableDecision = await checkMadSksImmutableModification(root, state, payload);
    if (madSksImmutableDecision.action === 'block') {
      return { decision: 'block', permissionDecision: 'deny', reason: madSksImmutableBlockReason(madSksImmutableDecision) };
    }
    const harnessDecision = await checkHarnessModification(root, payload, { phase: 'pre-tool' });
    if (harnessDecision.action === 'block') {
      return { decision: 'block', permissionDecision: 'deny', reason: harnessGuardBlockReason(harnessDecision) };
    }
    const dbDecision = await checkDbOperation(root, state, payload, { duringNoQuestion: noQuestion });
    if (dbDecision.action === 'block' || dbDecision.action === 'confirm') {
      return { decision: 'block', permissionDecision: 'deny', reason: dbBlockReason(dbDecision) };
    }
  }
  if (clarificationGateLocked(state) && !clarificationAnswerToolAllowed(payload)) {
    return { decision: 'block', permissionDecision: 'deny', reason: clarificationPauseBlockReason(state) };
  }
  const command = extractCommand(payload);
  const agentRecursionDecision = agentWorkerHookRecursionDecision(state, payload, command);
  if (agentRecursionDecision) return agentRecursionDecision;
  if (noQuestion && looksInteractiveCommand(command)) return { decision: 'block', reason: interactiveCommandReason(command) };
  const hostCapabilityDecision = await enforceHostCapabilityPreTool(root, state, payload, sessionKey);
  if (hostCapabilityDecision && hostCapabilityDecision.continue !== true) return hostCapabilityDecision;
  const waveGuidance = await parentWaveGuidanceContext(root, state, sessionKey).catch(() => '');
  const additionalContext = [skillRefresh.context, waveGuidance].filter(Boolean).join('\n\n');
  if (additionalContext) {
    return {
      continue: true,
      additionalContext,
      ...(waveGuidance
        ? { systemMessage: visibleHookMessage('pre-tool', 'SKS Naruto wave lifecycle requires root-parent follow-up.') }
        : { silent: true })
    };
  }
  return { continue: true };
}

async function parentWaveGuidanceContext(root: any, state: any = {}, sessionKey: any = null) {
  if (!state?.mission_id && !state?.official_subagent_run_id) return '';
  const isNaruto = String(state?.mode || '').toUpperCase() === 'NARUTO'
    || String(state?.route || state?.route_command || '').replace(/^\$/, '').toUpperCase() === 'NARUTO'
    || state?.subagents_required === true;
  if (!isNaruto) return '';
  // Child worker hooks must not receive parent wave spawn instructions.
  if (agentWorkerHookContext(state, {})) return '';
  const artifactDir = officialSubagentArtifactDir(root, state, sessionKey);
  const plan: any = await readJson(path.join(artifactDir, 'subagent-plan.json'), null).catch(() => null);
  const guidance = buildBoundWaveParentGuidance(plan, {
    missionId: state?.mission_id,
    workflowRunId: state?.official_subagent_run_id
  });
  if (!guidance?.required) return '';
  return renderWaveParentGuidance(guidance);
}

function agentWorkerHookRecursionDecision(state: any = {}, payload: any = {}, command: any = '') {
  if (!agentWorkerHookContext(state, payload)) return null;
  const guard = scanAgentTextForRecursion(command);
  if (guard.ok) return null;
  return {
    decision: 'block',
    permissionDecision: 'deny',
    reason: `Agent command recursion guard blocked nested SKS route command in Codex PreToolUse hook: ${guard.violations.join(', ')}`
  };
}

function agentWorkerHookContext(state: any = {}, payload: any = {}) {
  const env = {
    ...(payload.env || {}),
    ...(payload.tool_input?.env || {}),
    ...(payload.toolInput?.env || {}),
    ...(payload.input?.env || {}),
    ...(payload.tool?.input?.env || {})
  };
  void state;
  return Boolean(String(env.SKS_AGENT_WORKER || '') === '1'
    || String(env.SKS_DISABLE_ROUTE_RECURSION || '') === '1'
    || payload.agent_worker === true
    || payload.agentWorker === true);
}

async function hookPostTool(root: any, state: any, payload: any, noQuestion: any, sessionKey: any = null) {
  state = { ...state, _session_key: state?._session_key || sessionKey };
  await Promise.all([
    recordHostCapabilityPostTool(root, state, payload, sessionKey).catch(() => null),
    recordMadSksSqlPlanePostToolLifecycle(root, state, payload).catch(() => null),
    recordContext7Evidence(root, state, payload).catch(() => null),
    recordSubagentEvidence(root, state, payload).catch(() => null),
    toolFailed(payload) ? recordToolErrorTaxonomy(root, state, payload).catch(() => null) : Promise.resolve(null)
  ]);
  if (!noQuestion) return { continue: true };
  if (toolFailed(payload)) {
    return {
      additionalContext: 'SKS no-question mode is active. Do not ask the user about this tool failure. Apply the active decision ladder, create a fix task only inside the sealed contract, and continue. Do not create unrequested fallback implementation code; block with evidence if the requested path is impossible.',
      systemMessage: visibleHookMessage('post-tool')
    };
  }
  return { continue: true };
}

async function enforceHostCapabilityPreTool(root: string, state: any = {}, payload: any = {}, sessionKey: any = null) {
  const tool = acasHostToolName(payload.tool_name);
  if (!tool) return null;
  if (explicitlyDeniedHostCapabilityTool(tool)) {
    return {
      decision: 'block',
      permissionDecision: 'deny',
      reason: `SKS denied acas-tools.${tool}; this tool is explicitly denied for model execution.`
    };
  }
  const context = await loadHostCapabilityHookContext(root, state, payload, sessionKey);
  if (!context) {
    return {
      decision: 'block',
      permissionDecision: 'deny',
      reason: 'SKS denied this acas-tools call because it has no valid task-scoped Naruto mission, run, and session context.'
    };
  }
  if (!context.binding) {
    return {
      decision: 'block',
      permissionDecision: 'deny',
      reason: `SKS denied this acas-tools call because the current Naruto mission has no valid task-scoped host capability runtime: ${context.blocker}`
    };
  }
  const observation = sanitizeHostCapabilityPreToolUse(context.binding.runtime, payload);
  if (!observation) {
    return {
      decision: 'block',
      permissionDecision: 'deny',
      reason: 'SKS denied this acas-tools call because its official PreToolUse identity fields are invalid.'
    };
  }
  let authorization: { decision: 'allowed' | 'denied'; blocker: string | null } = {
    decision: observation.decision,
    blocker: observation.blocker
  };
  try {
    await withFileLock({
      lockPath: path.join(context.dir, '.host-capability-hooks.lock'),
      timeoutMs: 5_000,
      staleMs: 60_000
    }, async () => {
      const current = await readJson(path.join(context.dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME), null).catch(() => null);
      const result = authorizeAndMergeHostCapabilityPreToolObservation({
        binding: context.binding!,
        current,
        observation
      });
      authorization = result;
      await writeJsonAtomic(path.join(context.dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME), result.observations);
    });
  } catch {
    return {
      decision: 'block',
      permissionDecision: 'deny',
      reason: 'SKS denied this acas-tools call because its bounded PreToolUse evidence could not be persisted.'
    };
  }
  if (authorization.decision === 'denied') {
    return {
      decision: 'block',
      permissionDecision: 'deny',
      reason: authorization.blocker
        ? `SKS denied acas-tools.${observation.tool}; ${authorization.blocker}.`
        : `SKS denied acas-tools.${observation.tool}; it is outside runtime.allowed_tool_names for this mission, run, and session.`
    };
  }
  return { continue: true };
}

async function recordHostCapabilityPostTool(root: string, state: any = {}, payload: any = {}, sessionKey: any = null) {
  if (!acasHostToolName(payload.tool_name)) return null;
  const context = await loadHostCapabilityHookContext(root, state, payload, sessionKey);
  if (!context?.binding) return null;
  const observation = sanitizeHostCapabilityPostToolUse(payload);
  if (!observation) return null;
  return withFileLock({
    lockPath: path.join(context.dir, '.host-capability-hooks.lock'),
    timeoutMs: 5_000,
    staleMs: 60_000
  }, async () => {
    const current = await readJson(path.join(context.dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME), null).catch(() => null);
    const next = mergeHostCapabilityPostToolObservation({
      binding: context.binding!,
      current,
      observation
    });
    const evidence = buildHostCapabilityEvidenceFromHookObservations({
      binding: context.binding!,
      observations: next
    });
    await Promise.all([
      writeJsonAtomic(path.join(context.dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME), next),
      writeJsonAtomic(path.join(context.dir, HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME), evidence)
    ]);
    return evidence;
  });
}

async function loadHostCapabilityHookContext(
  root: string,
  state: any = {},
  payload: any = {},
  sessionKey: any = null
): Promise<{
  dir: string;
  binding: HostCapabilityHookRuntimeBinding | null;
  blocker: string;
} | null> {
  const missionId = String(state?.mission_id || '').trim();
  const workflowRunId = String(state?.official_subagent_run_id || '').trim();
  const payloadSession = String(payload?.session_id || '').trim();
  const expectedSession = String(state?.session_scope || sessionKey || '').trim();
  const isNaruto = String(state?.mode || '').toUpperCase() === 'NARUTO'
    || String(state?.route || state?.route_command || '').replace(/^\$/, '').toUpperCase() === 'NARUTO'
    || state?.subagents_required === true;
  if (!isNaruto || !missionId || !workflowRunId || !payloadSession || !expectedSession) return null;
  if (payloadSession !== expectedSession || (sessionKey && String(sessionKey) !== payloadSession)) return null;
  const dir = missionDir(root, missionId);
  const [raw, plan] = await Promise.all([
    readJson(path.join(dir, HOST_CAPABILITY_HOOK_RUNTIME_FILENAME), null).catch(() => null),
    readJson(path.join(dir, 'subagent-plan.json'), null).catch(() => null)
  ]);
  const request = requestHostCapabilities(plan?.goal || state?.prompt || '');
  return { dir, ...resolveHostCapabilityHookRuntimeBinding(raw, {
    missionId,
    workflowRunId,
    sessionScope: payloadSession,
    request
  }) };
}

function needsMutationSafetyCheck(payload: any = {}) {
  const toolName = String(payload.tool_name || payload.toolName || payload.name || payload.tool?.name || '');
  const knownReadOnly = /^(Read|Grep|Glob|LS|TodoRead|WebFetch|WebSearch|BashOutput|NotebookRead|ListMcpResources|ReadMcpResource)$/i;
  if (knownReadOnly.test(toolName)) return /\b(sql|supabase|db|migration)\b/i.test(JSON.stringify(payload || {}));
  if (/^(Edit|Write|MultiEdit|NotebookEdit|Bash|Shell|ApplyPatch)$/i.test(toolName)) return true;
  if (/\b(sql|supabase|db|migration)\b/i.test(toolName)) return true;
  return true;
}

async function recordMadSksSqlPlanePostToolLifecycle(root: any, state: any = {}, payload: any = {}) {
  if (!state?.mission_id) return null;
  return maybeRecordMadSksSqlPlaneToolResultFromToolUse({
    root,
    missionId: String(state.mission_id),
    toolCallPayload: payload,
    toolResult: payload
  });
}

function extractRowCount(payload: any = {}) {
  const candidates = [
    payload.row_count,
    payload.rowCount,
    payload.tool_response?.row_count,
    payload.tool_response?.rowCount,
    payload.toolResponse?.rowCount,
    payload.result?.row_count,
    payload.result?.rowCount,
    payload.result?.rows_affected,
    payload.tool_response?.rows_affected
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractToolError(payload: any = {}) {
  return String(payload.error || payload.message || payload.stderr || payload.tool_response?.stderr || payload.toolResponse?.stderr || payload.result?.stderr || payload.result?.error || 'tool_failed');
}

async function recordToolErrorTaxonomy(root: any, state: any = {}, payload: any = {}) {
  if (!state?.mission_id) return null;
  const classification = classifyToolError({
    code: payload.exit_code ?? payload.exitCode ?? payload.tool_response?.exit_code ?? payload.result?.exit_code,
    name: payload.tool_name || payload.name || payload.tool?.name,
    message: payload.error || payload.message || payload.stderr || payload.tool_response?.stderr || payload.result?.stderr,
    stderr: payload.stderr || payload.tool_response?.stderr || payload.result?.stderr
  });
  const record = {
    ts: nowIso(),
    classification,
    unknown_is_harness_bug: classification === 'Unknown',
    tool: payload.tool_name || payload.name || payload.tool?.name || null,
    payload_hash: sha256(JSON.stringify(payload || {})).slice(0, 16)
  };
  await appendJsonl(path.join(missionDir(root, state.mission_id), 'tool-errors.jsonl'), record);
  return record;
}

async function hookPermission(root: any, state: any, payload: any, noQuestion: any, sessionKey: any = null) {
  void sessionKey;
  const madSksImmutableDecision = await checkMadSksImmutableModification(root, state, payload);
  if (madSksImmutableDecision.action === 'block') {
    return { decision: 'deny', permissionDecision: 'deny', reason: madSksImmutableBlockReason(madSksImmutableDecision) };
  }
  const harnessDecision = await checkHarnessModification(root, payload, { phase: 'permission-request' });
  if (harnessDecision.action === 'block') {
    return { decision: 'deny', permissionDecision: 'deny', reason: harnessGuardBlockReason(harnessDecision) };
  }
  const dbDecision = await checkDbOperation(root, state, payload, { duringNoQuestion: noQuestion });
  if (dbDecision.action === 'block' || dbDecision.action === 'confirm') {
    return { decision: 'deny', permissionDecision: 'deny', reason: dbBlockReason(dbDecision) };
  }
  if (clarificationGateLocked(state) && !clarificationAnswerToolAllowed(payload)) {
    return { decision: 'deny', permissionDecision: 'deny', reason: clarificationPauseBlockReason(state) };
  }
  if (noQuestion && looksLikeUserGitAction(payload)) return { continue: true };
  if (!noQuestion) return { continue: true };
  return {
    decision: 'deny',
    permissionDecision: 'deny',
    reason: 'SKS no-question mode forbids mid-loop approval prompts. Choose a non-approval safe alternative using the active plan.'
  };
}

async function checkMadSksImmutableModification(root: any, state: any = {}, payload: any = {}) {
  if (!isMadSksRouteState(state)) return { action: 'allow' };
  if (await isHarnessSourceProject(root).catch(() => false)) {
    return { action: 'allow', reason: 'harness_source_exception_or_unlocked' };
  }
  const command = extractCommand(payload);
  const classified: any = await classifyMadSksShellCommand({ command: command || JSON.stringify(payload || {}), cwd: payload.cwd || process.cwd(), root: packageRoot() }).catch((err: any) => ({ action: 'allow', error: err.message }));
  if (classified.action === 'block' && (classified.protected_core_matches?.length || classified.reasons?.includes('cwd_is_protected_core'))) {
    await appendJsonl(path.join(root, '.sneakoscope', 'state', 'mad-sks-immutable-guard.jsonl'), { ts: nowIso(), classified }).catch(() => {});
    return { action: 'block', classified };
  }
  return { action: 'allow', classified };
}

function madSksImmutableBlockReason(decision: any = {}) {
  const reasons = decision.classified?.reasons?.join(', ') || 'protected_core_path';
  return `MAD-SKS immutable harness guard blocked this tool call. SKS package/source/dist/scripts/schemas/release metadata remain read-only even in MAD-SKS mode: ${reasons}.`;
}

function looksLikeUserGitAction(payload: any = {}) {
  const command = extractCommand(payload);
  const haystack = [
    command,
    codexGitActionMetadataText(payload),
    payload.action,
    payload.intent,
    payload.operation,
    payload.permission,
    payload.description,
    payload.message,
    payload.tool_name,
    payload.toolName
  ].filter(Boolean).join(' ');
  if (/\b(?:reset\s+--hard|clean\s+-[^\s]*f|checkout\s+--|restore\s+|rm\s+|push\s+--force|push\s+-[^\s]*f)\b/i.test(command)) return false;
  if (codexGitActionMetadataSignal(haystack)) return true;
  if (/\bcodex\b[\s_-]*(?:app\s*)?(?:git\s*)?(?:action|commit|push|pr)\b/i.test(haystack)) return true;
  if (!/^\s*git\s+/i.test(command)) return false;
  return /\bgit\s+(?:status|diff|add|commit|push|branch|remote|rev-parse|log)\b/i.test(command);
}

function clarificationGateLocked(state: any = {}) {
  if (isBlockingClarificationAwaiting(state)) return true;
  return Boolean(
    state?.mission_id
    && state.implementation_allowed === false
    && state.ambiguity_gate_required === true
    && state.ambiguity_gate_passed !== true
    && (String(state.phase || '').includes('CLARIFICATION_AWAITING_ANSWERS') || String(state.stop_gate || '') === 'clarification-gate')
  );
}

function clarificationAnswerToolAllowed(payload: any = {}) {
  const command = extractCommand(payload);
  if (/\bpipeline\s+answer\b/i.test(command) && /\b(?:sks|sks\.js|bin\/sks\.js|node)\b/i.test(command)) return true;
  if (!payloadMentionsAnswersJson(payload)) return false;
  if (!command) return true;
  if (/\bpipeline\s+answer\b/i.test(command)) return true;
  return !/\b(npm|git|selftest|packcheck|release:check|publish:dry|publish:ignore-scripts|publish:npm|doctor|naruto|qa-loop|wiki|db|test)\b/i.test(command);
}

function payloadMentionsAnswersJson(payload: any = {}) {
  try {
    return /\banswers\.json\b/i.test(JSON.stringify(payload || {}));
  } catch {
    return false;
  }
}

function clarificationPauseBlockReason(state: any = {}) {
  const id = state?.mission_id || 'latest';
  const route = state.route_command || state.route || state.mode || 'route';
  return `SKS ${route} ambiguity gate is paused and waiting for explicit user answers. Do not run implementation, tests, route materialization, or unrelated tools yet. The only allowed action is sealing the user's reply with "sks pipeline answer ${id} --stdin"; elapsed time or repeated hook resumes never count as answers.`;
}

async function hookStop(root: any, state: any, payload: any, noQuestion: any, sessionKey: any = null) {
  const last = extractLastMessage(payload);
  if (!noQuestion) {
    const lightTurn = await consumeLightTurnStopBypass(root, { sessionKey, turnId: hookTurnId(payload) });
    if (lightTurn.accepted) return { continue: true, action: 'light_turn', silent: true };
  }
  if (state?.mode === 'LOOP' || state?.route === 'Loop' || state?.route_command === '$Loop') {
    const missionId = state?.mission_id;
    if (missionId) {
      const continuation = await evaluateLoopContinuation({ root, missionId }).catch(() => null);
      if (continuation?.should_continue) {
        return {
          decision: 'block',
          reason: `SKS Loop continuation required. Resume with: ${continuation.resume_instruction}`
        };
      }
    }
  }
  if (await consumeCodexGitActionStopBypass(root, payload)) {
    return {
      continue: true,
      systemMessage: 'SKS: Codex App git action accepted without route finalization gates.'
    };
  }
  if (looksLikeCodexGitActionStopCompletion(last, payload)) {
    return {
      continue: true,
      systemMessage: 'SKS: Codex App git action completion accepted without route finalization gates.'
    };
  }
  if (!noQuestion && (hasDfixLightCompletion(last) || await consumeLightRouteStop(root, payload))) {
    return {
      continue: true,
      systemMessage: 'SKS: DFix ultralight finalization accepted; full-route Honest Mode loopback is not required.'
    };
  }
  if (state?.subagents_required === true) {
    await refreshOfficialSubagentCompletionArtifacts(root, state, last, sessionKey).catch(() => null);
  }
  const routeDecision = await evaluateStop(root, state, payload, { noQuestion });
  if (routeDecision && !successfulAppNarutoStopNeedsVisibleSummary(state, routeDecision)) {
    return routeDecision;
  }
  if (!noQuestion) {
    const languageBasis = state?.prompt || state?.task || extractUserPrompt(payload) || last;
    if (!hasHonestMode(last)) {
      const reason = localizedFinalizationReason('honest_mode_missing', languageBasis);
      const repeatDecision = await finalizationRepeatDecision(root, state, payload, reason, 'honest_mode_missing');
      return repeatDecision || {
        decision: 'block',
        reason
      };
    }
    if (!hasCompletionSummary(last)) {
      const reason = localizedFinalizationReason('completion_summary_missing', languageBasis);
      const repeatDecision = await finalizationRepeatDecision(root, state, payload, reason, 'completion_summary_missing');
      return repeatDecision || {
        decision: 'block',
        reason
      };
    }
    if (shouldLoopBackAfterHonestMode(state) && hasHonestModeUnresolvedGap(last)) {
      const loopback = await recordHonestModeLoopback(root, state, last, sessionKey);
      return {
        decision: 'block',
        reason: `${localizedFinalizationReason('honest_loopback', languageBasis)} Loopback: ${loopback.relative_file}`
      };
    }
    if (state?.honest_loop_required) await resolveHonestModeLoopback(root, state, sessionKey);
    return routeDecision || { continue: true };
  }
  return {
    decision: 'block',
    reason: 'SKS no-question run is not done. Continue autonomously, fix failing checks, update the active gate file, and do not ask the user.'
  };
}

function successfulAppNarutoStopNeedsVisibleSummary(state: any = {}, routeDecision: any = {}) {
  const route = String(state?.route || state?.route_command || state?.mode || '')
    .replace(/^\$/, '')
    .replace(/[-_]/g, '')
    .toUpperCase();
  return route === 'NARUTO'
    && Boolean(state?.session_scope)
    && routeDecision?.continue === true
    && !['hard_blocked', 'route_closed'].includes(String(routeDecision?.action || ''));
}

async function consumeLightRouteStop(root: any, payload: any = {}) {
  const file = path.join(root, '.sneakoscope', 'state', LIGHT_ROUTE_STOP_ARTIFACT);
  const record = await readJson(file, null).catch(() => null);
  if (!record?.pending_stop_bypass) return false;
  if (record.route !== 'DFix') return false;
  const nowMs = Date.now();
  const expiresMs = Date.parse(record.expires_at || '');
  if (!Number.isFinite(expiresMs) || expiresMs < nowMs) return false;
  const currentConversation = conversationId(payload);
  if (record.conversation_id && record.conversation_id !== currentConversation) return false;
  await writeJsonAtomic(file, {
    ...record,
    pending_stop_bypass: false,
    consumed_at: nowIso()
  }).catch(() => null);
  return true;
}

function hasDfixLightCompletion(text: any) {
  const s = String(text || '');
  const marker = /^\s*(?:\*\*)?\s*(?:\$?DFix|dfix)\s*(?:완료\s*요약|completion\s+summary)\s*[:：]/im.test(s);
  if (!marker) return false;
  const honest = /^\s*(?:\*\*)?\s*(?:\$?DFix|dfix)\s*(?:솔직모드|honest(?:\s+mode)?)\s*[:：]/im.test(s);
  if (!honest) return false;
  const verification = /(검증|확인|통과|verified|verification|checked|evidence|근거)/i.test(s);
  const gap = /(미검증|남은|문제|gap|remaining|not verified|not run|blocker|차단|불가|없음|none)/i.test(s);
  return verification && gap;
}

async function armCodexGitActionStopBypass(root: any, payload: any = {}) {
  const nowMs = Date.now();
  const record = {
    schema_version: 1,
    route: 'codex_git_action',
    pending_stop_bypass: true,
    conversation_id: conversationId(payload),
    created_at: nowIso(),
    expires_at: new Date(nowMs + CODEX_GIT_ACTION_STOP_TTL_MS).toISOString()
  };
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'state', CODEX_GIT_ACTION_STOP_ARTIFACT), record);
  return record;
}

async function consumeCodexGitActionStopBypass(root: any, payload: any = {}) {
  const file = path.join(root, '.sneakoscope', 'state', CODEX_GIT_ACTION_STOP_ARTIFACT);
  const record = await readJson(file, null).catch(() => null);
  if (!record?.pending_stop_bypass) return false;
  if (!['codex_git_action', 'codex_git_commit'].includes(record.route)) return false;
  const expiresMs = Date.parse(record.expires_at || '');
  if (!Number.isFinite(expiresMs) || expiresMs < Date.now()) return false;
  const currentConversation = conversationId(payload);
  if (record.conversation_id && record.conversation_id !== currentConversation) return false;
  await writeJsonAtomic(file, {
    ...record,
    pending_stop_bypass: false,
    consumed_at: nowIso()
  }).catch(() => null);
  return true;
}

function hasHonestMode(text: any) {
  const s = String(text || '');
  return /(SKS Honest Mode|솔직모드|Honest Mode)/i.test(s)
    && /(verified|verification|검증|tests?|테스트|evidence|근거|gap|제약|uncertainty|불확실)/i.test(s);
}

function hasCompletionSummary(text: any) {
  const s = String(text || '');
  const summary = /(completion summary|change summary|what changed|what was done|done summary|작업\s*요약|완료\s*요약|변경\s*요약|무엇을\s*(?:했|했고|변경)|뭐가\s*어떻게|정리)/i.test(s);
  const verification = /(verified|verification|검증|tests?|테스트|evidence|근거|확인|통과)/i.test(s);
  const gap = /(gap|gaps|remaining|제약|남은|미검증|not verified|not run|not claimed|불확실|없음|none)/i.test(s);
  return summary && verification && gap;
}

function hasHonestModeUnresolvedGap(text: any) {
  return honestModeGapLines(text).length > 0;
}

export function honestModeGapLines(text: any) {
  const issue = /(gap|remaining|unverified|not verified|not run|not complete|incomplete|failed|blocked|blocker|could not|couldn't|missing|미완료|미검증|미실행|실패|차단|누락|못했|못 했|안 했|안함|아직|남은)/i;
  const lines = String(text || '')
    .split(/\n/)
    .map((line: any) => line.trim());
  return lines
    .filter((line: any, index: number) => issue.test(line)
      && !honestGapLineResolved(line)
      && !honestGapHeadingResolved(
        line,
        lines.slice(index + 1).find((candidate: string) => candidate.length > 0)
      ))
    .slice(0, 12);
}

function honestGapHeadingResolved(line: any, nextLine: any) {
  const heading = String(line || '').replace(/^#{1,6}\s*/, '').replace(/\s*[:：]\s*$/, '').trim();
  if (!/^(?:remaining|unresolved)\s+(?:gaps?|issues?)$|^(?:남은|미해결)\s*(?:문제|항목|갭|gap)$/i.test(heading)) {
    return false;
  }
  return /^(?:없음|없습니다|없다|none|no(?:ne)?|0|0개)[.!。]?$/i.test(String(nextLine || '').trim());
}

function honestGapLineResolved(line: any) {
  if (/(?:unverified|미검증)\s*:\s*\[\s*\]/i.test(line) && /blockers?\s*:\s*\[\s*\]/i.test(line)) return true;
  if (/(?:^|[\s*-])(?:unverified|미검증|blockers?)\s*:\s*\[\s*\](?:\s*(?:[,.;]|$).*)?$/i.test(line)) return true;
  if (/(?:미해결|남은)\s*(?:gap|갭|문제|항목)\s*:\s*(?:없음|없습니다|없다|0|0개)(?:\s|,|\.|$)/i.test(line)) return true;
  if (/unresolved\s+gaps?\s+(?:for|in)[^:]*:\s*(?:none|no|0)\b/i.test(line)) return true;
  if (/no\s+unresolved\s+gaps?\s+remain/i.test(line)) return true;
  if (/(남은\s*(?:gap|갭|문제)\s*:\s*없음|남은\s*(?:gap|갭|문제)\s*없음|remaining\s+gaps?\s*:\s*(none|no|0)|no\s+remaining\s+gaps?)/i.test(line)) return true;
  if (/no\s+active\s+blocking\s+route\s+gate\s+detected/i.test(line)) return true;
  if (/(?:blockers?|차단(?:\s*(?:항목|요소|건))?)\s*(?:[:=]\s*)?0(?:건|개)?\b/i.test(line)) return true;
  if (/(non[-\s]?blocker|non[-\s]?blocking|not\s+(?:a\s+)?blocker|no\s+blocker|does\s+not\s+block|not\s+blocking|비\s*차단|blocker\s*(?:는|가)?\s*(?:아님|아닙니다|없음)|차단(?:하지|하진|하지는)\s*않|막(?:지|지는)\s*않)/i.test(line)) return true;
  if (/(요약\s*(?:없으면|없는\s*경우).*(?:차단|block).*(?:요약\s*(?:있으면|있는\s*경우)|통과|pass)|(?:missing|without)\s+summary.*(?:block|blocked).*(?:with\s+summary|pass|accepted))/i.test(line)) return true;
  if (/(차단(?:되는지)?\s*검증|차단\s*(?:확인|검증)|blocked\s+(?:as\s+expected|verified))/i.test(line) && !/(미확인|미검증|못|안\s*됨|실패|failed|not\s+verified|not\s+blocked)/i.test(line)) return true;
  if (/(CHANGELOG|README|\.md|missing|누락|미완료|미검증|미실행|안 했|못했|못 했)/i.test(line)) return false;
  return /(없음|없습니다|없다|해당 없음|none|no unresolved|no remaining|no gaps|zero|0개|n\/a|not applicable)\.?\s*$/i.test(line);
}

function shouldLoopBackAfterHonestMode(state: any = {}) {
  if (!state?.mission_id) return false;
  if (state.implementation_allowed === false) return false;
  const route = String(state.route || state.mode || '').toLowerCase();
  if (['answer', 'dfix', 'wiki'].includes(route)) return false;
  // Bound honest-mode loopbacks so the same unresolved gap cannot spin forever.
  const attempts = Number(state.honest_loop_attempt_count || 0);
  if (Number.isFinite(attempts) && attempts >= MAX_HONEST_LOOPBACK_ATTEMPTS) return false;
  return Boolean(state.ambiguity_gate_passed || state.clarification_passed || /CONTRACT_SEALED|HONEST_LOOPBACK/i.test(String(state.phase || '')));
}

const MAX_HONEST_LOOPBACK_ATTEMPTS = 2;

async function recordHonestModeLoopback(root: any, state: any = {}, lastMessage: any = '', sessionKey: any = null) {
  const id = state.mission_id;
  const dir = missionDir(root, id);
  const previousPhase = state.phase || null;
  const mode = String(state.mode || state.route || 'SKS').toUpperCase();
  const phase = `${mode}_HONEST_LOOPBACK_AFTER_CLARIFICATION`;
  const attempt = Number(state.honest_loop_attempt_count || 0) + 1;
  const artifact = {
    schema_version: 1,
    mission_id: id,
    previous_phase: previousPhase,
    phase,
    created_at: nowIso(),
    reason: 'honest_mode_unresolved_gap',
    attempt,
    max_attempts: MAX_HONEST_LOOPBACK_ATTEMPTS,
    issue_lines: honestModeGapLines(lastMessage),
    next_action: attempt >= MAX_HONEST_LOOPBACK_ATTEMPTS
      ? 'stop_with_terminal_blocker_or_record_hard_blocker'
      : 'continue_from_sealed_contract_without_reasking'
  };
  const file = path.join(dir, 'honest-loopback.json');
  await writeJsonAtomic(file, artifact);
  await appendJsonl(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'pipeline.honest_mode.loopback', proof_invalidating: false, previous_phase: previousPhase, phase, attempt, issues: artifact.issue_lines });
  await setCurrent(root, {
    phase,
    honest_loop_required: true,
    honest_loop_detected_at: artifact.created_at,
    honest_loop_attempt_count: attempt,
    implementation_allowed: true,
    clarification_required: false,
    questions_allowed: false,
    ambiguity_gate_required: true,
    ambiguity_gate_passed: true
  }, { sessionKey: sessionKey || state._session_key });
  return { file, relative_file: path.relative(root, file).split(path.sep).join('/') };
}

async function resolveHonestModeLoopback(root: any, state: any = {}, sessionKey: any = null) {
  const id = state.mission_id;
  const mode = String(state.mode || state.route || 'SKS').toUpperCase();
  if (id) await appendJsonl(path.join(missionDir(root, id), 'events.jsonl'), { ts: nowIso(), type: 'pipeline.honest_mode.loopback_resolved', proof_invalidating: false, previous_phase: state.phase || null });
  await setCurrent(root, {
    phase: `${mode}_HONEST_COMPLETE`,
    honest_loop_required: false,
    honest_loop_resolved_at: nowIso(),
    questions_allowed: true
  }, { sessionKey: sessionKey || state._session_key });
}

export async function emitHook(name: any) {
  const result = await hookMain(name);
  process.stdout.write(`${JSON.stringify(normalizeHookResult(name, result))}\n`);
}
