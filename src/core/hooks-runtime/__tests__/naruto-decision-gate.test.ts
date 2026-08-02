import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CODEX_HOOK_EVENTS } from '../../codex-compat/codex-hook-events.js';
import { evaluateHookPayload } from '../../hooks-runtime.js';
import { normalizeHookResult } from '../hook-io.js';
import { runOfficialSubagentWorkflow } from '../../subagents/official-subagent-runner.js';
import { sha256 } from '../../fsx.js';
import {
  HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME,
  HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME,
  HOST_CAPABILITY_HOOK_RUNTIME_FILENAME,
  createHostCapabilityHookRuntimeBinding,
  createHostCapabilityEventCollector,
  inspectHostCapabilityRuntime,
  requestHostCapabilities,
  sanitizeHostCapabilityPostToolUse
} from '../../agent-bridge/host-capability-runtime.js';
import {
  decideHookNaruto,
  hookNarutoDecisionLogPath
} from '../naruto-decision-gate.js';
import { installGlobalSkills } from '../../init/skills.js';

const priorFixtureHome = process.env.HOME;
const priorFixtureCodexHome = process.env.CODEX_HOME;
const priorFixtureGlobalRoot = process.env.SKS_GLOBAL_ROOT;
const fixtureSkillHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-decision-skill-home-'));
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

const HOOK_NAMES = [
  'pre-tool',
  'permission-request',
  'post-tool',
  'pre-compact',
  'post-compact',
  'session-start',
  'user-prompt-submit',
  'subagent-start',
  'subagent-stop',
  'stop'
] as const;

test('Naruto decision gate bypasses trivial work and keeps bounded execution parent-owned', () => {
  const greeting = decideHookNaruto({ name: 'user-prompt-submit', payload: { prompt: '안녕하세요' }, state: {} });
  assert.equal(greeting.required, false);
  assert.equal(greeting.mode, 'none');
  assert.equal(greeting.action, 'bypass');
  assert.equal(greeting.task_profile, 'passthrough');
  assert.equal(greeting.trivial, true);

  const tiny = decideHookNaruto({ name: 'user-prompt-submit', payload: { prompt: 'README 오타만 고쳐줘' }, state: {} });
  assert.equal(tiny.required, false);
  assert.equal(tiny.route_id, 'DFix');
  assert.equal(tiny.task_profile, 'tiny-change');

  const bounded = decideHookNaruto({ name: 'user-prompt-submit', payload: { prompt: '로그인 파서 버그 수정해줘' }, state: {} });
  assert.equal(bounded.required, false);
  assert.equal(bounded.mode, 'none');
  assert.equal(bounded.action, 'bypass');
  assert.equal(bounded.route_id, 'Naruto');
  assert.equal(bounded.task_profile, 'bounded-work');
  assert.equal(bounded.reason, 'task_profile_bounded_work_parent_owned');

  const routeOwned = decideHookNaruto({ name: 'user-prompt-submit', payload: { prompt: '$QA-LOOP --agents 5 API를 병렬 검수해줘' }, state: {} });
  assert.equal(routeOwned.required, false);
  assert.equal(routeOwned.mode, 'route_owned');
  assert.equal(routeOwned.route_id, 'QALoop');
  assert.equal(routeOwned.reason, 'route_owned_orchestration:QALoop');

  for (const prompt of ['$Research investigate this topic', '$AutoResearch improve this workflow']) {
    const owned = decideHookNaruto({ name: 'user-prompt-submit', payload: { prompt }, state: {} });
    assert.equal(owned.mode, 'route_owned', prompt);
    assert.equal(owned.required, false, prompt);
    assert.equal(owned.action, 'route_owned', prompt);
  }

  const active = decideHookNaruto({
    name: 'pre-tool',
    payload: { tool_name: 'Read' },
    state: { mission_id: 'M-active', route: 'Naruto', mode: 'NARUTO', subagents_required: true }
  });
  assert.equal(active.required, true);
  assert.equal(active.action, 'observe_required');
  assert.equal(active.source, 'active_route');

  const retiredIdentity = decideHookNaruto({
    name: 'pre-tool',
    payload: { tool_name: 'Read' },
    state: { mission_id: 'M-retired-route', route: 'Team', mode: 'TEAM' }
  });
  assert.equal(retiredIdentity.required, false);
  assert.equal(retiredIdentity.action, 'observe_bypass');
  assert.equal(retiredIdentity.route_id, null);

  const activeOwned = decideHookNaruto({
    name: 'post-tool',
    payload: { tool_name: 'Read' },
    state: { mission_id: 'M-research', route: 'Research', route_command: '$Research', mode: 'RESEARCH' }
  });
  assert.equal(activeOwned.mode, 'route_owned');
  assert.equal(activeOwned.required, false);
  assert.equal(activeOwned.action, 'route_owned');
});

test('all ten Codex hook events pass through and record the common Naruto decision gate', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-naruto-gate-'));
  const base = { cwd: root, session_id: 'all-hook-gate-events', turn_id: 'turn-all-hook-gate-events' };
  try {
    for (const name of HOOK_NAMES) {
      const payload: any = { ...base };
      if (name === 'user-prompt-submit') payload.prompt = '안녕하세요';
      if (name === 'pre-tool' || name === 'post-tool' || name === 'permission-request') payload.tool_name = 'Read';
      if (name === 'stop') payload.last_assistant_message = 'Completion Summary: no work requested.\nHonest Mode: verified no work.';
      if (name === 'subagent-start' || name === 'subagent-stop') {
        payload.agent_id = 'gate-agent';
        payload.agent_type = 'worker';
        payload.hook_event_name = name === 'subagent-start' ? 'SubagentStart' : 'SubagentStop';
      }
      const result: any = await evaluateHookPayload(name, payload, { root, state: {} });
      assert.equal(result.sksNarutoDecision?.recorded, true, name);
      assert.ok(['none', 'generic_naruto', 'route_owned'].includes(result.sksNarutoDecision?.mode), name);
      assert.equal(typeof result.sksNarutoDecision?.required, 'boolean', name);
    }

    const rows = (await fsp.readFile(hookNarutoDecisionLogPath(root), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, CODEX_HOOK_EVENTS.length);
    assert.deepEqual(new Set(rows.map((row) => row.event)), new Set(CODEX_HOOK_EVENTS));
    assert.ok(rows.every((row) => row.prompt === undefined));
    assert.ok(rows.every((row) => typeof row.session_hash === 'string'));

    const normalized: any = normalizeHookResult('user-prompt-submit', {
      continue: true,
      sksNarutoDecision: rows.find((row) => row.event === 'UserPromptSubmit')
    });
    assert.equal(normalized.sksNarutoDecision, undefined);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('App preparation blocks a missing requested host capability before returning delegation context', async () => {
  const result = await runOfficialSubagentWorkflow({
    root: process.cwd(),
    goal: 'Create and deliver an Excel workbook.',
    prompt: 'sealed delegation prompt',
    requestedSubagents: 1,
    maxThreads: 1,
    appSession: true,
    sessionKey: 'host-capability-preparation-session',
    projectTrusted: true,
    hostCapabilityDependencies: hostCapabilityDependencies(['spreadsheet_create'])
  });

  assert.equal(result.status, 'host_capability_blocked');
  assert.equal(result.prepared, false);
  assert.equal(result.additionalContext, null);
  assert.ok(result.blockers.includes('host_capability_missing:host.spreadsheet.workbook.v1'));
});

test('host capability hooks enforce the exact allowlist and persist only bounded sanitized current-session evidence', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-host-capability-'));
  const missionId = 'M-20260719-host-capability-hooks';
  const workflowRunId = 'naruto-host-capability-hooks-run';
  const sessionId = 'host-capability-hooks-session';
  const dir = path.join(root, '.sneakoscope', 'missions', missionId);
  const goal = 'Create and deliver an Excel workbook.';
  const state = {
    mission_id: missionId,
    official_subagent_run_id: workflowRunId,
    session_scope: sessionId,
    mode: 'NARUTO',
    route: 'Naruto',
    subagents_required: true,
    prompt: goal
  };
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'subagent-plan.json'), `${JSON.stringify({ goal }, null, 2)}\n`);
    const runtime = await inspectHostCapabilityRuntime({
      root,
      request: requestHostCapabilities(goal),
      projectTrusted: true,
      dependencies: hostCapabilityDependencies([
        'spreadsheet_create',
        'spreadsheet_inspect',
        'spreadsheet_update',
        'slack_send',
        'center_outbox_post'
      ])
    });
    assert.equal(runtime.ok, true);
    await fsp.writeFile(
      path.join(dir, HOST_CAPABILITY_HOOK_RUNTIME_FILENAME),
      `${JSON.stringify(createHostCapabilityHookRuntimeBinding({
        missionId,
        workflowRunId,
        sessionScope: sessionId,
        runtime
      }), null, 2)}\n`
    );

    const allowed: any = await evaluateHookPayload('pre-tool', {
      session_id: sessionId,
      turn_id: 'turn-host-allowed',
      tool_name: 'mcp__acas-tools__spreadsheet_create',
      tool_input: { path: 'reports/monthly.xlsx', api_token: 'must-not-persist' },
      tool_use_id: 'tool-use-create'
    }, { root, state });
    assert.equal(allowed.decision, undefined);

    const clarificationBlocked: any = await evaluateHookPayload('pre-tool', {
      session_id: sessionId,
      turn_id: 'turn-host-clarification-locked',
      tool_name: 'Read',
      tool_input: { path: 'README.md' },
      tool_use_id: 'tool-use-clarification-locked'
    }, {
      root,
      state: {
        ...state,
        phase: 'CLARIFICATION_AWAITING_ANSWERS',
        stop_gate: 'clarification-gate',
        ambiguity_gate_required: true,
        ambiguity_gate_passed: false,
        clarification_required: true,
        implementation_allowed: false
      }
    });
    assert.equal(clarificationBlocked.decision, 'block');
    assert.match(clarificationBlocked.reason, /ambiguity gate is paused and waiting for explicit user answers/);

    const harnessBlocked: any = await evaluateHookPayload('pre-tool', {
      session_id: sessionId,
      turn_id: 'turn-host-harness-blocked',
      tool_name: 'Write',
      type: 'file_write',
      tool_input: { path: '.codex/config.toml' },
      tool_use_id: 'tool-use-harness-blocked'
    }, { root, state });
    assert.equal(harnessBlocked.decision, 'block');
    assert.match(harnessBlocked.reason, /harness guard blocked this tool call/);

    const denied: any = await evaluateHookPayload('pre-tool', {
      session_id: sessionId,
      turn_id: 'turn-host-denied',
      tool_name: 'mcp__acas-tools__slack_send',
      tool_input: { channel: 'secret-channel', token: 'must-not-persist' },
      tool_use_id: 'tool-use-slack'
    }, { root, state });
    assert.equal(denied.decision, 'block');
    assert.match(denied.reason, /explicitly denied for model execution/);

    const unrelated: any = await evaluateHookPayload('pre-tool', {
      session_id: sessionId,
      turn_id: 'turn-host-unrelated',
      tool_name: 'Read',
      tool_input: { path: 'README.md' },
      tool_use_id: 'tool-use-read'
    }, { root, state });
    assert.equal(unrelated.decision, undefined);

    const artifact = {
      path: 'reports/monthly.xlsx',
      kind: 'spreadsheet',
      media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sha256: `sha256:${'a'.repeat(64)}`,
      bytes: 48211,
      role: 'deliverable'
    };
    const createPayload = {
      session_id: sessionId,
      turn_id: 'turn-host-create-post',
      tool_name: 'mcp__acas-tools__spreadsheet_create',
      tool_input: { path: artifact.path, credential: 'raw-input-secret-must-not-persist' },
      tool_response: {
        structured_content: {
          artifact,
          rows: Array.from({ length: 500 }, (_, index) => ({ index, value: `raw-row-${index}` })),
          access_token: 'raw-response-secret-must-not-persist'
        }
      },
      tool_use_id: 'tool-use-create'
    };
    await evaluateHookPayload('post-tool', createPayload, { root, state });
    const tamperedObservationsPath = path.join(dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME);
    const tamperedObservations = JSON.parse(await fsp.readFile(tamperedObservationsPath, 'utf8'));
    tamperedObservations.raw_secret = 'tampered-secret-must-not-persist';
    await fsp.writeFile(tamperedObservationsPath, `${JSON.stringify(tamperedObservations, null, 2)}\n`);
    await evaluateHookPayload('pre-tool', {
      session_id: sessionId,
      turn_id: 'turn-host-inspect-pre',
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: artifact.path },
      tool_use_id: 'tool-use-inspect'
    }, { root, state });
    await evaluateHookPayload('post-tool', {
      session_id: sessionId,
      turn_id: 'turn-host-inspect-post',
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: artifact.path },
      tool_response: {
        structured_content: {
          ok: true,
          path: artifact.path,
          sheet_names: ['Summary'],
          row_counts: { Summary: 12 },
          formulas: ['=SUM(B2:B11)'],
          error_cells: [],
          raw_formula_values: ['must-not-persist']
        }
      },
      tool_use_id: 'tool-use-inspect'
    }, { root, state });
    const updateArtifact = {
      ...artifact,
      sha256: `sha256:${'b'.repeat(64)}`,
      bytes: artifact.bytes + 128
    };
    const updateAllowed: any = await evaluateHookPayload('pre-tool', {
      session_id: sessionId,
      turn_id: 'turn-host-update-pre',
      tool_name: 'mcp__acas-tools__spreadsheet_update',
      tool_input: { path: artifact.path, patch: { sheet: 'Summary', range: 'B2:B3' } },
      tool_use_id: 'tool-use-update'
    }, { root, state });
    assert.equal(updateAllowed.decision, undefined);
    await evaluateHookPayload('post-tool', {
      session_id: sessionId,
      turn_id: 'turn-host-update-post',
      tool_name: 'mcp__acas-tools__spreadsheet_update',
      tool_input: { path: artifact.path, patch: { sheet: 'Summary', range: 'B2:B3' } },
      tool_response: { structured_content: { ok: true, path: artifact.path, artifact: updateArtifact } },
      tool_use_id: 'tool-use-update'
    }, { root, state });
    const finalInspectAllowed: any = await evaluateHookPayload('pre-tool', {
      session_id: sessionId,
      turn_id: 'turn-host-final-inspect-pre',
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: artifact.path },
      tool_use_id: 'tool-use-final-inspect'
    }, { root, state });
    assert.equal(finalInspectAllowed.decision, undefined);
    await evaluateHookPayload('post-tool', {
      session_id: sessionId,
      turn_id: 'turn-host-final-inspect-post',
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: artifact.path },
      tool_response: {
        structured_content: {
          ok: true,
          path: artifact.path,
          sheet_names: ['Summary'],
          row_counts: { Summary: 12 },
          formulas: ['=SUM(B2:B11)'],
          error_cells: []
        }
      },
      tool_use_id: 'tool-use-final-inspect'
    }, { root, state });

    const observationsText = await fsp.readFile(path.join(dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME), 'utf8');
    const observations = JSON.parse(observationsText);
    const evidence = JSON.parse(await fsp.readFile(path.join(dir, HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME), 'utf8'));
    assert.equal(observations.tool_calls.length, 4);
    assert.deepEqual(observations.tool_calls.map((row: any) => row.tool), [
      'spreadsheet_create',
      'spreadsheet_inspect',
      'spreadsheet_update',
      'spreadsheet_inspect'
    ]);
    assert.ok(observations.pre_tool_uses.some((row: any) => row.tool === 'spreadsheet_create' && row.decision === 'allowed'));
    assert.equal(observations.pre_tool_uses.some((row: any) => row.tool === 'slack_send'), false);
    assert.equal(observationsText.includes('must-not-persist'), false);
    assert.equal(observationsText.includes('tampered-secret'), false);
    assert.equal(observationsText.includes('raw-row-'), false);
    assert.equal(observationsText.includes('raw_formula_values'), false);
    assert.ok(Buffer.byteLength(observationsText, 'utf8') < 32 * 1024);
    assert.equal(evidence.ok, true);
    assert.deepEqual(evidence.tool_calls.map((row: any) => row.tool), [
      'spreadsheet_create',
      'spreadsheet_inspect',
      'spreadsheet_update',
      'spreadsheet_inspect'
    ]);

    await evaluateHookPayload('post-tool', {
      session_id: sessionId,
      turn_id: 'turn-host-denied-post',
      tool_name: 'mcp__acas-tools__slack_send',
      tool_input: { channel: 'secret-channel', token: 'must-not-persist' },
      tool_response: { structured_content: { ok: true, token: 'must-not-persist' } },
      tool_use_id: 'tool-use-slack'
    }, { root, state });
    const deniedEvidence = JSON.parse(await fsp.readFile(path.join(dir, HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME), 'utf8'));
    assert.equal(deniedEvidence.ok, false);
    assert.ok(deniedEvidence.blockers.includes('host_tool_call_pre_use_missing:slack_send'));
    assert.ok(deniedEvidence.blockers.includes('host_tool_call_not_allowed:slack_send'));
    assert.ok(deniedEvidence.blockers.includes('host_tool_call_explicitly_denied:slack_send'));

    const beforeForeign = await fsp.readFile(path.join(dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME), 'utf8');
    const foreign: any = await evaluateHookPayload('pre-tool', {
      session_id: 'foreign-session',
      turn_id: 'turn-host-foreign',
      tool_name: 'mcp__acas-tools__slack_send',
      tool_input: { token: 'foreign-secret' },
      tool_use_id: 'tool-use-foreign'
    }, { root, state });
    assert.equal(foreign.decision, 'block');
    assert.match(foreign.reason, /explicitly denied for model execution/);

    for (const [label, payload, scopedState] of [
      [
        'foreign session',
        {
          session_id: 'foreign-session',
          turn_id: 'turn-host-foreign-allowed',
          tool_name: 'mcp__acas-tools__spreadsheet_create',
          tool_input: { path: 'reports/foreign.xlsx' },
          tool_use_id: 'tool-use-foreign-allowed'
        },
        state
      ],
      [
        'missing session',
        {
          turn_id: 'turn-host-missing-session',
          tool_name: 'mcp__acas-tools__spreadsheet_create',
          tool_input: { path: 'reports/missing-session.xlsx' },
          tool_use_id: 'tool-use-missing-session'
        },
        state
      ],
      [
        'non-Naruto state',
        {
          session_id: sessionId,
          turn_id: 'turn-host-non-naruto',
          tool_name: 'mcp__acas-tools__spreadsheet_create',
          tool_input: { path: 'reports/non-naruto.xlsx' },
          tool_use_id: 'tool-use-non-naruto'
        },
        { session_scope: sessionId, mode: 'ANSWER', route: 'Answer' }
      ]
    ] as const) {
      const blocked: any = await evaluateHookPayload('pre-tool', payload, { root, state: scopedState });
      assert.equal(blocked.decision, 'block', label);
      assert.match(blocked.reason, /no valid task-scoped Naruto mission, run, and session context/, label);
    }
    assert.equal(await fsp.readFile(path.join(dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME), 'utf8'), beforeForeign);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('host capability hooks normalize canonical Agent-shaped artifact results', async () => {
  const htmlScratch = {
    path: 'reports/agent-brief.html',
    kind: 'html',
    media_type: 'text/html',
    sha256: `sha256:${'a'.repeat(64)}`,
    bytes: 512,
    role: 'scratch'
  };
  const pdfDeliverable = {
    path: 'reports/agent-brief.pdf',
    kind: 'pdf',
    media_type: 'application/pdf',
    sha256: `sha256:${'b'.repeat(64)}`,
    bytes: 2048,
    role: 'deliverable'
  };
  const cases: Array<{
    label: string;
    goal: string;
    toolNames: string[];
    expectedPaths: string[];
    calls: Array<{ tool: string; id: string; input: Record<string, unknown>; response: unknown }>;
  }> = [
    {
      label: 'agent-write-artifact',
      goal: 'Write a file in the workspace.',
      toolNames: ['write_file'],
      expectedPaths: ['reports/agent-note.txt'],
      calls: [{
        tool: 'write_file',
        id: 'agent-write-file',
        input: { path: 'reports/agent-note.txt', content: 'agent artifact fixture' },
        response: contentOnlyAgentHostToolResponse({
          artifact: {
            path: 'reports/agent-note.txt',
            kind: 'text',
            media_type: 'text/plain',
            sha256: `sha256:${'c'.repeat(64)}`,
            bytes: 22,
            role: 'deliverable'
          }
        })
      }]
    },
    {
      label: 'agent-web-capture-artifact',
      goal: 'Capture a URL page screenshot.',
      toolNames: ['capture_url_screenshot'],
      expectedPaths: ['captures/agent-page.png'],
      calls: [{
        tool: 'capture_url_screenshot',
        id: 'agent-capture-url',
        input: { url: 'https://example.test', path: 'captures/agent-page.png' },
        response: contentOnlyAgentHostToolResponse({
          artifact: {
            path: 'captures/agent-page.png',
            kind: 'png',
            media_type: 'image/png',
            sha256: `sha256:${'d'.repeat(64)}`,
            bytes: 4096,
            role: 'deliverable'
          }
        })
      }]
    },
    {
      label: 'agent-pdf-artifacts',
      goal: 'Create and deliver a PDF document.',
      toolNames: ['write_file', 'html_to_pdf'],
      expectedPaths: [htmlScratch.path, pdfDeliverable.path],
      calls: [
        {
          tool: 'write_file',
          id: 'agent-pdf-source',
          input: { path: htmlScratch.path, content: '<html><body>Brief</body></html>' },
          response: contentOnlyAgentHostToolResponse({ ok: true, path: htmlScratch.path, artifact: htmlScratch })
        },
        {
          tool: 'html_to_pdf',
          id: 'agent-html-to-pdf',
          input: { source_path: htmlScratch.path, output_path: pdfDeliverable.path },
          response: contentOnlyAgentHostToolResponse({ artifact: pdfDeliverable })
        }
      ]
    },
    {
      label: 'agent-spreadsheet-artifact',
      goal: 'Create and deliver an Excel workbook.',
      toolNames: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update'],
      expectedPaths: ['reports/agent-workbook.xlsx'],
      calls: [
        {
          tool: 'spreadsheet_create',
          id: 'agent-spreadsheet-create',
          input: { path: 'reports/agent-workbook.xlsx' },
          response: contentOnlyAgentHostToolResponse({
            artifact: {
              path: 'reports/agent-workbook.xlsx',
              kind: 'xlsx',
              media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              sha256: `sha256:${'e'.repeat(64)}`,
              bytes: 8192,
              role: 'deliverable'
            }
          })
        },
        {
          tool: 'spreadsheet_inspect',
          id: 'agent-spreadsheet-inspect',
          input: { path: 'reports/agent-workbook.xlsx' },
          response: contentOnlyAgentHostToolResponse({
            ok: true,
            path: 'reports/agent-workbook.xlsx',
            sheet_names: ['Summary'],
            row_counts: { Summary: 1 },
            formulas: [],
            error_cells: []
          })
        }
      ]
    }
  ];

  for (const fixtureCase of cases) {
    const fixture = await createHostHookFixture({
      label: fixtureCase.label,
      goal: fixtureCase.goal,
      toolNames: fixtureCase.toolNames
    });
    try {
      for (const call of fixtureCase.calls) await recordPassedHostHookCall(fixture, call);
      const observations = JSON.parse(await fsp.readFile(
        path.join(fixture.dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME),
        'utf8'
      ));
      const evidence = JSON.parse(await fsp.readFile(
        path.join(fixture.dir, HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME),
        'utf8'
      ));
      assert.equal(evidence.ok, true, fixtureCase.label);
      assert.deepEqual(
        evidence.artifacts.map((artifact: any) => artifact.path),
        [...fixtureCase.expectedPaths].sort(),
        fixtureCase.label
      );
      assert.equal(
        observations.tool_calls.flatMap((call: any) => call.artifacts).length,
        fixtureCase.expectedPaths.length,
        fixtureCase.label
      );
    } finally {
      await fsp.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('host capability parser accepts Agent response shapes and rejects ambiguous or malformed content', () => {
  const query = 'SELECT customer_id FROM customers WHERE active = ?';
  const schemaResponse = {
    datasource: 'mysql:customers',
    schema_snapshot_id: 'schema-customers-v1'
  };
  const queryResponse = {
    ...schemaResponse,
    query_sha256: `sha256:${sha256(query)}`,
    row_count: 2,
    column_count: 1,
    truncated: false,
    status: 'passed'
  };
  const inspectResponse = {
    ok: true,
    path: 'reports/customers.xlsx',
    sheet_names: ['Customers'],
    row_counts: { Customers: 2 },
    formulas: [],
    error_cells: []
  };
  const observe = (tool: string, input: Record<string, unknown>, response: unknown) => (
    sanitizeHostCapabilityPostToolUse({
      tool_name: `mcp__acas-tools__${tool}`,
      tool_input: input,
      tool_response: response,
      tool_use_id: `shape-${tool}`
    })
  );

  assert.equal(
    observe('datasource_schema_context', { datasource: 'mysql:customers' }, contentOnlyAgentHostToolResponse(schemaResponse))
      ?.semantic_receipt?.kind,
    'datasource_schema'
  );
  assert.equal(
    observe('datasource_query_readonly', {
      datasource: 'mysql:customers',
      schema_snapshot_id: schemaResponse.schema_snapshot_id,
      query
    }, contentOnlyAgentHostToolResponse(queryResponse))?.semantic_receipt?.kind,
    'datasource_query'
  );
  assert.equal(
    observe('spreadsheet_inspect', { path: inspectResponse.path }, contentOnlyAgentHostToolResponse(inspectResponse))
      ?.semantic_receipt?.kind,
    'spreadsheet_inspection'
  );
  assert.equal(
    observe('datasource_schema_context', { datasource: 'mysql:customers' }, structuredAgentHostToolResponse(schemaResponse))
      ?.status,
    'passed'
  );

  const ambiguous = observe(
    'datasource_schema_context',
    { datasource: 'mysql:customers' },
    structuredAgentHostToolResponse(schemaResponse, { ...schemaResponse, schema_snapshot_id: 'different-snapshot' })
  );
  assert.equal(ambiguous?.status, 'failed');
  assert.equal(ambiguous?.validation_blocker, 'host_tool_response_malformed:datasource_schema_context');

  const malformed = observe('datasource_schema_context', { datasource: 'mysql:customers' }, {
    content: [{ type: 'text', text: 'schema lookup completed' }],
    isError: false
  });
  assert.equal(malformed?.status, 'failed');
  assert.equal(malformed?.validation_blocker, 'host_tool_response_malformed:datasource_schema_context');
});

test('host capability collector compacts near-limit responses and recovers after oversized input', async () => {
  const runtime = await inspectHostCapabilityRuntime({
    root: process.cwd(),
    request: requestHostCapabilities('Get active customer records from the database.'),
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(['datasource_schema_context', 'datasource_query_readonly'])
  });
  const query = 'SELECT customer_id FROM customers WHERE active = ?';
  const schemaSnapshotId = 'schema-large-v1';
  const rawMarker = 'raw-synthetic-row-secret-';
  const rawPayload = `${rawMarker}${'x'.repeat(3_800_000)}`;
  const largeResult = {
    structuredContent: {
      datasource: 'mysql:customers',
      schema_snapshot_id: schemaSnapshotId,
      query_sha256: `sha256:${sha256(query)}`,
      row_count: 1,
      column_count: 1,
      truncated: false,
      status: 'passed',
      rows: [{ value: rawPayload }]
    },
    content: [{ type: 'text', text: 'bounded query result' }],
    isError: false
  };
  const observation = sanitizeHostCapabilityPostToolUse({
    tool_name: 'mcp__acas-tools__datasource_query_readonly',
    tool_input: { datasource: 'mysql:customers', schema_snapshot_id: schemaSnapshotId, query },
    tool_response: largeResult,
    tool_use_id: 'large-query-observation'
  });
  const observationText = JSON.stringify(observation);
  assert.equal(observation?.status, 'passed');
  assert.ok(Buffer.byteLength(observationText, 'utf8') < 32 * 1024);
  assert.equal(observationText.includes(rawMarker), false);

  const collector = createHostCapabilityEventCollector(runtime);
  collector.push(`${completedHostToolEvent({
    tool: 'datasource_schema_context',
    arguments: { datasource: 'mysql:customers' },
    result: contentOnlyAgentHostToolResponse({
      datasource: 'mysql:customers',
      schema_snapshot_id: schemaSnapshotId
    })
  })}\n`);
  collector.push(`${completedHostToolEvent({
    tool: 'datasource_query_readonly',
    arguments: { datasource: 'mysql:customers', schema_snapshot_id: schemaSnapshotId, query },
    result: largeResult
  })}\n`);
  collector.push(`${'z'.repeat(5 * 1024 * 1024 + 1)}\n${completedHostToolEvent({
    tool: 'datasource_schema_context',
    arguments: { datasource: 'mysql:customers' },
    result: structuredAgentHostToolResponse({
      datasource: 'mysql:customers',
      schema_snapshot_id: schemaSnapshotId
    })
  })}\n`);
  const evidence = collector.finish();
  const evidenceText = JSON.stringify(evidence);
  assert.equal(evidence.tool_calls.length, 3);
  assert.equal(evidence.tool_calls[1]?.status, 'passed');
  assert.ok(evidence.blockers.includes('host_tool_event_line_too_large'));
  assert.ok(Buffer.byteLength(evidenceText, 'utf8') < 32 * 1024);
  assert.equal(evidenceText.includes(rawMarker), false);
  const evidenceDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-large-host-evidence-'));
  try {
    const evidencePath = path.join(evidenceDir, HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME);
    await fsp.writeFile(evidencePath, evidenceText);
    assert.ok((await fsp.stat(evidencePath)).size < 32 * 1024);
    assert.equal((await fsp.readFile(evidencePath, 'utf8')).includes(rawMarker), false);
  } finally {
    await fsp.rm(evidenceDir, { recursive: true, force: true });
  }

  const bufferCollector = createHostCapabilityEventCollector(runtime);
  bufferCollector.push('b'.repeat(10 * 1024 * 1024 + 1));
  bufferCollector.push(`${completedHostToolEvent({
    tool: 'datasource_schema_context',
    arguments: { datasource: 'mysql:customers' },
    result: contentOnlyAgentHostToolResponse({
      datasource: 'mysql:customers',
      schema_snapshot_id: schemaSnapshotId
    })
  })}\n`);
  const bufferEvidence = bufferCollector.finish();
  assert.ok(bufferEvidence.blockers.includes('host_tool_event_buffer_too_large'));
  assert.equal(bufferEvidence.tool_calls.length, 1);
});

test('document render hooks require a prior same-source HTML write and reject raw html', async () => {
  const fixture = await createHostHookFixture({
    label: 'document-source-binding',
    goal: 'Create and deliver a PDF document.',
    toolNames: ['write_file', 'html_to_pdf']
  });
  const htmlArtifact = {
    path: 'reports/a.html',
    kind: 'html',
    media_type: 'text/html',
    sha256: `sha256:${'1'.repeat(64)}`,
    bytes: 12,
    role: 'scratch'
  };
  try {
    await recordPassedHostHookCall(fixture, {
      tool: 'write_file',
      id: 'document-source-write',
      input: { path: htmlArtifact.path, content: '<html></html>' },
      response: contentOnlyAgentHostToolResponse({
        ok: true,
        path: htmlArtifact.path,
        artifact: htmlArtifact
      })
    });

    const mismatched: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__html_to_pdf',
      tool_input: { source_path: 'reports/b.html', output_path: 'reports/b.pdf' },
      tool_use_id: 'document-render-mismatch'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(mismatched.decision, 'block');
    assert.match(mismatched.reason, /host_capability_document_source_resource_mismatch/);

    const rawHtml: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__html_to_pdf',
      tool_input: {
        source_path: htmlArtifact.path,
        output_path: 'reports/a.pdf',
        html: '<html></html>'
      },
      tool_use_id: 'document-render-raw-html'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(rawHtml.decision, 'block');
    assert.match(rawHtml.reason, /host_capability_document_source_path_required/);

    const matched: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__html_to_pdf',
      tool_input: { source_path: htmlArtifact.path, output_path: 'reports/a.pdf' },
      tool_use_id: 'document-render-matched'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(matched.decision, undefined);
  } finally {
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});

test('host capability hooks reject a valid runtime whose canonical request scope was replaced', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-host-scope-tamper-'));
  const missionId = 'M-20260719-host-scope-tamper';
  const workflowRunId = 'naruto-host-scope-tamper-run';
  const sessionId = 'host-scope-tamper-session';
  const dir = path.join(root, '.sneakoscope', 'missions', missionId);
  const goal = 'Create and deliver an Excel workbook.';
  const state = {
    mission_id: missionId,
    official_subagent_run_id: workflowRunId,
    session_scope: sessionId,
    mode: 'NARUTO',
    route: 'Naruto',
    subagents_required: true,
    prompt: goal
  };
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'subagent-plan.json'), `${JSON.stringify({ goal }, null, 2)}\n`);
    const narrowedRuntime = await inspectHostCapabilityRuntime({
      root,
      request: requestHostCapabilities('Populate quarterly numbers into reports/q3.xlsx.'),
      projectTrusted: true,
      dependencies: hostCapabilityDependencies(['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update'])
    });
    await fsp.writeFile(path.join(dir, HOST_CAPABILITY_HOOK_RUNTIME_FILENAME), `${JSON.stringify(
      createHostCapabilityHookRuntimeBinding({
        missionId,
        workflowRunId,
        sessionScope: sessionId,
        runtime: narrowedRuntime
      }),
      null,
      2
    )}\n`);

    const result: any = await evaluateHookPayload('pre-tool', {
      session_id: sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: 'reports/q3.xlsx' },
      tool_use_id: 'scope-tamper-inspect'
    }, { root, state });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /host_capability_hook_runtime_request_scope_mismatch/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('host capability hook lock atomically reserves exactly one spreadsheet create across concurrent IDs', async () => {
  const fixture = await createHostHookFixture({
    label: 'spreadsheet-create-concurrency',
    goal: 'Create and deliver an Excel workbook.',
    toolNames: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update']
  });
  try {
    const results: any[] = await Promise.all(['create-a', 'create-b'].map((toolUseId) => evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      turn_id: `turn-${toolUseId}`,
      tool_name: 'mcp__acas-tools__spreadsheet_create',
      tool_input: { path: 'reports/concurrent.xlsx' },
      tool_use_id: toolUseId
    }, { root: fixture.root, state: fixture.state })));

    assert.equal(results.filter((result) => result.decision === undefined).length, 1);
    const denied = results.find((result) => result.decision === 'block');
    assert.match(denied?.reason || '', /host_capability_spreadsheet_create_already_reserved/);
    const observations = JSON.parse(await fsp.readFile(
      path.join(fixture.dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME),
      'utf8'
    ));
    assert.equal(observations.pre_tool_uses.filter((row: any) => (
      row.tool === 'spreadsheet_create' && row.decision === 'allowed'
    )).length, 1);
  } finally {
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});

test('host capability hooks allow one completed schema-to-readonly-query sequence', async () => {
  const fixture = await createHostHookFixture({
    label: 'db-valid-sequence',
    goal: 'Get active customer records from the database.',
    toolNames: ['datasource_schema_context', 'datasource_query_readonly']
  });
  const query = 'SELECT customer_id, status FROM customers WHERE active = ?';
  const schemaSnapshotId = 'schema-snapshot-customers-v1';
  try {
    const schemaAllowed: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__datasource_schema_context',
      tool_input: { datasource: 'mysql:customers' },
      tool_use_id: 'valid-schema'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(schemaAllowed.decision, undefined);
    await evaluateHookPayload('post-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__datasource_schema_context',
      tool_input: { datasource: 'mysql:customers' },
      tool_response: {
        structured_content: {
          datasource: 'mysql:customers',
          schema_snapshot_id: schemaSnapshotId
        }
      },
      tool_use_id: 'valid-schema'
    }, { root: fixture.root, state: fixture.state });

    const queryAllowed: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__datasource_query_readonly',
      tool_input: { datasource: 'mysql:customers', schema_snapshot_id: schemaSnapshotId, query, bindings: [true] },
      tool_use_id: 'valid-query'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(queryAllowed.decision, undefined);
    await evaluateHookPayload('post-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__datasource_query_readonly',
      tool_input: { datasource: 'mysql:customers', schema_snapshot_id: schemaSnapshotId, query, bindings: [true] },
      tool_response: {
        structured_content: {
          datasource: 'mysql:customers',
          schema_snapshot_id: schemaSnapshotId,
          query_sha256: `sha256:${sha256(query)}`,
          row_count: 2,
          column_count: 2,
          truncated: false,
          status: 'passed'
        }
      },
      tool_use_id: 'valid-query'
    }, { root: fixture.root, state: fixture.state });

    const observations = JSON.parse(await fsp.readFile(
      path.join(fixture.dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME),
      'utf8'
    ));
    const evidence = JSON.parse(await fsp.readFile(
      path.join(fixture.dir, HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME),
      'utf8'
    ));
    assert.deepEqual(observations.pre_tool_uses.map((row: any) => [row.tool, row.reservation_status]), [
      ['datasource_schema_context', 'completed'],
      ['datasource_query_readonly', 'completed']
    ]);
    assert.equal(evidence.ok, true);
    assert.deepEqual(evidence.blockers, []);
  } finally {
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});

test('host capability final evidence pairs each query with its nearest matching datasource schema', async () => {
  const fixture = await createHostHookFixture({
    label: 'db-multi-datasource',
    goal: 'Get active customer records from the database.',
    toolNames: ['datasource_schema_context', 'datasource_query_readonly']
  });
  const calls = [
    {
      tool: 'datasource_schema_context',
      id: 'schema-customers',
      input: { datasource: 'mysql:customers' },
      response: {
        structured_content: {
          datasource: 'mysql:customers',
          schema_snapshot_id: 'schema-customers-v1'
        }
      }
    },
    {
      tool: 'datasource_query_readonly',
      id: 'query-customers',
      input: {
        datasource: 'mysql:customers',
        schema_snapshot_id: 'schema-customers-v1',
        query: 'SELECT customer_id FROM customers WHERE active = ?',
        bindings: [true]
      },
      response: {
        structured_content: {
          datasource: 'mysql:customers',
          schema_snapshot_id: 'schema-customers-v1',
          query_sha256: `sha256:${sha256('SELECT customer_id FROM customers WHERE active = ?')}`,
          row_count: 2,
          column_count: 1,
          truncated: false,
          status: 'passed'
        }
      }
    },
    {
      tool: 'datasource_schema_context',
      id: 'schema-orders',
      input: { datasource: 'postgres:orders' },
      response: {
        structured_content: {
          datasource: 'postgres:orders',
          schema_snapshot_id: 'schema-orders-v3'
        }
      }
    },
    {
      tool: 'datasource_query_readonly',
      id: 'query-orders',
      input: {
        datasource: 'postgres:orders',
        schema_snapshot_id: 'schema-orders-v3',
        query: 'SELECT order_id FROM orders WHERE status = ?',
        bindings: ['open']
      },
      response: {
        structured_content: {
          datasource: 'postgres:orders',
          schema_snapshot_id: 'schema-orders-v3',
          query_sha256: `sha256:${sha256('SELECT order_id FROM orders WHERE status = ?')}`,
          row_count: 3,
          column_count: 1,
          truncated: false,
          status: 'passed'
        }
      }
    }
  ];
  try {
    for (const call of calls) await recordPassedHostHookCall(fixture, call);
    const evidence = JSON.parse(await fsp.readFile(
      path.join(fixture.dir, HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME),
      'utf8'
    ));
    assert.equal(evidence.ok, true);
    assert.deepEqual(evidence.blockers, []);
    assert.equal(
      evidence.capabilities_used.find((receipt: any) => (
        receipt.id === 'host.datasource.query.readonly.v1'
      ))?.status,
      'passed'
    );
  } finally {
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});

test('host capability final evidence rejects a datasource query bound to another schema snapshot', async () => {
  const runtime = await inspectHostCapabilityRuntime({
    root: process.cwd(),
    request: requestHostCapabilities('Get active customer records from the database.'),
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(['datasource_schema_context', 'datasource_query_readonly'])
  });
  const query = 'SELECT order_id FROM orders WHERE status = ?';
  const collector = createHostCapabilityEventCollector(runtime);
  for (const event of [
    completedDatasourceHostToolEvent({
      tool: 'datasource_schema_context',
      arguments: { datasource: 'mysql:customers' },
      response: {
        datasource: 'mysql:customers',
        schema_snapshot_id: 'schema-a-v1'
      }
    }),
    completedDatasourceHostToolEvent({
      tool: 'datasource_schema_context',
      arguments: { datasource: 'postgres:orders' },
      response: {
        datasource: 'postgres:orders',
        schema_snapshot_id: 'schema-b-v1'
      }
    }),
    completedDatasourceHostToolEvent({
      tool: 'datasource_query_readonly',
      arguments: {
        datasource: 'postgres:orders',
        schema_snapshot_id: 'schema-a-v1',
        query,
        bindings: ['open']
      },
      response: {
        datasource: 'postgres:orders',
        schema_snapshot_id: 'schema-a-v1',
        query_sha256: `sha256:${sha256(query)}`,
        row_count: 1,
        column_count: 1,
        truncated: false,
        status: 'passed'
      }
    })
  ]) {
    collector.push(`${event}\n`);
  }
  const evidence = collector.finish();
  assert.equal(evidence.ok, false);
  assert.ok(evidence.blockers.includes('host_capability_readonly_query_schema_mismatch'));
  assert.equal(evidence.blockers.includes('host_capability_readonly_query_datasource_mismatch'), false);
});

test('host capability hooks still reject a fifth readonly query reservation', async () => {
  const fixture = await createHostHookFixture({
    label: 'db-query-limit',
    goal: 'Get active customer records from the database.',
    toolNames: ['datasource_schema_context', 'datasource_query_readonly']
  });
  const query = 'SELECT customer_id FROM customers WHERE active = ?';
  const schemaSnapshotId = 'schema-customers-limit-v1';
  const queryInput = {
    datasource: 'mysql:customers',
    schema_snapshot_id: schemaSnapshotId,
    query,
    bindings: [true]
  };
  try {
    await recordPassedHostHookCall(fixture, {
      tool: 'datasource_schema_context',
      id: 'schema-query-limit',
      input: { datasource: 'mysql:customers' },
      response: {
        structured_content: {
          datasource: 'mysql:customers',
          schema_snapshot_id: schemaSnapshotId
        }
      }
    });
    for (let index = 1; index <= 4; index += 1) {
      await recordPassedHostHookCall(fixture, {
        tool: 'datasource_query_readonly',
        id: `query-limit-${index}`,
        input: queryInput,
        response: {
          structured_content: {
            datasource: 'mysql:customers',
            schema_snapshot_id: schemaSnapshotId,
            query_sha256: `sha256:${sha256(query)}`,
            row_count: 1,
            column_count: 1,
            truncated: false,
            status: 'passed'
          }
        }
      });
    }
    const fifthQuery: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__datasource_query_readonly',
      tool_input: queryInput,
      tool_use_id: 'query-limit-5'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(fifthQuery.decision, 'block');
    assert.match(fifthQuery.reason, /host_capability_readonly_query_limit_exceeded/);
  } finally {
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});

test('host capability hooks deny query-before-schema and concurrent or repeated readonly queries before side effects', async () => {
  const fixture = await createHostHookFixture({
    label: 'db-invalid-order',
    goal: 'Get active customer records from the database.',
    toolNames: ['datasource_schema_context', 'datasource_query_readonly']
  });
  const query = 'SELECT customer_id FROM customers WHERE active = ?';
  const schemaSnapshotId = 'schema-snapshot-customers-v2';
  const queryInput = { datasource: 'mysql:customers', schema_snapshot_id: schemaSnapshotId, query, bindings: [true] };
  try {
    const beforeSchema: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__datasource_query_readonly',
      tool_input: queryInput,
      tool_use_id: 'query-before-schema'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(beforeSchema.decision, 'block');
    assert.match(beforeSchema.reason, /host_capability_readonly_query_schema_not_completed/);

    const schemaAllowed: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__datasource_schema_context',
      tool_input: { datasource: 'mysql:customers' },
      tool_use_id: 'ordered-schema'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(schemaAllowed.decision, undefined);
    const whileSchemaPending: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__datasource_query_readonly',
      tool_input: queryInput,
      tool_use_id: 'query-while-schema-pending'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(whileSchemaPending.decision, 'block');
    assert.match(whileSchemaPending.reason, /host_capability_readonly_query_schema_not_completed/);

    await evaluateHookPayload('post-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__datasource_schema_context',
      tool_input: { datasource: 'mysql:customers' },
      tool_response: {
        structured_content: {
          datasource: 'mysql:customers',
          schema_snapshot_id: schemaSnapshotId
        }
      },
      tool_use_id: 'ordered-schema'
    }, { root: fixture.root, state: fixture.state });

    const queryAllowed: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__datasource_query_readonly',
      tool_input: queryInput,
      tool_use_id: 'ordered-query'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(queryAllowed.decision, undefined);
    const concurrentQuery: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__datasource_query_readonly',
      tool_input: { ...queryInput, query: `${query} LIMIT 1` },
      tool_use_id: 'concurrent-query'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(concurrentQuery.decision, 'block');
    assert.match(concurrentQuery.reason, /host_capability_readonly_query_already_reserved/);

    await evaluateHookPayload('post-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__datasource_query_readonly',
      tool_input: queryInput,
      tool_response: {
        structured_content: {
          datasource: 'mysql:customers',
          schema_snapshot_id: schemaSnapshotId,
          query_sha256: `sha256:${sha256(query)}`,
          row_count: 1,
          column_count: 1,
          truncated: false,
          status: 'passed'
        }
      },
      tool_use_id: 'ordered-query'
    }, { root: fixture.root, state: fixture.state });
    const repeatedQuery: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__datasource_query_readonly',
      tool_input: { ...queryInput, query: `${query} OFFSET 1` },
      tool_use_id: 'query-after-completion'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(repeatedQuery.decision, undefined);
  } finally {
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});

test('host capability hooks deny spreadsheet updates without a completed same-workbook inspect and reserve one mutation', async () => {
  const fixture = await createHostHookFixture({
    label: 'spreadsheet-update-order',
    goal: 'Update reports/book.xlsx with the latest results.',
    toolNames: ['spreadsheet_inspect', 'spreadsheet_update']
  });
  const workbookPath = 'reports/book.xlsx';
  const otherWorkbookPath = 'reports/other.xlsx';
  try {
    const beforeInspect: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_update',
      tool_input: { path: workbookPath, patch: { sheet: 'Summary', range: 'B2' } },
      tool_use_id: 'update-before-inspect'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(beforeInspect.decision, 'block');
    assert.match(beforeInspect.reason, /host_capability_spreadsheet_update_inspection_not_completed/);

    const inspectAllowed: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: workbookPath },
      tool_use_id: 'ordered-inspect'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(inspectAllowed.decision, undefined);
    const whileInspectPending: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_update',
      tool_input: { path: workbookPath, patch: { sheet: 'Summary', range: 'B2' } },
      tool_use_id: 'update-while-inspect-pending'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(whileInspectPending.decision, 'block');
    assert.match(whileInspectPending.reason, /host_capability_spreadsheet_update_inspection_not_completed/);

    await evaluateHookPayload('post-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: workbookPath },
      tool_response: {
        structured_content: {
          ok: true,
          path: workbookPath,
          sheet_names: ['Summary'],
          row_counts: { Summary: 4 },
          formulas: [],
          error_cells: []
        }
      },
      tool_use_id: 'ordered-inspect'
    }, { root: fixture.root, state: fixture.state });

    const wrongWorkbook: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_update',
      tool_input: { path: otherWorkbookPath, patch: { sheet: 'Summary', range: 'B2' } },
      tool_use_id: 'wrong-workbook-update'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(wrongWorkbook.decision, 'block');
    assert.match(wrongWorkbook.reason, /host_capability_spreadsheet_update_resource_mismatch/);

    const updateAllowed: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_update',
      tool_input: { path: workbookPath, patch: { sheet: 'Summary', range: 'B2' } },
      tool_use_id: 'ordered-update'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(updateAllowed.decision, undefined);
    const concurrentUpdate: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_update',
      tool_input: { path: workbookPath, patch: { sheet: 'Summary', range: 'B3' } },
      tool_use_id: 'concurrent-update'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(concurrentUpdate.decision, 'block');
    assert.match(concurrentUpdate.reason, /host_capability_spreadsheet_update_already_reserved/);

    await evaluateHookPayload('post-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_update',
      tool_input: { path: workbookPath, patch: { sheet: 'Summary', range: 'B2' } },
      tool_response: {
        structured_content: {
          ok: true,
          path: workbookPath,
          artifact: {
            path: workbookPath,
            kind: 'spreadsheet',
            media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            sha256: `sha256:${'c'.repeat(64)}`,
            bytes: 4096,
            role: 'deliverable'
          }
        }
      },
      tool_use_id: 'ordered-update'
    }, { root: fixture.root, state: fixture.state });
    const repeatedUpdateWithoutInspect: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_update',
      tool_input: { path: workbookPath, patch: { sheet: 'Summary', range: 'B4' } },
      tool_use_id: 'update-after-completion'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(repeatedUpdateWithoutInspect.decision, 'block');
    assert.match(repeatedUpdateWithoutInspect.reason, /host_capability_spreadsheet_update_inspection_not_completed/);

    await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: workbookPath },
      tool_use_id: 'inspect-after-update'
    }, { root: fixture.root, state: fixture.state });
    await evaluateHookPayload('post-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: workbookPath },
      tool_response: {
        structured_content: {
          ok: true,
          path: workbookPath,
          sheet_names: ['Summary'],
          row_counts: { Summary: 4 },
          formulas: [],
          error_cells: []
        }
      },
      tool_use_id: 'inspect-after-update'
    }, { root: fixture.root, state: fixture.state });
    const repeatedUpdateAfterInspect: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_update',
      tool_input: { path: workbookPath, patch: { sheet: 'Summary', range: 'B4' } },
      tool_use_id: 'update-after-inspect'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(repeatedUpdateAfterInspect.decision, undefined);
  } finally {
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});

test('spreadsheet create missions deny existing-workbook updates before a completed same-resource create', async () => {
  const fixture = await createHostHookFixture({
    label: 'spreadsheet-create-update-order',
    goal: 'Create an Excel workbook and update it.',
    toolNames: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update']
  });
  const existingWorkbookPath = 'reports/existing.xlsx';
  const createdWorkbookPath = 'reports/created.xlsx';
  try {
    await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: existingWorkbookPath },
      tool_use_id: 'inspect-existing-before-create'
    }, { root: fixture.root, state: fixture.state });
    await evaluateHookPayload('post-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: existingWorkbookPath },
      tool_response: {
        structured_content: {
          ok: true,
          path: existingWorkbookPath,
          sheet_names: ['Summary'],
          row_counts: { Summary: 4 },
          formulas: [],
          error_cells: []
        }
      },
      tool_use_id: 'inspect-existing-before-create'
    }, { root: fixture.root, state: fixture.state });

    const denied: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_update',
      tool_input: { path: existingWorkbookPath, patch: { sheet: 'Summary', range: 'B2' } },
      tool_use_id: 'update-existing-before-create'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(denied.decision, 'block');
    assert.match(denied.reason, /host_capability_spreadsheet_update_create_not_completed/);

    await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_create',
      tool_input: { path: createdWorkbookPath },
      tool_use_id: 'create-different-workbook'
    }, { root: fixture.root, state: fixture.state });
    await evaluateHookPayload('post-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_create',
      tool_input: { path: createdWorkbookPath },
      tool_response: {
        structured_content: {
          ok: true,
          path: createdWorkbookPath,
          artifact: {
            path: createdWorkbookPath,
            kind: 'spreadsheet',
            media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            sha256: `sha256:${'c'.repeat(64)}`,
            bytes: 4096,
            role: 'deliverable'
          }
        }
      },
      tool_use_id: 'create-different-workbook'
    }, { root: fixture.root, state: fixture.state });

    const wrongResource: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_update',
      tool_input: { path: existingWorkbookPath, patch: { sheet: 'Summary', range: 'B2' } },
      tool_use_id: 'update-existing-after-other-create'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(wrongResource.decision, 'block');
    assert.match(wrongResource.reason, /host_capability_spreadsheet_update_resource_mismatch/);
  } finally {
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});

test('spreadsheet create missions require a same-resource inspect completed after create before update', async () => {
  const fixture = await createHostHookFixture({
    label: 'spreadsheet-create-inspect-order',
    goal: 'Create an Excel workbook and update it.',
    toolNames: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update']
  });
  const workbookPath = 'reports/created.xlsx';
  try {
    await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: workbookPath },
      tool_use_id: 'inspect-before-create'
    }, { root: fixture.root, state: fixture.state });
    await evaluateHookPayload('post-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: workbookPath },
      tool_response: {
        structured_content: {
          ok: true,
          path: workbookPath,
          sheet_names: ['Summary'],
          row_counts: { Summary: 4 },
          formulas: [],
          error_cells: []
        }
      },
      tool_use_id: 'inspect-before-create'
    }, { root: fixture.root, state: fixture.state });

    await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_create',
      tool_input: { path: workbookPath },
      tool_use_id: 'create-after-inspect'
    }, { root: fixture.root, state: fixture.state });
    await evaluateHookPayload('post-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_create',
      tool_input: { path: workbookPath },
      tool_response: {
        structured_content: {
          ok: true,
          path: workbookPath,
          artifact: {
            path: workbookPath,
            kind: 'spreadsheet',
            media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            sha256: `sha256:${'e'.repeat(64)}`,
            bytes: 4096,
            role: 'deliverable'
          }
        }
      },
      tool_use_id: 'create-after-inspect'
    }, { root: fixture.root, state: fixture.state });

    const denied: any = await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_update',
      tool_input: { path: workbookPath, patch: { sheet: 'Summary', range: 'B2' } },
      tool_use_id: 'update-after-stale-inspect'
    }, { root: fixture.root, state: fixture.state });
    assert.equal(denied.decision, 'block');
    assert.match(denied.reason, /host_capability_spreadsheet_update_inspection_not_completed/);
  } finally {
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});

test('create and inspect spreadsheet intent remains create-only and completes without an update', async () => {
  const goal = 'Create an Excel workbook and inspect it.';
  assert.deepEqual(requestHostCapabilities(goal), {
    capability_ids: ['host.artifact.receipt.v1', 'host.spreadsheet.workbook.v1'],
    workflows: ['artifact_delivery', 'spreadsheet_create'],
    tool_names: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update']
  });
  const fixture = await createHostHookFixture({
    label: 'spreadsheet-create-inspect',
    goal,
    toolNames: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update']
  });
  const workbookPath = 'reports/created.xlsx';
  try {
    await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_create',
      tool_input: { path: workbookPath },
      tool_use_id: 'create-for-inspection'
    }, { root: fixture.root, state: fixture.state });
    await evaluateHookPayload('post-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_create',
      tool_input: { path: workbookPath },
      tool_response: {
        structured_content: {
          ok: true,
          path: workbookPath,
          artifact: {
            path: workbookPath,
            kind: 'spreadsheet',
            media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            sha256: `sha256:${'d'.repeat(64)}`,
            bytes: 4096,
            role: 'deliverable'
          }
        }
      },
      tool_use_id: 'create-for-inspection'
    }, { root: fixture.root, state: fixture.state });
    await evaluateHookPayload('pre-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: workbookPath },
      tool_use_id: 'inspect-created-workbook'
    }, { root: fixture.root, state: fixture.state });
    await evaluateHookPayload('post-tool', {
      session_id: fixture.sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: workbookPath },
      tool_response: {
        structured_content: {
          ok: true,
          path: workbookPath,
          sheet_names: ['Summary'],
          row_counts: { Summary: 4 },
          formulas: [],
          error_cells: []
        }
      },
      tool_use_id: 'inspect-created-workbook'
    }, { root: fixture.root, state: fixture.state });

    const evidence = JSON.parse(await fsp.readFile(path.join(
      fixture.dir,
      HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME
    ), 'utf8'));
    assert.equal(evidence.ok, true);
    assert.deepEqual(evidence.runtime.task_workflows, ['artifact_delivery', 'spreadsheet_create']);
    assert.deepEqual(evidence.tool_calls.map((row: any) => row.tool), [
      'spreadsheet_create',
      'spreadsheet_inspect'
    ]);
    assert.deepEqual(evidence.blockers, []);
  } finally {
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});

test('host capability PostToolUse fails closed for missing or malformed datasource receipts', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-host-db-receipts-'));
  const missionId = 'M-20260719-host-db-receipts';
  const workflowRunId = 'naruto-host-db-receipts-run';
  const sessionId = 'host-db-receipts-session';
  const dir = path.join(root, '.sneakoscope', 'missions', missionId);
  const goal = 'Query database rows and retrieve the results.';
  const state = {
    mission_id: missionId,
    official_subagent_run_id: workflowRunId,
    session_scope: sessionId,
    mode: 'NARUTO',
    route: 'Naruto',
    subagents_required: true,
    prompt: goal
  };
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'subagent-plan.json'), `${JSON.stringify({ goal }, null, 2)}\n`);
    const runtime = await inspectHostCapabilityRuntime({
      root,
      request: requestHostCapabilities(goal),
      projectTrusted: true,
      dependencies: hostCapabilityDependencies(['datasource_schema_context', 'datasource_query_readonly'])
    });
    await fsp.writeFile(path.join(dir, HOST_CAPABILITY_HOOK_RUNTIME_FILENAME), `${JSON.stringify(
      createHostCapabilityHookRuntimeBinding({ missionId, workflowRunId, sessionScope: sessionId, runtime }),
      null,
      2
    )}\n`);
    const schemaSnapshotId = 'schema-snapshot-finance-v4';
    const query = 'SELECT account_id, balance FROM accounts WHERE active = ?';
    const calls = [
      {
        tool: 'datasource_schema_context',
        id: 'db-schema',
        input: { datasource: 'mysql:finance' },
        response: {
          structured_content: {
            datasource: 'mysql:finance',
            schema_snapshot_id: schemaSnapshotId,
            tables: ['must-not-persist']
          }
        }
      },
      {
        tool: 'datasource_query_readonly',
        id: 'db-query-with-center-bound-datasource',
        input: { datasource: 'mysql:finance', schema_snapshot_id: schemaSnapshotId, query, bindings: [true] },
        response: {
          structured_content: {
            datasource: 'mysql:finance',
            schema_snapshot_id: schemaSnapshotId,
            query_sha256: `sha256:${sha256(query)}`,
            row_count: 2,
            column_count: 2,
            truncated: false,
            status: 'passed'
          }
        }
      },
      {
        tool: 'datasource_query_readonly',
        id: 'db-query-missing-receipt',
        input: { datasource: 'mysql:finance', schema_snapshot_id: schemaSnapshotId, query, bindings: [true] },
        response: {
          structured_content: {
            datasource: 'mysql:finance',
            schema_snapshot_id: schemaSnapshotId,
            query_sha256: `sha256:${sha256(query)}`,
            column_count: 2,
            truncated: false,
            status: 'passed',
            rows: [{ account_id: 'must-not-persist', balance: 10 }]
          }
        }
      },
      {
        tool: 'datasource_query_readonly',
        id: 'db-query-malformed',
        input: { datasource: 'mysql:finance', schema_snapshot_id: schemaSnapshotId, query, bindings: [true] },
        response: 'malformed-host-response'
      },
      {
        tool: 'datasource_query_readonly',
        id: 'db-query-cross-datasource',
        input: { datasource: 'mysql:hr', schema_snapshot_id: schemaSnapshotId, query, bindings: [true] },
        response: {
          structured_content: {
            datasource: 'mysql:hr',
            schema_snapshot_id: schemaSnapshotId,
            query_sha256: `sha256:${sha256(query)}`,
            row_count: 1,
            column_count: 2,
            truncated: false,
            status: 'passed'
          }
        }
      }
    ];
    for (const call of calls) {
      await evaluateHookPayload('pre-tool', {
        session_id: sessionId,
        tool_name: `mcp__acas-tools__${call.tool}`,
        tool_input: call.input,
        tool_use_id: call.id
      }, { root, state });
      await evaluateHookPayload('post-tool', {
        session_id: sessionId,
        tool_name: `mcp__acas-tools__${call.tool}`,
        tool_input: call.input,
        tool_response: call.response,
        tool_use_id: call.id
      }, { root, state });
    }
    const observationsText = await fsp.readFile(path.join(dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME), 'utf8');
    const observations = JSON.parse(observationsText);
    const evidenceText = await fsp.readFile(path.join(dir, HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME), 'utf8');
    const evidence = JSON.parse(evidenceText);
    const centerBoundQuery = observations.tool_calls.find((row: any) => row.tool_use_id_sha256 === `sha256:${sha256('db-query-with-center-bound-datasource')}`);
    assert.equal(centerBoundQuery.status, 'passed');
    assert.equal(centerBoundQuery.semantic_receipt.datasource_sha256, `sha256:${sha256('mysql:finance')}`);
    assert.equal(evidence.ok, false);
    assert.ok(evidence.blockers.includes('host_capability_readonly_query_receipt_invalid'));
    assert.ok(evidence.blockers.includes('host_tool_response_malformed:datasource_query_readonly'));
    assert.ok(evidence.blockers.includes('host_capability_readonly_query_datasource_mismatch'));
    assert.equal(evidenceText.includes('must-not-persist'), false);
    assert.equal(evidenceText.includes('mysql:finance'), false);
    assert.equal(evidenceText.includes('mysql:hr'), false);
    assert.equal(observationsText.includes('mysql:finance'), false);
    assert.equal(observationsText.includes('mysql:hr'), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('spreadsheet inspection receipts fail closed when logical error cells are reported', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-host-sheet-errors-'));
  const missionId = 'M-20260719-host-sheet-errors';
  const workflowRunId = 'naruto-host-sheet-errors-run';
  const sessionId = 'host-sheet-errors-session';
  const dir = path.join(root, '.sneakoscope', 'missions', missionId);
  const goal = 'Create and deliver an Excel workbook.';
  const state = {
    mission_id: missionId,
    official_subagent_run_id: workflowRunId,
    session_scope: sessionId,
    mode: 'NARUTO',
    route: 'Naruto',
    subagents_required: true,
    prompt: goal
  };
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'subagent-plan.json'), `${JSON.stringify({ goal }, null, 2)}\n`);
    const runtime = await inspectHostCapabilityRuntime({
      root,
      request: requestHostCapabilities(goal),
      projectTrusted: true,
      dependencies: hostCapabilityDependencies(['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update'])
    });
    await fsp.writeFile(path.join(dir, HOST_CAPABILITY_HOOK_RUNTIME_FILENAME), `${JSON.stringify(
      createHostCapabilityHookRuntimeBinding({ missionId, workflowRunId, sessionScope: sessionId, runtime }),
      null,
      2
    )}\n`);
    const payload = {
      session_id: sessionId,
      tool_name: 'mcp__acas-tools__spreadsheet_inspect',
      tool_input: { path: 'reports/error.xlsx' },
      tool_response: {
        structured_content: {
          ok: true,
          sheet_names: ['Summary'],
          row_counts: { Summary: 4 },
          formulas: ['=1/0'],
          error_cells: [{ cell: 'B2', error: '#DIV/0!', secret_formula: 'must-not-persist' }]
        }
      },
      tool_use_id: 'sheet-error-inspect'
    };
    await evaluateHookPayload('pre-tool', payload, { root, state });
    await evaluateHookPayload('post-tool', payload, { root, state });
    const observationsText = await fsp.readFile(path.join(dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME), 'utf8');
    const evidence = JSON.parse(await fsp.readFile(path.join(dir, HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME), 'utf8'));
    assert.equal(evidence.ok, false);
    assert.ok(evidence.blockers.includes('host_capability_spreadsheet_error_cells_present'));
    assert.equal(observationsText.includes('must-not-persist'), false);
    assert.equal(observationsText.includes('#DIV/0!'), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

function hostCapabilityDependencies(toolNames: string[]) {
  return {
    inventory: async () => ({
      schema: 'sks.mcp-inventory.v2',
      ok: true,
      scope: 'project',
      source: 'fixture_inventory',
      servers: [{
        name: 'acas-tools',
        enabled: true,
        enabled_tools: [...toolNames],
        disabled_tools: []
      }],
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
      status: 'healthy',
      tool_names: [...toolNames]
    }) as any
  };
}

async function createHostHookFixture(input: {
  label: string;
  goal: string;
  toolNames: string[];
}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `sks-hook-${input.label}-`));
  const missionId = `M-20260720-${input.label}`;
  const workflowRunId = `naruto-${input.label}-run`;
  const sessionId = `${input.label}-session`;
  const dir = path.join(root, '.sneakoscope', 'missions', missionId);
  const state = {
    mission_id: missionId,
    official_subagent_run_id: workflowRunId,
    session_scope: sessionId,
    mode: 'NARUTO',
    route: 'Naruto',
    subagents_required: true,
    prompt: input.goal
  };
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'subagent-plan.json'), `${JSON.stringify({ goal: input.goal }, null, 2)}\n`);
  const runtime = await inspectHostCapabilityRuntime({
    root,
    request: requestHostCapabilities(input.goal),
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(input.toolNames)
  });
  assert.equal(runtime.ok, true);
  await fsp.writeFile(path.join(dir, HOST_CAPABILITY_HOOK_RUNTIME_FILENAME), `${JSON.stringify(
    createHostCapabilityHookRuntimeBinding({ missionId, workflowRunId, sessionScope: sessionId, runtime }),
    null,
    2
  )}\n`);
  return { root, dir, state, sessionId };
}

async function recordPassedHostHookCall(
  fixture: Awaited<ReturnType<typeof createHostHookFixture>>,
  call: {
    tool: string;
    id: string;
    input: Record<string, unknown>;
    response: unknown;
  }
): Promise<void> {
  const preTool: any = await evaluateHookPayload('pre-tool', {
    session_id: fixture.sessionId,
    tool_name: `mcp__acas-tools__${call.tool}`,
    tool_input: call.input,
    tool_use_id: call.id
  }, { root: fixture.root, state: fixture.state });
  assert.equal(preTool.decision, undefined, call.id);
  await evaluateHookPayload('post-tool', {
    session_id: fixture.sessionId,
    tool_name: `mcp__acas-tools__${call.tool}`,
    tool_input: call.input,
    tool_response: call.response,
    tool_use_id: call.id
  }, { root: fixture.root, state: fixture.state });
}

function contentOnlyAgentHostToolResponse(content: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(content)
    }],
    isError: false
  };
}

function structuredAgentHostToolResponse(
  structuredContent: Record<string, unknown>,
  content: Record<string, unknown> = structuredContent
): Record<string, unknown> {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(content)
    }],
    structuredContent,
    isError: false
  };
}

function completedHostToolEvent(input: {
  tool: string;
  arguments: Record<string, unknown>;
  result: unknown;
}): string {
  return JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'acas-tools',
      tool: input.tool,
      status: 'completed',
      arguments: input.arguments,
      result: input.result
    }
  });
}

function completedDatasourceHostToolEvent(input: {
  tool: 'datasource_schema_context' | 'datasource_query_readonly';
  arguments: Record<string, unknown>;
  response: Record<string, unknown>;
}): string {
  return completedHostToolEvent({
    tool: input.tool,
    arguments: input.arguments,
    result: { structured_content: input.response }
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
