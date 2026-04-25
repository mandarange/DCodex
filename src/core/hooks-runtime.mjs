import path from 'node:path';
import { projectRoot, readJson, appendJsonl, readStdin, nowIso, exists } from './fsx.mjs';
import { containsUserQuestion, looksInteractiveCommand, noQuestionContinuationReason, interactiveCommandReason } from './no-question-guard.mjs';
import { stateFile, missionDir } from './mission.mjs';
import { checkDbOperation, dbBlockReason } from './db-safety.mjs';

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

function extractCommand(payload) {
  return payload.command || payload.tool_input?.command || payload.input?.command || payload.tool?.input?.command || '';
}

function dollarCommand(prompt) {
  const match = String(prompt || '').trim().match(/^\$([A-Za-z][A-Za-z0-9_-]*)(?:\s|:|$)/);
  return match ? match[1].toUpperCase() : null;
}

function looksLikeFastDesignFix(prompt) {
  const text = String(prompt || '');
  const designCue = /(글자|텍스트|문구|내용|색|컬러|폰트|간격|여백|정렬|버튼|라벨|영어|한국어|번역|copy|text|color|font|spacing|padding|margin|align|label|button|translate)/i.test(text);
  const changeCue = /(바꿔|변경|수정|교체|고쳐|영어로|한국어로|change|replace|update|make|turn|translate|fix)/i.test(text);
  return designCue && changeCue;
}

function promptPipelineContext(prompt) {
  const command = dollarCommand(prompt);
  const fastDesign = command === 'DF' || looksLikeFastDesignFix(prompt);
  const route = command ? `$${command}` : (fastDesign ? '$DF inferred' : 'default');
  const dfLine = fastDesign
    ? '\nFast design fix: treat this as $DF. Do the smallest relevant edit, avoid Ralph/research loops, avoid broad redesign, and run only cheap verification when useful.'
    : '';
  return `SKS prompt pipeline active. Route: ${route}. Optimize the user request before acting: extract intent, target files/surfaces, constraints, acceptance criteria, and the smallest safe execution path. Use explicit $ commands when present: $DF fast design/content edit, $Ralph clarification-gated mission, $Research discovery run, $DB database safety, $GX visual context, $SKS general SKS help. Without a command, infer the lightest matching route and avoid heavy loops unless the task requires them.${dfLine}`;
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
  if (!noQuestion) return { continue: true, additionalContext: promptPipelineContext(extractUserPrompt(payload)) };
  const id = state.mission_id;
  if (id) await appendJsonl(path.join(missionDir(root, id), 'user_queue.jsonl'), { ts: nowIso(), payload });
  return {
    decision: 'block',
    reason: 'SKS no-question/no-interruption mode is active. User prompt has been queued until the run completes.'
  };
}

async function hookPreTool(root, state, payload, noQuestion) {
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
  if (!noQuestion) return { continue: true };
  const failed = payload.exit_code && payload.exit_code !== 0;
  if (failed) {
    return {
      additionalContext: 'SKS no-question mode is active. Do not ask the user about this tool failure. Apply the active plan fallback ladder, create a fix task, and continue.'
    };
  }
  return { continue: true };
}

async function hookPermission(root, state, payload, noQuestion) {
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
  if (!noQuestion) return { continue: true };
  const id = state.mission_id;
  const last = extractLastMessage(payload);
  if (containsUserQuestion(last)) return { decision: 'block', reason: noQuestionContinuationReason() };
  if (id) {
    for (const gateName of ['done-gate.json', 'research-gate.json']) {
      const gatePath = path.join(missionDir(root, id), gateName);
      if (await exists(gatePath)) {
        const gate = await readJson(gatePath, {});
        if (gate.passed === true) return { continue: true };
      }
    }
  }
  return {
    decision: 'block',
    reason: 'SKS no-question run is not done. Continue autonomously, fix failing checks, update the active gate file, and do not ask the user.'
  };
}

export async function emitHook(name) {
  const result = await hookMain(name);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
