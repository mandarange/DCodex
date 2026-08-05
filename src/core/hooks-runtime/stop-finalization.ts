import path from 'node:path';
import { appendJsonl, nowIso, readJson, writeJsonAtomic } from '../fsx.js';
import { missionDir, setCurrent } from '../mission.js';
import { isLightCompletionRoute } from '../routes/light-routes.js';
import { conversationId } from './payload-signals.js';

const LIGHT_ROUTE_STOP_ARTIFACT = 'light-route-stop.json';
const CODEX_GIT_ACTION_STOP_ARTIFACT = 'codex-git-action-stop-bypass.json';
const CODEX_GIT_ACTION_STOP_TTL_MS = 15 * 60 * 1000;
const MAX_HONEST_LOOPBACK_ATTEMPTS = 2;

export function successfulAppNarutoStopNeedsVisibleSummary(state: any = {}, routeDecision: any = {}) {
  const route = String(state?.route || state?.route_command || state?.mode || '')
    .replace(/^\$/, '')
    .replace(/[-_]/g, '')
    .toUpperCase();
  return route === 'NARUTO'
    && Boolean(state?.session_scope)
    && routeDecision?.continue === true
    && !['hard_blocked', 'route_closed'].includes(String(routeDecision?.action || ''));
}

export async function consumeLightRouteStop(root: any, payload: any = {}) {
  const file = path.join(root, '.sneakoscope', 'state', LIGHT_ROUTE_STOP_ARTIFACT);
  const record = await readJson(file, null).catch(() => null);
  if (!record?.pending_stop_bypass || record.route !== 'DFix') return false;
  const expiresMs = Date.parse(record.expires_at || '');
  if (!Number.isFinite(expiresMs) || expiresMs < Date.now()) return false;
  const currentConversation = conversationId(payload);
  if (record.conversation_id && record.conversation_id !== currentConversation) return false;
  return writeJsonAtomic(file, { ...record, pending_stop_bypass: false, consumed_at: nowIso() })
    .then(() => true, () => false);
}

export function hasDfixLightCompletion(text: any) {
  const s = String(text || '');
  const marker = /^\s*(?:\*\*)?\s*(?:\$?DFix|dfix)\s*(?:완료\s*요약|completion\s+summary)\s*[:：]/im.test(s);
  const honest = /^\s*(?:\*\*)?\s*(?:\$?DFix|dfix)\s*(?:솔직모드|honest(?:\s+mode)?)\s*[:：]/im.test(s);
  const verification = /(검증|확인|통과|verified|verification|checked|evidence|근거)/i.test(s);
  const gap = /(미검증|남은|문제|gap|remaining|not verified|not run|blocker|차단|불가|없음|none)/i.test(s);
  return marker && honest && verification && gap;
}

export async function armCodexGitActionStopBypass(root: any, payload: any = {}) {
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

export async function consumeCodexGitActionStopBypass(root: any, payload: any = {}) {
  const file = path.join(root, '.sneakoscope', 'state', CODEX_GIT_ACTION_STOP_ARTIFACT);
  const record = await readJson(file, null).catch(() => null);
  if (!record?.pending_stop_bypass || !['codex_git_action', 'codex_git_commit'].includes(record.route)) return false;
  const expiresMs = Date.parse(record.expires_at || '');
  if (!Number.isFinite(expiresMs) || expiresMs < Date.now()) return false;
  const currentConversation = conversationId(payload);
  if (record.conversation_id && record.conversation_id !== currentConversation) return false;
  return writeJsonAtomic(file, { ...record, pending_stop_bypass: false, consumed_at: nowIso() })
    .then(() => true, () => false);
}

export function hasHonestMode(text: any) {
  const s = String(text || '');
  return /(SKS Honest Mode|솔직모드|Honest Mode)/i.test(s)
    && /(verified|verification|검증|tests?|테스트|evidence|근거|gap|제약|uncertainty|불확실)/i.test(s);
}

export function hasCompletionSummary(text: any) {
  const s = String(text || '');
  const summary = /(completion summary|change summary|what changed|what was done|done summary|작업\s*요약|완료\s*요약|변경\s*요약|무엇을\s*(?:했|했고|변경)|뭐가\s*어떻게|정리)/i.test(s);
  const verification = /(verified|verification|검증|tests?|테스트|evidence|근거|확인|통과)/i.test(s);
  const gap = /(gap|gaps|remaining|제약|남은|미검증|not verified|not run|not claimed|불확실|없음|none)/i.test(s);
  return summary && verification && gap;
}

export function hasHonestModeUnresolvedGap(text: any) {
  return honestModeGapLines(text).length > 0;
}

export function honestModeGapLines(text: any) {
  const issue = /(gap|remaining|unverified|not verified|not run|not complete|incomplete|failed|blocked|blocker|could not|couldn't|missing|미완료|미검증|미실행|실패|차단|누락|못했|못 했|안 했|안함|아직|남은)/i;
  const lines = String(text || '').split(/\n/).map((line: any) => line.trim());
  return lines
    .filter((line: any, index: number) => issue.test(line)
      && !honestGapLineResolved(line)
      && !honestGapHeadingResolved(line, lines.slice(index + 1).find((candidate: string) => candidate.length > 0)))
    .slice(0, 12);
}

function honestGapHeadingResolved(line: any, nextLine: any) {
  const heading = String(line || '').replace(/^#{1,6}\s*/, '').replace(/\s*[:：]\s*$/, '').trim();
  if (!/^(?:remaining|unresolved)\s+(?:gaps?|issues?)$|^(?:남은|미해결)\s*(?:문제|항목|갭|gap)$/i.test(heading)) return false;
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

export function shouldLoopBackAfterHonestMode(state: any = {}) {
  if (!state?.mission_id || state.implementation_allowed === false) return false;
  const route = String(state.route || state.mode || '').toLowerCase();
  // C6 light paths + wiki (memory pack) skip Honest Mode loopback churn (T1).
  if (isLightCompletionRoute(route) || route === 'wiki') return false;
  const attempts = Number(state.honest_loop_attempt_count || 0);
  if (Number.isFinite(attempts) && attempts >= MAX_HONEST_LOOPBACK_ATTEMPTS) return false;
  return Boolean(state.ambiguity_gate_passed || state.clarification_passed || /CONTRACT_SEALED|HONEST_LOOPBACK/i.test(String(state.phase || '')));
}

export function honestModeLoopbackBudgetExhausted(state: any = {}) {
  if (!state?.mission_id || state.implementation_allowed === false) return false;
  const attempts = Number(state.honest_loop_attempt_count || 0);
  return Number.isFinite(attempts) && attempts >= MAX_HONEST_LOOPBACK_ATTEMPTS;
}

export async function recordHonestModeLoopback(root: any, state: any = {}, lastMessage: any = '', sessionKey: any = null) {
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

export async function resolveHonestModeLoopback(root: any, state: any = {}, sessionKey: any = null) {
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

export async function recordHonestModeTerminalUnverified(root: any, state: any = {}, lastMessage: any = '', sessionKey: any = null) {
  const id = state.mission_id;
  const dir = missionDir(root, id);
  const mode = String(state.mode || state.route || 'SKS').toUpperCase();
  const createdAt = nowIso();
  const attempts = Math.max(MAX_HONEST_LOOPBACK_ATTEMPTS, Number(state.honest_loop_attempt_count || 0));
  const artifact = {
    schema_version: 1,
    mission_id: id,
    status: 'unverified',
    terminal: true,
    stop_reason: 'honest_mode_retry_budget_exhausted',
    created_at: createdAt,
    attempts,
    max_attempts: MAX_HONEST_LOOPBACK_ATTEMPTS,
    issue_lines: honestModeGapLines(lastMessage),
    completion_claim_allowed: false
  };
  const file = path.join(dir, 'honest-loopback-terminal.json');
  await writeJsonAtomic(file, artifact);
  await appendJsonl(path.join(dir, 'events.jsonl'), {
    ts: createdAt,
    type: 'pipeline.honest_mode.terminal_unverified',
    proof_invalidating: true,
    attempts,
    issues: artifact.issue_lines
  });
  await setCurrent(root, {
    phase: `${mode}_HONEST_UNVERIFIED`,
    honest_loop_required: false,
    honest_loop_terminal_unverified: true,
    honest_loop_stop_reason: artifact.stop_reason,
    questions_allowed: true
  }, { sessionKey: sessionKey || state._session_key });
  return { ...artifact, file, relative_file: path.relative(root, file).split(path.sep).join('/') };
}
