import path from 'node:path';
import { projectRoot, readJson, readText, writeJsonAtomic, appendJsonl, readStdin, nowIso, runProcess, which, PACKAGE_VERSION } from './fsx.mjs';
import { looksInteractiveCommand, interactiveCommandReason } from './no-question-guard.mjs';
import { missionDir, setCurrent, stateFile } from './mission.mjs';
import { checkDbOperation, dbBlockReason, handleMadSksUserConfirmation } from './db-safety.mjs';
import { checkHarnessModification, harnessGuardBlockReason } from './harness-guard.mjs';
import { activeRouteContext, evaluateStop, prepareRoute, promptPipelineContext as routePipelineContext, recordContext7Evidence, recordSubagentEvidence, routePrompt } from './pipeline.mjs';

const TEAM_DIGEST_MAX_EVENTS = 4;
const TEAM_DIGEST_MESSAGE_CHARS = 180;
const TEAM_DIGEST_CONTEXT_CHARS = 1600;
const TEAM_DIGEST_SYSTEM_CHARS = 260;

async function loadHookPayload() {
  const raw = await readStdin();
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return { raw }; }
}

async function loadState(root) {
  return readJson(stateFile(root), {});
}

function isNoQuestionRunning(state) {
  return (state.mode === 'RALPH' && state.phase === 'RALPH_RUNNING_NO_QUESTIONS')
    || (state.mode === 'RESEARCH' && state.phase === 'RESEARCH_RUNNING_NO_QUESTIONS')
    || (state.mode === 'QALOOP' && state.phase === 'QALOOP_RUNNING_NO_QUESTIONS');
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
    const madSksConfirmation = await handleMadSksUserConfirmation(root, state, prompt);
    if (madSksConfirmation?.handled) {
      const teamDigest = await teamLiveDigest(root, state);
      const additionalContext = [madSksConfirmation.additionalContext, teamDigest?.context].filter(Boolean).join('\n\n');
      return { continue: true, additionalContext, systemMessage: joinSystemMessages(visibleHookMessage('user-prompt-submit', additionalContext), teamDigest?.system) };
    }
    const updateContext = await updateCheckContext(root, payload, prompt);
    const command = dollarCommand(prompt);
    const route = routePrompt(prompt);
    const bypassActiveRoute = route?.id === 'DFix' || route?.id === 'Answer';
    const teamDigest = bypassActiveRoute ? null : await teamLiveDigest(root, state);
    const activeContext = await activeRouteContext(root, state);
    const contexts = [updateContext];
    if (activeContext && !command && !bypassActiveRoute) contexts.push(routePipelineContext(prompt), activeContext);
    else contexts.push((await prepareRoute(root, prompt, state)).additionalContext);
    if (teamDigest?.context) contexts.push(teamDigest.context);
    const additionalContext = contexts.filter(Boolean).join('\n\n');
    return { continue: true, additionalContext, systemMessage: joinSystemMessages(visibleHookMessage('user-prompt-submit', additionalContext), teamDigest?.system) };
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
  if (dbDecision.action === 'block' || dbDecision.action === 'confirm') {
    return { decision: 'block', permissionDecision: 'deny', reason: dbBlockReason(dbDecision) };
  }
  const command = extractCommand(payload);
  if (noQuestion && looksInteractiveCommand(command)) return { decision: 'block', reason: interactiveCommandReason(command) };
  return { continue: true };
}

async function hookPostTool(root, state, payload, noQuestion) {
  const dbDecision = await checkDbOperation(root, state, payload, { duringRalph: noQuestion });
  if (dbDecision.action === 'block' || dbDecision.action === 'confirm') {
    return { decision: 'block', reason: dbBlockReason(dbDecision) };
  }
  await recordContext7Evidence(root, state, payload).catch(() => null);
  await recordSubagentEvidence(root, state, payload).catch(() => null);
  const teamDigest = await teamLiveDigest(root, state);
  if (!noQuestion) {
    return teamDigest?.context
      ? { continue: true, additionalContext: teamDigest.context, systemMessage: joinSystemMessages(visibleHookMessage('post-tool'), teamDigest.system) }
      : { continue: true };
  }
  if (toolFailed(payload)) {
    return {
      additionalContext: [
        'SKS no-question mode is active. Do not ask the user about this tool failure. Apply the active decision ladder, create a fix task only inside the sealed contract, and continue. Do not create unrequested fallback implementation code; block with evidence if the requested path is impossible.',
        teamDigest?.context
      ].filter(Boolean).join('\n\n'),
      systemMessage: joinSystemMessages(visibleHookMessage('post-tool'), teamDigest?.system)
    };
  }
  return teamDigest?.context
    ? { continue: true, additionalContext: teamDigest.context, systemMessage: joinSystemMessages(visibleHookMessage('post-tool'), teamDigest.system) }
    : { continue: true };
}

async function hookPermission(root, state, payload, noQuestion) {
  const harnessDecision = await checkHarnessModification(root, payload, { phase: 'permission-request' });
  if (harnessDecision.action === 'block') {
    return { decision: 'deny', permissionDecision: 'deny', reason: harnessGuardBlockReason(harnessDecision) };
  }
  const dbDecision = await checkDbOperation(root, state, payload, { duringRalph: noQuestion });
  if (dbDecision.action === 'block' || dbDecision.action === 'confirm') {
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
    if (!hasCompletionSummary(last)) {
      return {
        decision: 'block',
        reason: 'SKS final completion summary is required before finishing. Explain what was done, what changed for the user/repo, what was verified, and any remaining gaps before or alongside SKS Honest Mode.'
      };
    }
    if (shouldLoopBackAfterHonestMode(state) && hasHonestModeUnresolvedGap(last)) {
      const loopback = await recordHonestModeLoopback(root, state, last);
      return {
        decision: 'block',
        reason: `SKS Honest Mode found unresolved gaps. Continue from the post-ambiguity execution phase using decision-contract.json, fix them, rerun verification, refresh/validate TriWiki, then retry final Honest Mode. Loopback: ${loopback.relative_file}`
      };
    }
    if (state?.honest_loop_required) await resolveHonestModeLoopback(root, state);
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

function hasCompletionSummary(text) {
  const s = String(text || '');
  const summary = /(completion summary|change summary|what changed|what was done|done summary|작업\s*요약|완료\s*요약|변경\s*요약|무엇을\s*(?:했|했고|변경)|뭐가\s*어떻게|정리)/i.test(s);
  const verification = /(verified|verification|검증|tests?|테스트|evidence|근거|확인|통과)/i.test(s);
  const gap = /(gap|gaps|remaining|제약|남은|미검증|not verified|not run|not claimed|불확실|없음|none)/i.test(s);
  return summary && verification && gap;
}

function hasHonestModeUnresolvedGap(text) {
  return honestModeGapLines(text).length > 0;
}

function honestModeGapLines(text) {
  const issue = /(gap|remaining|unverified|not verified|not run|not complete|incomplete|failed|blocked|blocker|could not|couldn't|missing|미완료|미검증|미실행|실패|차단|누락|못했|못 했|안 했|안함|아직|남은)/i;
  return String(text || '')
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => issue.test(line) && !honestGapLineResolved(line))
    .slice(0, 12);
}

function honestGapLineResolved(line) {
  if (/(남은\s*(?:gap|갭|문제)\s*:\s*없음|남은\s*(?:gap|갭|문제)\s*없음|remaining\s+gaps?\s*:\s*(none|no|0)|no\s+remaining\s+gaps?)/i.test(line)) return true;
  if (/no\s+active\s+blocking\s+route\s+gate\s+detected/i.test(line)) return true;
  if (/(non[-\s]?blocker|non[-\s]?blocking|not\s+(?:a\s+)?blocker|no\s+blocker|does\s+not\s+block|not\s+blocking|blocker\s*(?:는|가)?\s*(?:아님|아닙니다|없음)|차단(?:하지|하진|하지는)\s*않|막(?:지|지는)\s*않)/i.test(line)) return true;
  if (/(요약\s*(?:없으면|없는\s*경우).*(?:차단|block).*(?:요약\s*(?:있으면|있는\s*경우)|통과|pass)|(?:missing|without)\s+summary.*(?:block|blocked).*(?:with\s+summary|pass|accepted))/i.test(line)) return true;
  if (/(차단(?:되는지)?\s*검증|차단\s*(?:확인|검증)|blocked\s+(?:as\s+expected|verified))/i.test(line) && !/(미확인|미검증|못|안\s*됨|실패|failed|not\s+verified|not\s+blocked)/i.test(line)) return true;
  if (/(CHANGELOG|README|\.md|missing|누락|미완료|미검증|미실행|안 했|못했|못 했)/i.test(line)) return false;
  return /(없음|없습니다|없다|해당 없음|none|no unresolved|no remaining|no gaps|zero|0개|n\/a|not applicable)\.?\s*$/i.test(line);
}

function shouldLoopBackAfterHonestMode(state = {}) {
  if (!state?.mission_id) return false;
  if (state.implementation_allowed === false) return false;
  const route = String(state.route || state.mode || '').toLowerCase();
  if (['answer', 'dfix', 'wiki'].includes(route)) return false;
  return Boolean(state.ambiguity_gate_passed || state.clarification_passed || /CONTRACT_SEALED|HONEST_LOOPBACK/i.test(String(state.phase || '')));
}

async function recordHonestModeLoopback(root, state = {}, lastMessage = '') {
  const id = state.mission_id;
  const dir = missionDir(root, id);
  const previousPhase = state.phase || null;
  const mode = String(state.mode || state.route || 'SKS').toUpperCase();
  const phase = `${mode}_HONEST_LOOPBACK_AFTER_CLARIFICATION`;
  const artifact = {
    schema_version: 1,
    mission_id: id,
    previous_phase: previousPhase,
    phase,
    created_at: nowIso(),
    reason: 'honest_mode_unresolved_gap',
    issue_lines: honestModeGapLines(lastMessage),
    next_action: 'continue_from_sealed_contract_without_reasking'
  };
  const file = path.join(dir, 'honest-loopback.json');
  await writeJsonAtomic(file, artifact);
  await appendJsonl(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'pipeline.honest_mode.loopback', previous_phase: previousPhase, phase, issues: artifact.issue_lines });
  await setCurrent(root, {
    phase,
    honest_loop_required: true,
    honest_loop_detected_at: artifact.created_at,
    implementation_allowed: true,
    clarification_required: false,
    questions_allowed: false,
    ambiguity_gate_required: true,
    ambiguity_gate_passed: true
  });
  return { file, relative_file: path.relative(root, file).split(path.sep).join('/') };
}

async function resolveHonestModeLoopback(root, state = {}) {
  const id = state.mission_id;
  const mode = String(state.mode || state.route || 'SKS').toUpperCase();
  if (id) await appendJsonl(path.join(missionDir(root, id), 'events.jsonl'), { ts: nowIso(), type: 'pipeline.honest_mode.loopback_resolved', previous_phase: state.phase || null });
  await setCurrent(root, {
    phase: `${mode}_HONEST_COMPLETE`,
    honest_loop_required: false,
    honest_loop_resolved_at: nowIso(),
    questions_allowed: true
  });
}

async function teamLiveDigest(root, state = {}) {
  if (!isTeamState(state) || !state.mission_id) return null;
  const id = String(state.mission_id);
  const dir = missionDir(root, id);
  const dashboard = await readJson(path.join(dir, 'team-dashboard.json'), null).catch(() => null);
  const transcript = await readText(path.join(dir, 'team-transcript.jsonl'), '').catch(() => '');
  let events = transcript.split(/\n/).filter(Boolean).slice(-TEAM_DIGEST_MAX_EVENTS * 3).map(parseTeamTranscriptLine).filter(Boolean);
  let source = 'team-transcript.jsonl';
  if (!events.length) {
    const live = await readText(path.join(dir, 'team-live.md'), '').catch(() => '');
    events = live.split(/\n/).filter((line) => /^- \d{4}-\d{2}-\d{2}T/.test(line.trim())).slice(-TEAM_DIGEST_MAX_EVENTS).map(parseTeamLiveLine).filter(Boolean);
    source = 'team-live.md';
  }
  if (!events.length) {
    events = dashboard?.latest_messages || [];
    source = 'team-dashboard.json';
  }
  events = normalizeTeamEvents(events).slice(-TEAM_DIGEST_MAX_EVENTS);
  if (!events.length) return null;

  const phase = oneLine(state.phase || dashboard?.phase || 'TEAM', 48);
  const lines = events.map(formatTeamDigestEvent);
  const context = boundText([
    `SKS Team live digest: mission ${id}, phase ${phase}, source ${source}.`,
    `Open live view with: sks team watch ${id}`,
    'Recent events:',
    ...lines.map((line) => `- ${line}`)
  ].join('\n'), TEAM_DIGEST_CONTEXT_CHARS);
  const system = boundText(`SKS Team live: ${lines.at(-1) || `${id} ${phase}`}`, TEAM_DIGEST_SYSTEM_CHARS);
  return { context, system };
}

function isTeamState(state = {}) {
  const values = [state.mode, state.route, state.route_command, state.stop_gate].map((value) => String(value || '').toLowerCase());
  return values.some((value) => value === 'team' || value === '$team' || value.includes('team-gate'));
}

function normalizeTeamEvents(events = []) {
  return events.map((event) => ({
    ts: String(event?.ts || ''),
    agent: oneLine(event?.agent || 'unknown', 40),
    phase: oneLine(event?.phase || 'general', 48),
    message: oneLine(event?.message || '', TEAM_DIGEST_MESSAGE_CHARS)
  })).filter((event) => event.message);
}

function parseTeamTranscriptLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseTeamLiveLine(line) {
  const match = String(line || '').trim().match(/^-\s+(\S+)\s+\[([^\]]+)\]\s+([^:]+):\s*(.*)$/);
  if (!match) return null;
  return { ts: match[1], phase: match[2], agent: match[3], message: match[4] };
}

function formatTeamDigestEvent(event) {
  const ts = shortIsoTime(event.ts);
  return `${ts} [${event.phase}] ${event.agent}: ${event.message}`;
}

function shortIsoTime(ts) {
  return String(ts || '').replace(/^\d{4}-\d{2}-\d{2}T/, '').replace(/\.\d{3}Z$/, 'Z') || 'recent';
}

function oneLine(value, limit) {
  return boundText(String(value || '').replace(/\s+/g, ' ').trim(), limit);
}

function boundText(value, limit) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function joinSystemMessages(...parts) {
  return boundText(parts.filter(Boolean).join(' | '), 420);
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
    if (body.includes('DFix ultralight pipeline active')) return 'SKS: DFix ultralight task list injected.';
    if (body.includes('SKS answer-only pipeline active')) return 'SKS: answer-only research context injected.';
    if (body.includes('SKS wiki pipeline active')) return 'SKS: wiki refresh context injected.';
    if (body.includes('MANDATORY $Ralph')) return 'SKS: Ralph clarification gate prepared in Codex App.';
    if (body.includes('$Team route prepared') || body.includes('Team route')) return 'SKS: Team route, live transcript, and subagent plan injected.';
    if (body.includes('$QA-LOOP route prepared') || body.includes('QA-LOOP')) return 'SKS: QA-LOOP route and safety checklist injected.';
    if (body.includes('Subagent policy: REQUIRED')) return 'SKS: route context injected; subagent execution gate is active.';
    return 'SKS: skill-first route context injected.';
  }
  if (name === 'post-tool') return 'SKS: tool result inspected; Context7/subagent/DB evidence updated when relevant.';
  if (name === 'stop') {
    if (body.includes('Required questions')) return 'SKS: clarification questions reprinted; waiting for answers.';
    return body ? 'SKS: stop gate checked; continuing until route evidence passes.' : 'SKS: stop gate checked.';
  }
  if (name === 'permission-request') return body ? 'SKS: permission request evaluated by harness guards.' : 'SKS: permission request inspected.';
  if (name === 'pre-tool') return body ? 'SKS: tool call inspected by harness guards.' : 'SKS: tool call inspected.';
  return 'SKS: hook evaluated.';
}
