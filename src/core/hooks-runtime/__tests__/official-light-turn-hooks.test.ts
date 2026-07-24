import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { evaluateHookPayload, evaluateHookPayloadOnce } from '../../hooks-runtime.js';
import { lightTurnReceiptPath } from '../light-turn.js';
import { toolOutputQuarantinePath } from '../tool-output-quarantine.js';
import { prepareRoute } from '../../pipeline.js';
import { createMission, loadStateForSession, missionDir, setCurrent, stateFileForSession } from '../../mission.js';
import { sha256, writeJsonAtomic } from '../../fsx.js';
import {
  HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME,
  createHostCapabilityHookPendingRuntime,
  inspectHostCapabilityRuntime,
  requestHostCapabilities
} from '../../agent-bridge/host-capability-runtime.js';
import { prepareOfficialSubagentMission } from '../../subagents/official-subagent-preparation.js';
import { installGlobalSkills } from '../../init/skills.js';

const priorFixtureHome = process.env.HOME;
const priorFixtureCodexHome = process.env.CODEX_HOME;
const priorFixtureGlobalRoot = process.env.SKS_GLOBAL_ROOT;
const fixtureSkillHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-runtime-skill-home-'));
process.env.HOME = fixtureSkillHome;
process.env.CODEX_HOME = path.join(fixtureSkillHome, '.codex');
process.env.SKS_GLOBAL_ROOT = path.join(fixtureSkillHome, '.sneakoscope-global');
const fixtureSkillInstall = await installGlobalSkills(fixtureSkillHome);
assert.equal(fixtureSkillInstall.ok, true);
test.after(async () => {
  restoreEnv('HOME', priorFixtureHome);
  restoreEnv('CODEX_HOME', priorFixtureCodexHome);
  restoreEnv('SKS_GLOBAL_ROOT', priorFixtureGlobalRoot);
  await fsp.rm(fixtureSkillHome, { recursive: true, force: true });
});

async function tempRoot(prefix: string) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function officialSubagentHookPayload(event: 'SubagentStart' | 'SubagentStop', agentId: string, lastAssistantMessage: string | null = null) {
  const base = {
    agent_id: agentId,
    agent_type: 'worker',
    cwd: '/tmp/project',
    hook_event_name: event,
    model: 'gpt-5.6-luna',
    permission_mode: 'default',
    session_id: 'official-parent',
    transcript_path: null,
    turn_id: 'turn-official-parent'
  };
  return event === 'SubagentStop'
    ? {
        ...base,
        agent_transcript_path: null,
        last_assistant_message: lastAssistantMessage,
        stop_hook_active: false
      }
    : base;
}

function structuredParentSummary(threadIds: string[]) {
  return JSON.stringify({
    schema: 'sks.subagent-parent-summary.v1',
    status: 'completed',
    summary: 'Integrated every requested slice.',
    thread_outcomes: threadIds.map((threadId) => ({
      thread_id: threadId,
      status: 'completed',
      summary: `${threadId} completed`
    })),
    changed_files: [],
    verification: ['affected checks passed'],
    blockers: []
  });
}

test('greeting fast path creates only a transient receipt and consumes it before stale route gates', async () => {
  const root = await tempRoot('sks-light-greeting-');
  const session = 'light-session';
  const staleState = {
    mission_id: 'M-stale',
    mode: 'NARUTO',
    route: 'Naruto',
    route_command: '$Naruto',
    stop_gate: 'naruto-gate.json',
    subagents_required: true
  };
  try {
    const submitted: any = await evaluateHookPayloadOnce('user-prompt-submit', {
      conversation_id: session,
      turn_id: 'light-turn-1',
      prompt: '안녕하세요'
    }, { root, state: staleState });
    assert.equal(submitted.continue, true);
    assert.equal(submitted.sksTaskProfile, 'passthrough');
    assert.equal(submitted.silent, true);
    assert.equal(submitted.additionalContext, undefined);
    await fsp.access(lightTurnReceiptPath(root, session));
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'state', 'hook-invocation-dedupe')));
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'missions')));

    const stopped: any = await evaluateHookPayload('stop', {
      conversation_id: session,
      turn_id: 'light-turn-1',
      last_assistant_message: '안녕하세요!'
    }, { root, state: staleState });
    assert.equal(stopped.continue, true);
    assert.equal(stopped.action, 'light_turn');
    assert.equal(stopped.silent, true);
    await assert.rejects(fsp.access(lightTurnReceiptPath(root, session)));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('greeting fast path does not emit a session-id fallback warning artifact', async () => {
  const root = await tempRoot('sks-light-no-session-warning-');
  try {
    const submitted: any = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      turn_id: 'turn-no-session-warning',
      prompt: 'hi'
    }, { root, state: {} });
    assert.equal(submitted.sksTaskProfile, 'passthrough');
    const stopped: any = await evaluateHookPayload('stop', {
      cwd: root,
      turn_id: 'turn-no-session-warning',
      last_assistant_message: 'Hello!'
    }, { root, state: {} });
    assert.equal(stopped.continue, true);
    assert.equal(stopped.action, 'light_turn');
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'state', 'session-id-fallback-warning.jsonl')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('pending MAD-SKS table deletion confirmation is handled before generic continuation', async () => {
  const root = await tempRoot('sks-mad-confirmation-continuation-');
  const session = 'mad-confirmation-session';
  const missionId = 'M-mad-confirmation';
  const state: any = {
    mission_id: missionId,
    mode: 'MAD-SKS',
    route: 'MAD-SKS',
    route_command: '$MAD-SKS',
    route_closed: false,
    _session_key: session
  };
  const dir = missionDir(root, missionId);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'mad-sks-table-delete-confirmation.json'), JSON.stringify({
      schema: 'sks.mad-sks-table-delete-confirmation.v1',
      status: 'pending',
      operation: 'drop_table',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30_000).toISOString()
    }));
    await setCurrent(root, state, { sessionKey: session, replace: true });

    const submitted: any = await evaluateHookPayload('user-prompt-submit', {
      conversation_id: session,
      turn_id: 'turn-mad-confirmation',
      prompt: '계속'
    }, { root, state });
    assert.equal(submitted.continue, true);
    assert.match(submitted.additionalContext, /confirmation accepted/i);
    const receipt = JSON.parse(await fsp.readFile(path.join(dir, 'mad-sks-table-delete-confirmation.json'), 'utf8'));
    assert.equal(receipt.status, 'accepted');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('standalone parent launch attaches its child hook session to the owning mission without duplication', async () => {
  const root = await tempRoot('sks-parent-launch-attach-');
  const outerSession = 'standalone-outer';
  const oldLaunch = process.env.SKS_NARUTO_PARENT_LAUNCH;
  const oldMission = process.env.SKS_NARUTO_PARENT_MISSION_ID;
  try {
    await prepareRoute(root, '$Naruto --agents 2 audit two packages', {}, {
      sessionKey: outerSession,
      parentModel: 'gpt-5.6-sol'
    });
    const outerState: any = await loadStateForSession(root, outerSession);
    const before = (await fsp.readdir(path.join(root, '.sneakoscope', 'missions'))).sort();
    process.env.SKS_NARUTO_PARENT_LAUNCH = '1';
    process.env.SKS_NARUTO_PARENT_MISSION_ID = outerState.mission_id;

    const result: any = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      session_id: 'standalone-child-thread',
      turn_id: 'standalone-child-turn',
      prompt: 'Use a Codex subagent workflow for two independent slices and wait for both.'
    }, { root });
    const after = (await fsp.readdir(path.join(root, '.sneakoscope', 'missions'))).sort();
    const childState: any = await loadStateForSession(root, 'standalone-child-thread');

    assert.deepEqual(after, before);
    assert.equal(result.attached_parent_mission_id, outerState.mission_id);
    assert.equal(childState.mission_id, outerState.mission_id);
    assert.match(String(result.additionalContext || ''), new RegExp(outerState.mission_id));
  } finally {
    restoreEnv('SKS_NARUTO_PARENT_LAUNCH', oldLaunch);
    restoreEnv('SKS_NARUTO_PARENT_MISSION_ID', oldMission);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('standalone trusted host launch consumes its nonce, blocks replay, and admits a fresh same-mission run', async () => {
  const root = await tempRoot('sks-parent-host-binding-');
  const outerSession = 'standalone-host-outer';
  const childSession = 'standalone-host-child';
  const oldLaunch = process.env.SKS_NARUTO_PARENT_LAUNCH;
  const oldMission = process.env.SKS_NARUTO_PARENT_MISSION_ID;
  const oldRun = process.env.SKS_NARUTO_PARENT_WORKFLOW_RUN_ID;
  const oldNonce = process.env.SKS_NARUTO_PARENT_HOST_CAPABILITY_NONCE;
  try {
    await prepareRoute(root, '$Naruto Create and deliver an Excel workbook.', {}, {
      sessionKey: outerSession,
      parentModel: 'gpt-5.6-sol'
    });
    const outerState: any = await loadStateForSession(root, outerSession);
    const dir = missionDir(root, outerState.mission_id);
    const plan = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'));
    const tools = [
      'spreadsheet_create',
      'spreadsheet_inspect',
      'spreadsheet_update',
      'datasource_query_readonly',
      'slack_send'
    ];
    const runtime = await inspectHostCapabilityRuntime({
      root,
      request: requestHostCapabilities(plan.goal),
      projectTrusted: true,
      dependencies: {
        inventory: async () => ({
          schema: 'sks.mcp-inventory.v2',
          ok: true,
          scope: 'project',
          source: 'fixture_inventory',
          servers: [{ name: 'acas-tools', enabled: true, enabled_tools: tools, disabled_tools: [] }],
          server_count: 1,
          enabled_count: 1,
          failed_count: 0,
          blockers: [],
          warnings: []
        }) as any,
        health: async () => ({
          schema: 'sks.mcp-health.v1',
          ok: true,
          name: 'acas-tools',
          scope: 'project',
          transport: 'stdio',
          status: 'healthy',
          tool_names: tools,
          latency_ms: 1,
          blockers: [],
          warnings: []
        }) as any
      }
    });
    assert.equal(runtime.ok, true);
    const nonce = 'standalone-host-nonce';
    await writeJsonAtomic(
      path.join(dir, HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME),
      createHostCapabilityHookPendingRuntime({
        missionId: outerState.mission_id,
        workflowRunId: plan.workflow_run_id,
        launchNonce: nonce,
        runtime
      })
    );
    const pending = JSON.parse(await fsp.readFile(
      path.join(dir, HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME),
      'utf8'
    ));
    assert.equal(pending.launch_nonce, undefined);
    assert.equal(pending.launch_nonce_sha256, `sha256:${sha256(nonce)}`);
    process.env.SKS_NARUTO_PARENT_LAUNCH = '1';
    process.env.SKS_NARUTO_PARENT_MISSION_ID = outerState.mission_id;
    process.env.SKS_NARUTO_PARENT_WORKFLOW_RUN_ID = plan.workflow_run_id;
    process.env.SKS_NARUTO_PARENT_HOST_CAPABILITY_NONCE = nonce;

    const submitted: any = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      session_id: childSession,
      turn_id: 'standalone-host-turn',
      prompt: 'Create the workbook with the prepared host capability.'
    }, { root });
    assert.equal(submitted.continue, true);
    const childState: any = await loadStateForSession(root, childSession);
    assert.equal(childState.mission_id, outerState.mission_id);
    assert.equal(childState.official_subagent_run_id, plan.workflow_run_id);
    assert.equal(childState.session_scope, childSession);
    await assert.rejects(fsp.access(path.join(dir, HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME)));

    const allowed: any = await evaluateHookPayload('pre-tool', {
      cwd: root,
      session_id: childSession,
      turn_id: 'standalone-host-tool-allowed',
      tool_name: 'mcp__acas-tools__spreadsheet_create',
      tool_use_id: 'spreadsheet-create-1',
      tool_input: { path: 'reports/result.xlsx' }
    }, { root });
    assert.equal(allowed.continue, true);

    const denied: any = await evaluateHookPayload('pre-tool', {
      cwd: root,
      session_id: childSession,
      turn_id: 'standalone-host-tool-denied',
      tool_name: 'mcp__acas-tools__slack_send',
      tool_use_id: 'slack-send-1',
      tool_input: { channel: 'C123' }
    }, { root });
    assert.equal(denied.decision, 'block');
    assert.match(String(denied.reason || ''), /explicitly denied/i);

    const secondSession: any = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      session_id: 'standalone-host-second-child',
      turn_id: 'standalone-host-second-turn',
      prompt: 'Try to reuse the prepared host capability.'
    }, { root });
    assert.equal(secondSession.decision, 'block');
    assert.match(String(secondSession.reason || ''), /scope_mismatch/);

    const freshRunId = 'run-standalone-host-fresh';
    await prepareOfficialSubagentMission({
      root,
      dir,
      missionId: outerState.mission_id,
      goal: plan.goal,
      route: '$Naruto',
      sessionScope: outerSession,
      requestedSubagents: 1,
      requestedSubagentsExplicit: true,
      maxThreads: 1,
      workflowRunId: freshRunId,
      mode: 'naruto',
      preparationOnly: true
    });
    await assert.rejects(fsp.access(path.join(dir, 'host-capability-runtime.json')));
    const freshNonce = 'standalone-host-fresh-nonce';
    await writeJsonAtomic(
      path.join(dir, HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME),
      createHostCapabilityHookPendingRuntime({
        missionId: outerState.mission_id,
        workflowRunId: freshRunId,
        launchNonce: freshNonce,
        runtime
      })
    );
    process.env.SKS_NARUTO_PARENT_WORKFLOW_RUN_ID = freshRunId;
    process.env.SKS_NARUTO_PARENT_HOST_CAPABILITY_NONCE = freshNonce;
    const freshSession: any = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      session_id: 'standalone-host-fresh-child',
      turn_id: 'standalone-host-fresh-turn',
      prompt: 'Claim the fresh same-mission host capability.'
    }, { root });
    assert.equal(freshSession.continue, true);
    const freshState: any = await loadStateForSession(root, 'standalone-host-fresh-child');
    assert.equal(freshState.official_subagent_run_id, freshRunId);
    await assert.rejects(fsp.access(path.join(dir, HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME)));
  } finally {
    restoreEnv('SKS_NARUTO_PARENT_LAUNCH', oldLaunch);
    restoreEnv('SKS_NARUTO_PARENT_MISSION_ID', oldMission);
    restoreEnv('SKS_NARUTO_PARENT_WORKFLOW_RUN_ID', oldRun);
    restoreEnv('SKS_NARUTO_PARENT_HOST_CAPABILITY_NONCE', oldNonce);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a later non-light prompt invalidates an older light receipt before Stop', async () => {
  const root = await tempRoot('sks-light-stale-receipt-');
  const session = 'stale-light-session';
  try {
    await evaluateHookPayload('user-prompt-submit', {
      conversation_id: session,
      turn_id: 'turn-light',
      prompt: 'hi'
    }, { root, state: {} });
    await fsp.access(lightTurnReceiptPath(root, session));

    await evaluateHookPayload('user-prompt-submit', {
      conversation_id: session,
      turn_id: 'turn-db',
      prompt: 'DB migration 적용해줘'
    }, { root, state: {} });
    await assert.rejects(fsp.access(lightTurnReceiptPath(root, session)));

    const state: any = await loadStateForSession(root, session);
    const stopped: any = await evaluateHookPayload('stop', {
      conversation_id: session,
      turn_id: 'turn-db',
      last_assistant_message: 'DB work is not complete.'
    }, { root, state });
    assert.equal(stopped.action, undefined);
    assert.equal(stopped.decision, 'block');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('active continuation prompts trust persisted state and tolerate terminal punctuation', async () => {
  const root = await tempRoot('sks-active-continuation-');
  const session = 'active-continuation-session';
  const state = {
    mission_id: 'M-active-continuation',
    mode: 'NARUTO',
    route: 'Naruto',
    route_command: '$Naruto',
    stop_gate: 'naruto-gate.json',
    route_closed: false
  };
  try {
    await fsp.mkdir(missionDir(root, state.mission_id), { recursive: true });
    await setCurrent(root, state, { sessionKey: session });
    for (const prompt of [
      'keep going',
      'please continue',
      '계속 진행해줘',
      '이어서 해줘',
      'please continue.',
      '계속 진행해줘!',
      '이어서 해줘.',
      'keep going…'
    ]) {
      const submitted: any = await evaluateHookPayload('user-prompt-submit', {
        conversation_id: session,
        turn_id: `turn-continue-${prompt}`,
        prompt,
        state: {}
      }, { root });
      assert.equal(submitted.sksTaskProfile, undefined);
      assert.match(String(submitted.additionalContext || ''), /Active Naruto mission/i);
      assert.match(String(submitted.additionalContext || ''), /subagent-parent-summary\.json/i);
      assert.doesNotMatch(String(submitted.additionalContext || ''), /write the integrated parent result to naruto-summary\.json/i);
      assert.doesNotMatch(String(submitted.additionalContext || ''), /answer-only pipeline active/i);
      await assert.rejects(fsp.access(lightTurnReceiptPath(root, session)));
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('missing custom tool output quarantines every later prompt in the same thread and permits a fresh thread', async () => {
  const root = await tempRoot('sks-interrupted-tool-output-');
  const session = 'interrupted-tool-output-session';
  const state = {
    mission_id: 'M-interrupted-tool-output',
    mode: 'NARUTO',
    route: 'Naruto',
    route_command: '$Naruto',
    route_closed: false
  };
  try {
    await fsp.mkdir(missionDir(root, state.mission_id), { recursive: true });
    const submitted: any = await evaluateHookPayload('user-prompt-submit', {
      conversation_id: session,
      turn_id: 'turn-interrupted-tool-output',
      prompt: '[No tool output found for custom tool call call_interrupted_1.] 계속해줘'
    }, { root, state });
    assert.equal(submitted.decision, 'block');
    assert.equal(submitted.continue, undefined);
    assert.match(String(submitted.reason || ''), /call_interrupted_1/);
    assert.match(String(submitted.reason || ''), /M-interrupted-tool-output/);
    assert.match(String(submitted.reason || ''), /fresh Codex thread/i);
    assert.match(String(submitted.reason || ''), /1\.21\.0-beta\.3/);
    assert.doesNotMatch(String(submitted.reason || ''), /infer success/i);
    await assert.rejects(fsp.access(lightTurnReceiptPath(root, session)));

    const quarantine = JSON.parse(await fsp.readFile(toolOutputQuarantinePath(root, session), 'utf8'));
    assert.equal(quarantine.active, true);
    assert.equal(quarantine.call_id, 'call_interrupted_1');

    const later: any = await evaluateHookPayload('user-prompt-submit', {
      conversation_id: session,
      turn_id: 'turn-after-interrupted-output',
      prompt: '계속해줘'
    }, { root, state });
    assert.equal(later.decision, 'block');
    assert.match(String(later.reason || ''), /call_interrupted_1/);

    const fresh: any = await evaluateHookPayload('user-prompt-submit', {
      conversation_id: 'fresh-thread-after-interrupted-output',
      turn_id: 'turn-fresh-after-interrupted-output',
      prompt: '계속해줘'
    }, { root, state });
    assert.equal(fresh.continue, true);
    assert.match(String(fresh.additionalContext || ''), /Active Naruto mission/i);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('missing custom tool output in prior assistant and raw error fields quarantines a continuation prompt', async () => {
  const root = await tempRoot('sks-interrupted-tool-output-prior-fields-');
  const state = {
    mission_id: 'M-interrupted-tool-output-prior-fields',
    mode: 'NARUTO',
    route: 'Naruto',
    route_command: '$Naruto',
    route_closed: false
  };
  try {
    await fsp.mkdir(missionDir(root, state.mission_id), { recursive: true });
    const priorAssistantSession = 'interrupted-prior-assistant-session';
    const priorAssistant: any = await evaluateHookPayload('user-prompt-submit', {
      conversation_id: priorAssistantSession,
      turn_id: 'turn-prior-assistant-error',
      prompt: '계속해줘',
      last_assistant_message: '[No tool output found for custom tool call call_lost_review.]'
    }, { root, state });
    assert.equal(priorAssistant.decision, 'block');
    assert.match(String(priorAssistant.reason || ''), /call_lost_review/);
    const priorAssistantQuarantine = JSON.parse(await fsp.readFile(toolOutputQuarantinePath(root, priorAssistantSession), 'utf8'));
    assert.equal(priorAssistantQuarantine.call_id, 'call_lost_review');

    const rawErrorSession = 'interrupted-raw-error-session';
    const rawError: any = await evaluateHookPayload('user-prompt-submit', {
      conversation_id: rawErrorSession,
      turn_id: 'turn-raw-error',
      prompt: 'keep going',
      raw_error: {
        response: {
          error: '[No tool output found for custom tool call call_lost_raw_error.]'
        }
      }
    }, { root, state });
    assert.equal(rawError.decision, 'block');
    assert.match(String(rawError.reason || ''), /call_lost_raw_error/);
    const rawErrorQuarantine = JSON.parse(await fsp.readFile(toolOutputQuarantinePath(root, rawErrorSession), 'utf8'));
    assert.equal(rawErrorQuarantine.call_id, 'call_lost_raw_error');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('plain answer fast path avoids mission, TriWiki, route digest, and code-pack preparation', async () => {
  const root = await tempRoot('sks-light-answer-');
  const session = 'answer-session';
  try {
    const submitted: any = await evaluateHookPayload('user-prompt-submit', {
      conversation_id: session,
      prompt: '이 함수가 왜 이렇게 동작해?'
    }, { root, state: {} });
    assert.equal(submitted.continue, true);
    assert.equal(submitted.sksTaskProfile, 'answer');
    assert.match(submitted.additionalContext, /answer-only pipeline active \(light turn\)/i);
    assert.doesNotMatch(submitted.additionalContext, /\$Team route prepared|Pipeline plan:|Mission:/i);
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'missions')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('light classifier never bypasses no-question mode', async () => {
  const root = await tempRoot('sks-light-no-question-');
  const session = 'no-question-session';
  const missionId = 'M-no-question';
  const state = {
    mission_id: missionId,
    mode: 'RESEARCH',
    phase: 'RESEARCH_RUNNING_NO_QUESTIONS'
  };
  try {
    await fsp.mkdir(missionDir(root, missionId), { recursive: true });
    const submitted: any = await evaluateHookPayload('user-prompt-submit', {
      conversation_id: session,
      prompt: 'hello'
    }, { root, state });
    assert.equal(submitted.decision, 'block');
    assert.match(submitted.reason, /no-question/i);
    await assert.rejects(fsp.access(lightTurnReceiptPath(root, session)));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('SubagentStart uses configured official max_threads and SubagentStop is evidence-only', async () => {
  const root = await tempRoot('sks-official-hook-events-');
  const missionId = 'M-official-events';
  const workflowRunId = 'run-official-events';
  const state = { mission_id: missionId, mode: 'NARUTO', route: 'Naruto', stop_gate: 'naruto-gate.json', official_subagent_run_id: workflowRunId };
  try {
    await fsp.mkdir(path.join(root, '.codex'), { recursive: true });
    await fsp.writeFile(path.join(root, '.codex', 'config.toml'), '[agents]\nmax_threads = 9\nmax_depth = 1\n');
    await fsp.mkdir(missionDir(root, missionId), { recursive: true });
    await fsp.writeFile(path.join(missionDir(root, missionId), 'subagent-plan.json'), JSON.stringify({
      schema: 'sks.subagent-plan.v1',
      workflow: 'official_codex_subagent',
      mission_id: missionId,
      workflow_run_id: workflowRunId,
      requested_subagents: 1
    }));
    const started: any = await evaluateHookPayload('subagent-start', officialSubagentHookPayload('SubagentStart', 'agent-a1'), { root, state });
    assert.match(started.additionalContext, /max_threads frame budget is 9/i);
    assert.doesNotMatch(started.additionalContext, /at most 4/i);
    assert.match(started.additionalContext, /execute only the slice assigned by the parent/i);
    assert.doesNotMatch(started.additionalContext, /wait for all requested agent threads/i);
    assert.doesNotMatch(started.additionalContext, /delegate independent slices/i);
    assert.doesNotMatch(started.additionalContext, /return the exact sks\.subagent-parent-summary\.v1/i);
    const startedEvidence = JSON.parse(await fsp.readFile(path.join(missionDir(root, missionId), 'subagent-evidence.json'), 'utf8'));
    assert.equal(startedEvidence.started_threads, 1);
    assert.deepEqual(startedEvidence.event_sources, ['SubagentStart']);

    const stopped: any = await evaluateHookPayload('subagent-stop', officialSubagentHookPayload('SubagentStop', 'agent-a1', 'Bounded slice result.'), { root, state });
    assert.equal(stopped.continue, true);
    assert.equal(stopped.decision, undefined);
    assert.equal(stopped.silent, true);
    const events = await fsp.readFile(path.join(missionDir(root, missionId), 'subagent-events.jsonl'), 'utf8');
    assert.match(events, /SubagentStart/);
    assert.match(events, /SubagentStop/);
    const stoppedEvidence = JSON.parse(await fsp.readFile(path.join(missionDir(root, missionId), 'subagent-evidence.json'), 'utf8'));
    assert.equal(stoppedEvidence.started_threads, 1);
    assert.deepEqual(stoppedEvidence.event_sources, ['SubagentStart', 'SubagentStop']);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('an explicit foreign hook session never inherits the active legacy global mission', async () => {
  const root = await tempRoot('sks-official-hook-session-isolation-');
  const parentSession = 'official-parent-session';
  const foreignSession = 'unrelated-parent-session';
  try {
    await prepareRoute(root, '$Naruto --agents 1 inspect one bounded slice', {}, {
      sessionKey: parentSession,
      parentModel: 'gpt-5.6-sol'
    });
    const parentState: any = await loadStateForSession(root, parentSession);
    const dir = missionDir(root, parentState.mission_id);
    const eventsPath = path.join(dir, 'subagent-events.jsonl');
    const before = await fsp.readFile(eventsPath, 'utf8');

    const result: any = await evaluateHookPayload('subagent-start', {
      ...officialSubagentHookPayload('SubagentStart', 'foreign-agent'),
      session_id: foreignSession,
      turn_id: 'foreign-turn'
    }, { root });

    assert.doesNotMatch(String(result.additionalContext || ''), new RegExp(parentState.mission_id));
    assert.equal(await fsp.readFile(eventsPath, 'utf8'), before);
    await assert.rejects(fsp.access(stateFileForSession(root, foreignSession)));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Naruto hooks accumulate later root waves under one workflow run and clear the rescan state', async () => {
  const root = await tempRoot('sks-official-multi-wave-');
  const session = 'official-multi-wave-parent';
  try {
    await fsp.mkdir(path.join(root, '.codex'), { recursive: true });
    await fsp.writeFile(path.join(root, '.codex', 'config.toml'), '[agents]\nmax_threads = 4\nmax_depth = 1\n');
    await prepareRoute(root, '$Naruto --agents 4 implement four independent checks', {}, {
      sessionKey: session,
      parentModel: 'gpt-5.6-sol'
    });
    const state: any = await loadStateForSession(root, session);
    const dir = missionDir(root, state.mission_id);
    const initialPlan = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'));
    assert.equal(initialPlan.first_wave, 3);
    assert.equal(initialPlan.wave_count, 2);

    for (const threadId of ['wave-1-a', 'wave-1-b']) {
      await evaluateHookPayload('subagent-start', officialSubagentHookPayload('SubagentStart', threadId), { root, state });
    }
    for (const threadId of ['wave-1-a', 'wave-1-b']) {
      await evaluateHookPayload('subagent-stop', officialSubagentHookPayload('SubagentStop', threadId, `${threadId} complete.`), { root, state });
    }
    const afterWaveOne = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'));
    assert.equal(afterWaveOne.wave_lifecycle.workflow_run_id, initialPlan.workflow_run_id);
    assert.equal(afterWaveOne.wave_lifecycle.current_wave, 1);
    assert.equal(afterWaveOne.wave_lifecycle.completed_waves, 1);
    assert.equal(afterWaveOne.wave_lifecycle.open_threads, 0);
    assert.equal(afterWaveOne.wave_lifecycle.recovered_capacity, 2);
    assert.equal(afterWaveOne.wave_lifecycle.remaining_to_start, 2);
    assert.equal(afterWaveOne.wave_lifecycle.post_wave_rescan_required, true);

    for (const threadId of ['wave-2-a', 'wave-2-b']) {
      await evaluateHookPayload('subagent-start', officialSubagentHookPayload('SubagentStart', threadId), { root, state });
    }
    for (const threadId of ['wave-2-a', 'wave-2-b']) {
      await evaluateHookPayload('subagent-stop', officialSubagentHookPayload('SubagentStop', threadId, `${threadId} complete.`), { root, state });
    }
    const finalPlan = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'));
    const events = (await fsp.readFile(path.join(dir, 'subagent-events.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.equal(finalPlan.wave_lifecycle.workflow_run_id, initialPlan.workflow_run_id);
    assert.equal(finalPlan.wave_lifecycle.max_depth, 1);
    assert.equal(finalPlan.wave_lifecycle.current_wave, 2);
    assert.equal(finalPlan.wave_lifecycle.completed_waves, 2);
    assert.equal(finalPlan.wave_lifecycle.cumulative_started, 4);
    assert.equal(finalPlan.wave_lifecycle.open_threads, 0);
    assert.equal(finalPlan.wave_lifecycle.remaining_to_start, 0);
    assert.equal(finalPlan.wave_lifecycle.post_wave_rescan_required, false);
    assert.equal(events.length, 8);
    assert.ok(events.every((row) => row.run_id === initialPlan.workflow_run_id));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('reused pipeline Naruto missions rebuild request intake from the current prompt and TriWiki context', async () => {
  const root = await tempRoot('sks-official-reused-intake-');
  const session = 'official-reused-intake-parent';
  try {
    const prior: any = await createMission(root, {
      mode: 'naruto',
      prompt: 'old request',
      sessionKey: session
    });
    await fsp.writeFile(path.join(prior.dir, 'request-intake.json'), JSON.stringify({
      schema: 'sks.request-intake.v1',
      original_prompt: 'old request',
      prompt_hash: 'stale'
    }));
    await fsp.mkdir(path.join(root, '.sneakoscope', 'wiki'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), JSON.stringify({
      claims: [{ id: 'Q2-current', claim: 'Use current code and official Codex subagent semantics.' }],
      attention: { mode: 'bounded', use_first: [['Q2-current']], hydrate_first: [] }
    }));

    const prepared: any = await prepareRoute(root, '$Naruto --agents 2 implement the current request', {}, {
      sessionKey: session,
      parentModel: 'gpt-5.6-sol'
    });
    const intake = JSON.parse(await fsp.readFile(path.join(prior.dir, 'request-intake.json'), 'utf8'));

    assert.equal(prepared.mission_id, prior.id);
    assert.match(intake.original_prompt, /implement the current request/);
    assert.notEqual(intake.prompt_hash, 'stale');
    assert.equal(intake.wiki_context_used.source, '.sneakoscope/wiki/context-pack.json');
    assert.deepEqual(intake.wiki_context_used.use_first_ids, ['Q2-current']);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('official events plus parent summary pass Naruto without legacy process artifacts', async () => {
  const root = await tempRoot('sks-official-naruto-stop-');
  const session = 'official-parent';
  try {
    const prepared: any = await prepareRoute(root, '$Naruto --agents 2 implement two independent checks', {}, {
      sessionKey: session,
      parentModel: 'gpt-5.6-sol'
    });
    assert.match(prepared.additionalContext, /requested subagents: 2/i);
    let state: any = await loadStateForSession(root, session);
    assert.equal(state.native_sessions_required, false);
    assert.equal(state.subagents_required, true);
    const preparedDir = missionDir(root, state.mission_id);
    await fsp.writeFile(path.join(preparedDir, 'work-order-ledger.json'), JSON.stringify({
      schema_version: 1,
      mission_id: state.mission_id,
      route: 'Naruto',
      source_inventory_complete: true,
      all_customer_requests_preserved: true,
      all_customer_requests_mapped: true,
      all_work_items_verified: false,
      items: [{ id: 'REQ-1', status: 'pending', implementation_tasks: [], implementation_evidence: [], verification_evidence: [] }]
    }));
    const sanityFile = path.join(preparedDir, 'engineering-sanity-review.json');
    const sanity = JSON.parse(await fsp.readFile(sanityFile, 'utf8'));
    sanity.passed = true;
    sanity.added_hunks_reviewed = true;
    sanity.real_callers_traced = true;
    sanity.reviewed_candidate_ids = sanity.candidate_findings.map((finding: any) => finding.id);
    sanity.candidate_dispositions = sanity.candidate_findings.map((finding: any) => ({
      candidate_id: finding.id,
      status: 'resolved',
      reason: 'reviewed added hunks and real callers in mission scope',
      evidence: ['reviewed added hunks and real callers in mission scope'],
      source_scope: finding.source_scope,
      added_hunk_line_ranges: finding.added_hunk_line_ranges
    }));
    for (const checkId of Object.keys(sanity.checks)) {
      sanity.checks[checkId] = {
        status: 'passed',
        reason: null,
        evidence: ['reviewed added hunks and real callers in mission scope']
      };
    }
    await fsp.writeFile(sanityFile, JSON.stringify(sanity));

    for (const threadId of ['agent-a1', 'agent-a2']) {
      await evaluateHookPayload('subagent-start', officialSubagentHookPayload('SubagentStart', threadId), { root, state });
      await evaluateHookPayload('subagent-stop', officialSubagentHookPayload('SubagentStop', threadId, `${threadId} bounded result.`), { root, state });
    }

    const decision: any = await evaluateHookPayload('stop', {
      conversation_id: session,
      last_assistant_message: structuredParentSummary(['agent-a1', 'agent-a2'])
    }, { root, state });
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /reflection/i);

    state = await loadStateForSession(root, session);
    const dir = missionDir(root, state.mission_id);
    const plan = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'));
    const evidence = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-evidence.json'), 'utf8'));
    const eventRows = (await fsp.readFile(path.join(dir, 'subagent-events.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const persistedParentSummary = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-parent-summary.json'), 'utf8'));
    const summary = JSON.parse(await fsp.readFile(path.join(dir, 'naruto-summary.json'), 'utf8'));
    const gate = JSON.parse(await fsp.readFile(path.join(dir, 'naruto-gate.json'), 'utf8'));
    const proof = JSON.parse(await fsp.readFile(path.join(dir, 'completion-proof.json'), 'utf8'));
    assert.equal(evidence.ok, true);
    assert.equal(evidence.started_threads, 2);
    assert.equal(evidence.completed_threads, 2);
    assert.equal(evidence.parent_summary_trustworthy, true);
    assert.equal(evidence.run_id, plan.workflow_run_id);
    assert.ok(eventRows.every((row) => row.run_id === plan.workflow_run_id));
    assert.equal(persistedParentSummary.run_id, plan.workflow_run_id);
    assert.equal(summary.schema, 'sks.naruto-subagent-workflow.v1');
    assert.equal(summary.completion_evidence, true);
    assert.equal(summary.parent_summary_present, true);
    assert.equal(gate.passed, true);
    assert.equal(gate.ssot_guard, true);
    assert.equal(gate.subagent_evidence_ready, true);
    assert.equal(gate.requested_subagents, 2);
    assert.equal(gate.started_subagents, 2);
    assert.equal(gate.completed_subagents, 2);
    assert.equal(gate.failed_subagents, 0);
    assert.deepEqual(gate.event_sources, ['SubagentStart', 'SubagentStop']);
    assert.equal(gate.evidence.official_subagent_evidence, 'subagent-evidence.json');
    assert.equal(gate.evidence.parent_summary, 'subagent-parent-summary.json');
    assert.equal(gate.evidence.ssot_guard, 'ssot-guard.json');
    assert.equal(proof.evidence.route_gate.workflow_run_id, plan.workflow_run_id);
    assert.equal(state.reflection_invalidation_required, true);
    const terminalEvents = await fsp.readFile(path.join(dir, 'subagent-events.jsonl'), 'utf8');
    await evaluateHookPayload('subagent-stop', officialSubagentHookPayload('SubagentStop', 'agent-late', 'Unrelated later result.'), { root, state });
    assert.equal(await fsp.readFile(path.join(dir, 'subagent-events.jsonl'), 'utf8'), terminalEvents);
    const terminalEvidence = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-evidence.json'), 'utf8'));
    assert.equal(terminalEvidence.ok, true);
    assert.deepEqual(terminalEvidence.unmatched_stop_thread_ids, []);
    const ledger = JSON.parse(await fsp.readFile(path.join(dir, 'work-order-ledger.json'), 'utf8'));
    assert.equal(ledger.items[0].status, 'verified');
    await assert.rejects(fsp.access(path.join(dir, 'agents', 'naruto-work-graph.json')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('generic parallel route materializes and refreshes official evidence without Naruto artifacts', async () => {
  const root = await tempRoot('sks-generic-subagent-overlay-');
  const session = 'generic-db-parent';
  try {
    const prepared: any = await prepareRoute(root, '$DB --agents 2 audit all schemas in parallel', {}, {
      sessionKey: session,
      parentModel: 'gpt-5.6-sol'
    });
    const state: any = await loadStateForSession(root, session);
    const dir = missionDir(root, state.mission_id);
    assert.equal(state.mode, 'DB');
    assert.equal(state.subagents_required, true);
    assert.match(prepared.additionalContext, /generic overlay does not create naruto-summary\.json/i);
    await fsp.access(path.join(dir, 'subagent-plan.json'));
    await fsp.access(path.join(dir, 'subagent-events.jsonl'));
    await fsp.access(path.join(dir, 'subagent-evidence.json'));
    await fsp.writeFile(path.join(dir, 'work-order-ledger.json'), JSON.stringify({
      schema_version: 1,
      mission_id: state.mission_id,
      route: 'DB',
      source_inventory_complete: true,
      all_customer_requests_preserved: true,
      all_customer_requests_mapped: true,
      all_work_items_verified: false,
      items: [{ id: 'REQ-DB-1', status: 'pending', implementation_tasks: [], implementation_evidence: [], verification_evidence: [] }]
    }));
    await assert.rejects(fsp.access(path.join(dir, 'naruto-summary.json')));
    await assert.rejects(fsp.access(path.join(dir, 'naruto-gate.json')));

    for (const threadId of ['db-a1', 'db-a2']) {
      await evaluateHookPayload('subagent-start', officialSubagentHookPayload('SubagentStart', threadId), { root, state });
      await evaluateHookPayload('subagent-stop', officialSubagentHookPayload('SubagentStop', threadId, `${threadId} read-only result.`), { root, state });
    }
    const decision: any = await evaluateHookPayload('stop', {
      conversation_id: session,
      turn_id: 'turn-official-parent',
      last_assistant_message: structuredParentSummary(['db-a1', 'db-a2'])
    }, { root, state });
    assert.equal(decision.decision, 'block');
    const evidence = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-evidence.json'), 'utf8'));
    assert.equal(evidence.ok, true);
    assert.equal(evidence.completed_threads, 2);
    await evaluateHookPayload('stop', {
      conversation_id: session,
      turn_id: 'turn-official-parent-retry',
      last_assistant_message: 'Completion Summary: all slices remain integrated. Honest Mode: evidence is recorded; reflection remains pending.'
    }, { root, state });
    const evidenceAfterRetry = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-evidence.json'), 'utf8'));
    assert.equal(evidenceAfterRetry.ok, true);
    assert.equal(evidenceAfterRetry.parent_summary_trustworthy, true);
    const ledger = JSON.parse(await fsp.readFile(path.join(dir, 'work-order-ledger.json'), 'utf8'));
    assert.equal(ledger.items[0].status, 'pending');
    await assert.rejects(fsp.access(path.join(dir, 'naruto-summary.json')));
    await assert.rejects(fsp.access(path.join(dir, 'naruto-gate.json')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('generic official evidence preserves config blockers and never marks invalid TOML verified', async () => {
  const root = await tempRoot('sks-generic-subagent-invalid-config-');
  const session = 'generic-invalid-config-parent';
  try {
    await fsp.mkdir(path.join(root, '.codex'), { recursive: true });
    await fsp.writeFile(path.join(root, '.codex', 'config.toml'), '[agents\nmax_threads = 12\n');
    await prepareRoute(root, '$DB --agents 1 audit the schema in parallel', {}, {
      sessionKey: session,
      parentModel: 'gpt-5.6-sol'
    });
    let state: any = await loadStateForSession(root, session);
    const dir = missionDir(root, state.mission_id);
    const plan = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'));
    assert.ok(plan.config_blockers.includes('project_official_subagent_config_toml_parse_failed'));

    await evaluateHookPayload('subagent-start', officialSubagentHookPayload('SubagentStart', 'db-invalid-a1'), { root, state });
    await evaluateHookPayload('subagent-stop', officialSubagentHookPayload('SubagentStop', 'db-invalid-a1', 'Read-only review completed.'), { root, state });
    await evaluateHookPayload('stop', {
      conversation_id: session,
      turn_id: 'turn-generic-invalid-config',
      last_assistant_message: structuredParentSummary(['db-invalid-a1'])
    }, { root, state });

    const evidence = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-evidence.json'), 'utf8'));
    assert.equal(evidence.completed_threads, 1);
    assert.equal(evidence.ok, false);
    assert.ok(evidence.blockers.includes('official_subagent_config:project_official_subagent_config_toml_parse_failed'));
    state = await loadStateForSession(root, session);
    assert.equal(state.subagents_verified, false);
    await assert.rejects(fsp.access(path.join(dir, 'naruto-summary.json')));
    await assert.rejects(fsp.access(path.join(dir, 'naruto-gate.json')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('known non-Sol App parent is recorded as advisory mismatch without hard-blocking the gate', async () => {
  const root = await tempRoot('sks-official-parent-mismatch-');
  const session = 'mismatch-parent';
  try {
    await prepareRoute(root, '$Naruto --agents 2 audit two packages', {}, {
      sessionKey: session,
      parentModel: 'gpt-5.6-luna'
    });
    const state: any = await loadStateForSession(root, session);
    const gate = JSON.parse(await fsp.readFile(path.join(missionDir(root, state.mission_id), 'naruto-gate.json'), 'utf8'));
    assert.equal(gate.parent_model_match, false);
    assert.equal(gate.blockers.includes('parent_model_mismatch:gpt-5.6-luna'), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('automatic bounded work materializes the bounded Naruto workflow', async () => {
  const root = await tempRoot('sks-bounded-naruto-');
  const session = 'bounded-naruto';
  try {
    await prepareRoute(root, '로그인 버그 수정해줘', {}, { sessionKey: session });
    const state: any = await loadStateForSession(root, session);
    assert.equal(state.route, 'Naruto');
    assert.equal(state.subagents_required, true);
    const dir = missionDir(root, state.mission_id);
    await fsp.access(path.join(dir, 'pipeline-plan.json'));
    const plan = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'));
    assert.ok(plan.requested_subagents >= 4);
    assert.ok(plan.requested_subagents <= 12);
    assert.equal(plan.requested_subagents_explicit, false);
    await fsp.access(path.join(dir, 'naruto-gate.json'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
