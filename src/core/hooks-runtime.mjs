import path from 'node:path';
import { projectRoot, readJson, writeJsonAtomic, appendJsonl, readStdin, nowIso, runProcess, which, PACKAGE_VERSION } from './fsx.mjs';
import { looksInteractiveCommand, interactiveCommandReason } from './no-question-guard.mjs';
import { missionDir, stateFile } from './mission.mjs';
import { checkDbOperation, dbBlockReason } from './db-safety.mjs';
import { checkHarnessModification, harnessGuardBlockReason } from './harness-guard.mjs';
import { activeRouteContext, evaluateStop, prepareRoute, promptPipelineContext as routePipelineContext, recordContext7Evidence, recordSubagentEvidence } from './pipeline.mjs';

async function loadHookPayload() {
  const raw = await readStdin();
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return { raw }; }
}

async function loadState(root) {
  return readJson(stateFile(root), {});
}

function isNoQuestionRunning(state) {
  return (state.mode === 'RALPH' && state.phase === 'RALPH_RUNNING_NO_QUESTIONS')
    || (state.mode === 'RESEARCH' && state.phase === 'RESEARCH_RUNNING_NO_QUESTIONS');
}

function extractLastMessage(payload) {
  return payload.last_assistant_message || payload.assistant_message || payload.message || payload.response || payload.raw || '';
}

function extractUserPrompt(payload) {
  return payload.prompt
    || payload.user_prompt
    || payload.userPrompt
    || payload.message
    || payload.input?.prompt
    || payload.input?.message
    || payload.raw
    || '';
}

function conversationId(payload) {
  return String(payload.conversation_id || payload.thread_id || payload.session_id || payload.chat_id || payload.cwd || 'default');
}

function extractCommand(payload) {
  return payload.command || payload.tool_input?.command || payload.toolInput?.command || payload.input?.command || payload.tool?.input?.command || '';
}

function toolFailed(payload = {}) {
  const candidates = [
    payload.exit_code,
    payload.exitCode,
    payload.tool_response?.exit_code,
    payload.toolResponse?.exitCode,
    payload.result?.exit_code,
    payload.result?.exitCode
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const n = Number(candidate);
    if (Number.isFinite(n)) return n !== 0;
  }
  if (payload.success === false || payload.tool_response?.success === false || payload.toolResponse?.success === false || payload.result?.success === false) return true;
  if (payload.executed === false) return true;
  return false;
}

function dollarCommand(prompt) {
  const match = String(prompt || '').trim().match(/^\$([A-Za-z][A-Za-z0-9_-]*)(?:\s|:|$)/);
  return match ? match[1].toUpperCase() : null;
}

function looksLikeUpdateDecline(prompt) {
  return /^(no|nope|skip|later|not now|don't|dont|아니|아니요|안해|안 함|나중에|건너뛰|스킵)/i.test(String(prompt || '').trim());
}

function looksLikeUpdateAccept(prompt) {
  return /^(yes|y|ok|okay|update|upgrade|do it|go ahead|응|네|예|업데이트|해줘|진행)/i.test(String(prompt || '').trim());
}

export async function hookMain(name) {
  const payload = await loadHookPayload();
  const root = await projectRoot(payload.cwd || process.cwd());
  const state = await loadState(root);
  const noQuestion = isNoQuestionRunning(state);
  if (name === 'user-prompt-submit') return hookUserPrompt(root, state, payload, noQuestion);
  if (name === 'pre-tool') return hookPreTool(root, state, payload, noQuestion);
  if (name === 'post-tool') return hookPostTool(root, state, payload, noQuestion);
  if (name === 'permission-request') return hookPermission(root, state, payload, noQuestion);
  if (name === 'stop') return hookStop(root, state, payload, noQuestion);
  return { continue: true };
}

async function hookUserPrompt(root, state, payload, noQuestion) {
  if (!noQuestion) {
    const prompt = extractUserPrompt(payload);
    const updateContext = await updateCheckContext(root, payload, prompt);
    const command = dollarCommand(prompt);
    const activeContext = await activeRouteContext(root, state);
    const contexts = [updateContext];
    if (activeContext && !command) contexts.push(routePipelineContext(prompt), activeContext);
    else contexts.push((await prepareRoute(root, prompt, state)).additionalContext);
    const additionalContext = contexts.filter(Boolean).join('\n\n');
    return { continue: true, additionalContext, systemMessage: visibleHookMessage('user-prompt-submit', additionalContext) };
  }
  const id = state.mission_id;
  if (id) await appendJsonl(path.join(missionDir(root, id), 'user_queue.jsonl'), { ts: nowIso(), payload });
  return {
    decision: 'block',
    reason: 'SKS no-question/no-interruption mode is active. User prompt has been queued until the run completes.'
  };
}

async function hookPreTool(root, state, payload, noQuestion) {
  const harnessDecision = await checkHarnessModification(root, payload, { phase: 'pre-tool' });
  if (harnessDecision.action === 'block') {
    return { decision: 'block', permissionDecision: 'deny', reason: harnessGuardBlockReason(harnessDecision) };
  }
  const dbDecision = await checkDbOperation(root, state, payload, { duringRalph: noQuestion });
  if (dbDecision.action === 'block') {
    return { decision: 'block', permissionDecision: 'deny', reason: dbBlockReason(dbDecision) };
  }
  const command = extractCommand(payload);
  if (noQuestion && looksInteractiveCommand(command)) return { decision: 'block', reason: interactiveCommandReason(command) };
  return { continue: true };
}

async function hookPostTool(root, state, payload, noQuestion) {
  const dbDecision = await checkDbOperation(root, state, payload, { duringRalph: noQuestion });
  if (dbDecision.action === 'block') {
    return { decision: 'block', reason: dbBlockReason(dbDecision) };
  }
  await recordContext7Evidence(root, state, payload).catch(() => null);
  await recordSubagentEvidence(root, state, payload).catch(() => null);
  if (!noQuestion) return { continue: true };
  if (toolFailed(payload)) {
    return {
      additionalContext: 'SKS no-question mode is active. Do not ask the user about this tool failure. Apply the active plan fallback ladder, create a fix task, and continue.'
    };
  }
  return { continue: true };
}

async function hookPermission(root, state, payload, noQuestion) {
  const harnessDecision = await checkHarnessModification(root, payload, { phase: 'permission-request' });
  if (harnessDecision.action === 'block') {
    return { decision: 'deny', permissionDecision: 'deny', reason: harnessGuardBlockReason(harnessDecision) };
  }
  const dbDecision = await checkDbOperation(root, state, payload, { duringRalph: noQuestion });
  if (dbDecision.action === 'block') {
    return { decision: 'deny', permissionDecision: 'deny', reason: dbBlockReason(dbDecision) };
  }
  if (!noQuestion) return { continue: true };
  return {
    decision: 'deny',
    permissionDecision: 'deny',
    reason: 'SKS no-question mode forbids mid-loop approval prompts. Choose a non-approval safe alternative using the active plan.'
  };
}

async function hookStop(root, state, payload, noQuestion) {
  const routeDecision = await evaluateStop(root, state, payload, { noQuestion });
  if (routeDecision) return routeDecision;
  if (!noQuestion) {
    const last = extractLastMessage(payload);
    if (!hasHonestMode(last)) {
      return {
        decision: 'block',
        reason: 'SKS Honest Mode is required before finishing. Re-check the actual goal, verify evidence/tests, state gaps honestly, and only then provide the final answer. Include a short "SKS Honest Mode" or "솔직모드" section.'
      };
    }
    return { continue: true };
  }
  return {
    decision: 'block',
    reason: 'SKS no-question run is not done. Continue autonomously, fix failing checks, update the active gate file, and do not ask the user.'
  };
}

async function updateCheckContext(root, payload, prompt) {
  if (process.env.SKS_DISABLE_UPDATE_CHECK === '1') return '';
  const statePath = path.join(root, '.sneakoscope', 'state', 'update-check.json');
  const updateState = await readJson(statePath, {});
  const conv = conversationId(payload);
  const pending = updateState.pending_offer;
  if (pending?.conversation_id === conv && pending?.latest && looksLikeUpdateDecline(prompt)) {
    await writeJsonAtomic(statePath, {
      ...updateState,
      pending_offer: null,
      skipped: { conversation_id: conv, latest: pending.latest, skipped_at: nowIso() }
    });
    return `SKS update check: user skipped update to ${pending.latest} for this conversation only. Continue the previous task without updating. Check again on the next conversation.`;
  }
  if (pending?.conversation_id === conv && pending?.latest && looksLikeUpdateAccept(prompt)) {
    await writeJsonAtomic(statePath, {
      ...updateState,
      pending_offer: null,
      accepted: { conversation_id: conv, latest: pending.latest, accepted_at: nowIso() }
    });
    return `SKS update check: user accepted update to ${pending.latest}. Before doing other work, run the appropriate update command, then rerun sks setup and sks doctor --fix. Global install: npm i -g sneakoscope. Project install: npm i -D sneakoscope && npx sks setup --install-scope project.`;
  }
  if (updateState.skipped?.conversation_id === conv && updateState.skipped?.latest) {
    return `SKS update check: update ${updateState.skipped.latest} was skipped for this conversation only. Do not ask again in this conversation; check again next conversation.`;
  }
  const check = await checkLatestVersion();
  await writeJsonAtomic(statePath, {
    ...updateState,
    current: PACKAGE_VERSION,
    latest: check.latest || null,
    checked_at: nowIso(),
    check_error: check.error || null
  });
  if (!check.latest || check.error || compareVersions(check.latest, PACKAGE_VERSION) <= 0) return '';
  await writeJsonAtomic(statePath, {
    ...updateState,
    current: PACKAGE_VERSION,
    latest: check.latest,
    checked_at: nowIso(),
    pending_offer: { conversation_id: conv, latest: check.latest, offered_at: nowIso() },
    skipped: updateState.skipped?.conversation_id === conv ? null : updateState.skipped || null
  });
  return `SKS update check: installed ${PACKAGE_VERSION}, latest ${check.latest}. Before any other work, ask the user to choose: "Update SKS now" or "Skip update for this conversation". If they choose update, run npm i -g sneakoscope for global installs, or npm i -D sneakoscope && npx sks setup --install-scope project for project installs, then run sks setup and sks doctor --fix. If they skip, do not ask again in this conversation, but check again next conversation.`;
}

async function checkLatestVersion() {
  const npm = await which('npm').catch(() => null);
  if (!npm) return { error: 'npm not found' };
  const result = await runProcess(npm, ['view', 'sneakoscope', 'version'], { timeoutMs: 3500, maxOutputBytes: 4096 });
  if (result.code !== 0) return { error: `${result.stderr || result.stdout || 'npm view failed'}`.trim() };
  return { latest: result.stdout.trim().split(/\s+/).pop() };
}

function compareVersions(a, b) {
  const pa = String(a || '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b || '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function hasHonestMode(text) {
  const s = String(text || '');
  return /(SKS Honest Mode|솔직모드|Honest Mode)/i.test(s)
    && /(verified|verification|검증|tests?|테스트|evidence|근거|gap|제약|uncertainty|불확실)/i.test(s);
}

export async function emitHook(name) {
  const result = await hookMain(name);
  process.stdout.write(`${JSON.stringify(normalizeHookResult(name, result))}\n`);
}

function normalizeHookResult(name, result = {}) {
  const eventName = codexHookEventName(name);
  const out = { ...result };
  const systemMessage = out.systemMessage || visibleHookMessage(name, out.reason || out.additionalContext || '');
  const normalized = { continue: out.continue !== false, systemMessage };
  const reason = out.reason || 'SKS guard denied this action.';

  if (eventName === 'UserPromptSubmit' || eventName === 'PostToolUse') {
    if (out.decision === 'block') {
      normalized.decision = 'block';
      normalized.reason = reason;
    }
    if (out.additionalContext) {
      normalized.hookSpecificOutput = {
        hookEventName: eventName,
        additionalContext: out.additionalContext
      };
    }
    return normalized;
  }

  if (eventName === 'PreToolUse') {
    if (out.decision === 'block' || out.permissionDecision === 'deny' || out.decision === 'deny') {
      normalized.decision = 'block';
      normalized.reason = reason;
    }
    return normalized;
  }

  if (eventName === 'PermissionRequest') {
    if (out.decision === 'deny' || out.permissionDecision === 'deny') {
      normalized.hookSpecificOutput = {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: reason
        }
      };
    } else if (out.decision === 'allow' || out.permissionDecision === 'allow') {
      normalized.hookSpecificOutput = {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' }
      };
    }
    return normalized;
  }

  if (eventName === 'Stop') {
    if (out.decision === 'block') {
      normalized.decision = 'block';
      normalized.reason = reason;
    }
    return normalized;
  }

  return normalized;
}

function codexHookEventName(name) {
  return {
    'user-prompt-submit': 'UserPromptSubmit',
    'pre-tool': 'PreToolUse',
    'post-tool': 'PostToolUse',
    'permission-request': 'PermissionRequest',
    'stop': 'Stop'
  }[name] || name;
}

function visibleHookMessage(name, text = '') {
  const body = String(text || '');
  if (name === 'user-prompt-submit') {
    if (body.includes('MANDATORY $Ralph')) return 'SKS: Ralph clarification gate prepared in Codex App.';
    if (body.includes('$Team route prepared') || body.includes('Team route')) return 'SKS: Team route, live transcript, and subagent plan injected.';
    if (body.includes('Subagent policy: REQUIRED')) return 'SKS: route context injected; subagent execution gate is active.';
    return 'SKS: skill-first route context injected.';
  }
  if (name === 'post-tool') return 'SKS: tool result inspected; Context7/subagent/DB evidence updated when relevant.';
  if (name === 'stop') return body ? 'SKS: stop gate checked; continuing until route evidence passes.' : 'SKS: stop gate checked.';
  if (name === 'permission-request') return body ? 'SKS: permission request evaluated by harness guards.' : 'SKS: permission request inspected.';
  if (name === 'pre-tool') return body ? 'SKS: tool call inspected by harness guards.' : 'SKS: tool call inspected.';
  return 'SKS: hook evaluated.';
}
