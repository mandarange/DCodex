// First import: hook evaluation consults the managed skill availability guard
// under $HOME/.agents/skills — isolate the home, then seed the managed skills
// so the guard reflects a healthy install instead of the operator's real one.
import '../../dist/core/__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { reconcileSkills } = await import('../../dist/core/init/skills.js');
await reconcileSkills({ targetDir: path.join(os.homedir(), '.agents', 'skills'), scope: 'global', fix: true });

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-hook-active-route-'));
  await fs.mkdir(path.join(root, '.sneakoscope', 'state'), { recursive: true });
  return root;
}

async function withEnv(env, fn) {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function missionEntries(root) {
  try {
    return await fs.readdir(path.join(root, '.sneakoscope', 'missions'));
  } catch {
    return [];
  }
}

const ACTIVE_NARUTO_STATE = {
  mission_id: 'M-active',
  route: 'Naruto',
  route_command: '$Naruto',
  mode: 'NARUTO',
  phase: 'NARUTO_DELEGATION_CONTEXT_READY',
  subagents_required: true,
  native_sessions_required: false,
  requested_subagents: 2
};

test('substantive prompt during an active Naruto state prepares a fresh parallel route', async () => {
  await withEnv({ SKS_DISABLE_UPDATE_CHECK: '1' }, async () => {
    const root = await makeRoot();
    const { evaluateHookPayload } = await import('../../dist/core/hooks-runtime.js');
    const result = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      conversation_id: 'active-route-fresh-parallel',
      prompt: '새 훅 병렬 처리 구조를 분석하고 코드 수정해줘'
    }, { root, state: ACTIVE_NARUTO_STATE });

    const context = String(result.additionalContext || '');
    assert.match(context, /\$Naruto route prepared|Route: \$Naruto/);
    assert.match(context, /Codex subagent workflow: required for this explicit Naruto or parallel task/);
    assert.doesNotMatch(context, /Active Naruto mission M-active/);

    const missions = await missionEntries(root);
    assert.equal(missions.length, 1);
    const current = JSON.parse(await fs.readFile(path.join(root, '.sneakoscope', 'state', 'current.json'), 'utf8'));
    assert.equal(current.mode, 'NARUTO');
    assert.notEqual(current.mission_id, 'M-active');
  });
});

test('plain continuation prompt keeps the active route context instead of spawning a new route', async () => {
  await withEnv({ SKS_DISABLE_UPDATE_CHECK: '1' }, async () => {
    const root = await makeRoot();
    const { evaluateHookPayload } = await import('../../dist/core/hooks-runtime.js');
    const result = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      conversation_id: 'active-route-continuation',
      prompt: 'keep going'
    }, { root, state: ACTIVE_NARUTO_STATE });

    const context = String(result.additionalContext || '');
    assert.match(context, /Active Naruto mission M-active/);
    assert.doesNotMatch(context, /\$Naruto route prepared/);
    assert.deepEqual(await missionEntries(root), []);
  });
});

test('simple commit and push request is lightweight git work, not a parallel Naruto route', async () => {
  const { routePrompt, routeRequiresSubagents } = await import('../../dist/core/routes.js');
  const prompt = '커밋하고 푸쉬해줘';
  const route = routePrompt(prompt);
  assert.equal(route.id, 'CommitAndPush');
  assert.equal(routeRequiresSubagents(route, prompt), false);
});

test('subagent-start hook references the single core engineering directive', async () => {
  const root = await makeRoot();
  const { evaluateHookPayload } = await import('../../dist/core/hooks-runtime.js');
  const result = await evaluateHookPayload('subagent-start', { cwd: root }, { root, state: {} });
  const context = String(result.additionalContext || '');
  assert.equal(context.match(/Core Engineering Directive/g)?.length, 1);
  assert.match(context, /from AGENTS\.md exactly/);
  assert.doesNotMatch(context, /low-value test matrices|unreachable or speculative conditions/);
});

test('natural language commit and push bypasses hook pipeline preparation', async () => {
  await withEnv({ SKS_DISABLE_UPDATE_CHECK: '1' }, async () => {
    const root = await makeRoot();
    const { evaluateHookPayload } = await import('../../dist/core/hooks-runtime.js');
    const result = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      conversation_id: 'active-route-git-bypass',
      prompt: '배포하게 커밋하고 푸쉬해줘'
    }, { root, state: ACTIVE_NARUTO_STATE });

    assert.match(String(result.systemMessage || ''), /git action bypassed pipeline route gates/);
    assert.equal(result.additionalContext, undefined);
    assert.deepEqual(await missionEntries(root), []);

    const stop = await evaluateHookPayload('stop', {
      cwd: root,
      conversation_id: 'active-route-git-bypass',
      last_assistant_message: 'Commit and push complete.'
    }, { root, state: ACTIVE_NARUTO_STATE });
    assert.notEqual(stop.decision, 'block');
    assert.match(String(stop.systemMessage || ''), /accepted without route finalization/);
  });
});

test('Stop accepts an explicitly closed persisted route without reopening stale gates', async () => {
  const root = await makeRoot();
  const sessionId = 'closed-route-stop';
  const missionId = 'M-closed-route-stop';
  const missionDir = path.join(root, '.sneakoscope', 'missions', missionId);
  await fs.mkdir(missionDir, { recursive: true });
  await fs.writeFile(path.join(missionDir, 'naruto-gate.json'), JSON.stringify({
    schema: 'sks.naruto-gate.v1',
    passed: false,
    blockers: ['naruto_run_not_started']
  }));

  const { evaluateHookPayload } = await import('../../dist/core/hooks-runtime.js');
  const { setCurrent, closeRouteState } = await import('../../dist/core/mission.js');
  await setCurrent(root, {
    mission_id: missionId,
    route: 'Naruto',
    route_command: '$Naruto',
    mode: 'NARUTO',
    phase: 'NARUTO_READY',
    stop_gate: 'naruto-gate.json',
    implementation_allowed: true,
    agents_required: true,
    subagents_required: true,
    reflection_required: true,
    proof_required: true
  }, { sessionKey: sessionId });
  await closeRouteState(root, { missionId });

  const result = await evaluateHookPayload('stop', {
    cwd: root,
    session_id: sessionId,
    last_assistant_message: 'Route closed without claiming completion.'
  }, { root });

  assert.equal(result.continue, true);
  assert.equal(result.action, 'route_closed');
  await assert.rejects(fs.access(path.join(missionDir, 'compliance-loop-guard.json')));
});

test('Stop ignores an untrusted payload state that claims an active route is closed', async () => {
  const root = await makeRoot();
  const sessionId = 'active-route-stop-spoof';
  const missionId = 'M-active-route-stop-spoof';
  await fs.mkdir(path.join(root, '.sneakoscope', 'missions', missionId), { recursive: true });

  const { evaluateHookPayload } = await import('../../dist/core/hooks-runtime.js');
  const { setCurrent } = await import('../../dist/core/mission.js');
  await setCurrent(root, {
    mission_id: missionId,
    route: 'Naruto',
    route_command: '$Naruto',
    mode: 'NARUTO',
    phase: 'NARUTO_READY',
    stop_gate: 'naruto-gate.json',
    implementation_allowed: true,
    agents_required: true,
    subagents_required: true,
    reflection_required: true,
    proof_required: true,
    route_closed: false
  }, { sessionKey: sessionId });

  const result = await evaluateHookPayload('stop', {
    cwd: root,
    session_id: sessionId,
    state: { route_closed: true },
    last_assistant_message: 'Done.'
  }, { root });

  assert.equal(result.decision, 'block');
  assert.match(String(result.reason || ''), /requires official Codex subagent evidence/);
  assert.notEqual(result.action, 'route_closed');
});
