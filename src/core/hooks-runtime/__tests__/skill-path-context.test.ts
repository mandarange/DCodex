import {
  admissionBindingState,
  assert,
  escapeRegExp,
  evaluateHookPayload,
  fsp,
  homeAdmissionGuardRoot,
  initProject,
  installCurrentManagedSkill,
  installGlobalSkills,
  missionDir,
  normalizeHookResult,
  os,
  path,
  preToolPayload,
  setCurrent,
  sha256,
  subagentPayload,
  SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME,
  test,
  validateCodexHookOutput,
  validateCompactSemanticOutput,
  validatePreToolUseSemanticOutput,
  validateSessionStartSemanticOutput,
  validateSubagentStartSemanticOutput,
  writeManagedSkill,
  writeOfficialSubagentPlan,
  writeTranscript
} from './skill-path-context-fixtures.js';

test('UserPromptSubmit injects current global skill files instead of stale project paths', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-skill-path-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const answer = await installCurrentManagedSkill(home, 'sks-answer');
    const honest = await installCurrentManagedSkill(home, 'sks-honest-mode');
    await writeManagedSkill(path.join(root, '.agents', 'skills'), 'answer');
    await writeManagedSkill(path.join(root, '.codex', 'skills'), 'honest-mode');

    const result: any = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      conversation_id: 'skill-path-context-session',
      turn_id: 'skill-path-context-turn',
      prompt: '이 함수가 왜 이렇게 동작해?'
    }, { root, state: {} });

    assert.equal(result.continue, true);
    assert.match(String(result.additionalContext || ''), new RegExp(escapeRegExp(answer)));
    assert.match(String(result.additionalContext || ''), new RegExp(escapeRegExp(honest)));
    assert.doesNotMatch(String(result.additionalContext || ''), new RegExp(escapeRegExp(path.join(root, '.agents', 'skills', 'answer'))));
    assert.match(String(result.additionalContext || ''), /override stale project-local/i);
    assert.match(String(result.additionalContext || ''), /do not report a skill-path mismatch/i);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});
test('global setup installs authoritative skills in HOME and the next route resolves them', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-skill-path-setup-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    await initProject(root, {
      installScope: 'global',
      localOnly: true,
      home,
      codexHome: path.join(home, '.codex')
    });

    const naruto = path.join(home, '.agents', 'skills', 'sks-naruto', 'SKILL.md');
    await fsp.access(naruto);
    await assert.rejects(fsp.access(path.join(root, '.agents', 'skills', 'sks-naruto', 'SKILL.md')));
    const manifest = JSON.parse(await fsp.readFile(path.join(root, '.sneakoscope', 'manifest.json'), 'utf8'));
    assert.equal(
      manifest.generated_files.files.some((file: unknown) => String(file).startsWith('.agents/skills/')),
      false
    );

    const result: any = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      conversation_id: 'skill-path-setup-session',
      turn_id: 'skill-path-setup-turn',
      prompt: '$sks-naruto 두 독립 검토를 실행해줘'
    }, { root, state: {} });

    assert.equal(result.decision, undefined);
    assert.match(String(result.additionalContext || ''), new RegExp(escapeRegExp(naruto)));
    assert.doesNotMatch(String(result.additionalContext || ''), /unavailable=sks-naruto/);

    const child: any = await evaluateHookPayload('subagent-start', {
      cwd: root,
      session_id: 'skill-path-setup-child',
      turn_id: 'skill-path-setup-child-turn',
      agent_id: 'skill-path-reviewer',
      hook_event_name: 'SubagentStart'
    }, {
      root,
      state: {
        mission_id: 'M-skill-path-setup',
        official_subagent_run_id: 'run-skill-path-setup',
        route: 'Naruto',
        route_command: '$sks-naruto',
        mode: 'NARUTO',
        route_closed: false,
        required_skills: ['sks-naruto']
      }
    });
    const normalized: any = normalizeHookResult('subagent-start', child);
    assert.match(String(normalized.hookSpecificOutput?.additionalContext || ''), new RegExp(escapeRegExp(naruto)));
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('closed non-Naruto state does not admit or block an ordinary child thread as an official Naruto run', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-closed-route-child-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const agentId = 'closed-align-audit-child';
  const missionId = 'M-closed-align-audit';
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
    const state = {
      mission_id: missionId,
      route: 'Align',
      route_command: '$Align',
      mode: 'ALIGN',
      route_closed: true,
      required_skills: ['sks-align']
    };
    const started: any = await evaluateHookPayload('subagent-start', {
      ...subagentPayload(agentId),
      cwd: root
    }, { root, state });
    assert.equal(started.decision, undefined);
    assert.doesNotMatch(
      String(started.additionalContext || ''),
      /SKS Naruto policy|MANDATORY SKS PARENT-BLOCK HANDOFF|subagent_skill_availability_guard_invalid/
    );
    await assert.rejects(fsp.access(path.join(
      missionDir(root, missionId),
      SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME
    )));

    const transcript = await writeTranscript(home, agentId, true);
    const tool: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(transcript, agentId),
      cwd: root,
      tool_use_id: 'tool-closed-align-audit-child'
    }, { root, state });
    assert.equal(tool.decision, undefined);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('route closure keeps an already-admitted official Naruto child guard fail-closed', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-closed-official-child-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const missionId = 'M-closed-official-child';
  const workflowRunId = 'run-closed-official-child';
  const agentId = 'closed-official-agent';
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
    await writeOfficialSubagentPlan(root, missionId, workflowRunId);
    const activeState = {
      mission_id: missionId,
      official_subagent_run_id: workflowRunId,
      route: 'Naruto',
      route_command: '$sks-naruto',
      mode: 'NARUTO',
      route_closed: false,
      required_skills: ['sks-naruto']
    };
    const started: any = await evaluateHookPayload('subagent-start', {
      ...subagentPayload(agentId),
      cwd: root
    }, { root, state: activeState });
    assert.match(String(started.additionalContext || ''), /MANDATORY SKS PARENT-BLOCK HANDOFF/);

    const transcript = await writeTranscript(home, agentId, true);
    const tool: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(transcript, agentId),
      cwd: root
    }, { root, state: { ...activeState, route_closed: true } });
    assert.equal(tool.decision, 'block');
    assert.match(String(tool.reason || ''), /authoritative_sks_skill_unavailable:sks-naruto/);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('active Naruto state with a partial mission binding emits a mandatory invalid-guard handoff', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-partial-official-binding-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const started: any = await evaluateHookPayload('subagent-start', {
      ...subagentPayload('partial-binding-agent'),
      cwd: root
    }, {
      root,
      state: {
        mission_id: 'M-partial-binding',
        route: 'Naruto',
        mode: 'NARUTO',
        route_closed: false,
        required_skills: ['sks-naruto']
      }
    });
    assert.match(String(started.additionalContext || ''), /MANDATORY SKS PARENT-BLOCK HANDOFF/);
    assert.match(String(started.additionalContext || ''), /subagent_skill_availability_guard_invalid/);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('project setup still installs authoritative skills in HOME and the next route resolves them', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-skill-path-project-setup-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const setup: any = await initProject(root, {
      installScope: 'project',
      localOnly: true,
      home,
      codexHome: path.join(home, '.codex')
    });

    const naruto = path.join(home, '.agents', 'skills', 'sks-naruto', 'SKILL.md');
    await fsp.access(naruto);
    await assert.rejects(fsp.access(path.join(root, '.agents', 'skills', 'sks-naruto', 'SKILL.md')));
    assert.equal(setup.skill_install.ok, true);
    assert.equal(setup.skill_install.scope, 'global');

    const result: any = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      conversation_id: 'skill-path-project-setup-session',
      turn_id: 'skill-path-project-setup-turn',
      prompt: '$sks-naruto 두 독립 검토를 실행해줘'
    }, { root, state: {} });

    assert.equal(result.decision, undefined);
    assert.match(String(result.additionalContext || ''), new RegExp(escapeRegExp(naruto)));
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('missing full-route skills block before mission or session admission state is written', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-skill-path-pre-admission-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const result: any = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      conversation_id: 'skill-path-pre-admission-session',
      turn_id: 'skill-path-pre-admission-turn',
      prompt: '$sks-naruto 두 독립 검토를 실행해줘'
    }, { root, state: {} });

    assert.equal(result.decision, 'block');
    assert.match(String(result.reason || ''), /unavailable=sks-/);
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'missions')));
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'state', 'current.json')));
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'state', 'sessions')));
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('SubagentStart missing-skill handoff blocks only that child tools and binds the mission evidence', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-skill-path-child-block-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const missionId = 'M-skill-path-child-block';
  const workflowRunId = 'run-skill-path-child-block';
  const blockedAgent = 'skill-path-blocked-agent';
  const siblingAgent = 'skill-path-sibling-agent';
  const state = {
    mission_id: missionId,
    route: 'Naruto',
    route_command: '$sks-naruto',
    mode: 'NARUTO',
    route_closed: false,
    requested_subagents: 1,
    official_subagent_run_id: workflowRunId,
    required_skills: ['sks-naruto']
  };
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
    const dir = missionDir(root, missionId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
      schema: 'sks.subagent-plan.v1',
      workflow: 'official_codex_subagent',
      mission_id: missionId,
      workflow_run_id: workflowRunId,
      requested_subagents: 1
    }));

    const started: any = await evaluateHookPayload(
      'subagent-start',
      { ...subagentPayload(blockedAgent), cwd: root },
      { root, state }
    );
    const normalized: any = normalizeHookResult('subagent-start', started);
    assert.equal(started.continue, true);
    assert.equal(started.decision, undefined);
    assert.equal(validateSubagentStartSemanticOutput(normalized).ok, true);
    assert.match(String(normalized.hookSpecificOutput?.additionalContext || ''), /MANDATORY SKS PARENT-BLOCK HANDOFF/);
    assert.doesNotMatch(String(normalized.hookSpecificOutput?.additionalContext || ''), /\.codex\/skills|plugin-cache|path mismatch/i);

    const marker = JSON.parse(await fsp.readFile(path.join(dir, SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME), 'utf8'));
    assert.equal(marker.mission_id, missionId);
    assert.equal(marker.workflow_run_id, workflowRunId);
    assert.deepEqual(marker.blockers, ['authoritative_sks_skill_unavailable:sks-naruto']);
    const evidence = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-evidence.json'), 'utf8'));
    assert.ok(evidence.blockers.includes('authoritative_sks_skill_unavailable:sks-naruto'));

    await installCurrentManagedSkill(home, 'sks-naruto');
    const siblingStarted: any = await evaluateHookPayload('subagent-start', {
      ...subagentPayload(siblingAgent),
      cwd: root
    }, { root, state });
    assert.doesNotMatch(String(siblingStarted.additionalContext || ''), /MANDATORY SKS PARENT-BLOCK HANDOFF/);

    const blockedTranscript = await writeTranscript(home, blockedAgent, true);
    const siblingTranscript = await writeTranscript(home, siblingAgent, true);
    const parentTranscript = await writeTranscript(home, 'parent-thread', false);
    const blockedTool: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(blockedTranscript, blockedAgent),
      cwd: root
    }, { root, state: admissionBindingState(missionId, workflowRunId) });
    assert.equal(blockedTool.decision, 'block');
    assert.match(String(blockedTool.reason || ''), /authoritative_sks_skill_unavailable:sks-naruto/);

    const siblingTool: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(siblingTranscript, siblingAgent),
      cwd: root,
      tool_use_id: 'tool-sibling'
    }, { root, state: admissionBindingState(missionId, workflowRunId) });
    assert.equal(siblingTool.decision, undefined);
    const parentTool: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(parentTranscript, 'parent-thread'),
      cwd: root,
      tool_use_id: 'tool-parent'
    }, { root, state: {} });
    assert.equal(parentTool.decision, undefined);

    const blockedNullTranscript: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(null, blockedAgent),
      cwd: root,
      tool_use_id: 'tool-blocked-null-transcript'
    }, { root, state });
    assert.equal(blockedNullTranscript.decision, 'block');
    assert.match(String(blockedNullTranscript.reason || ''), /authoritative_sks_skill_unavailable:sks-naruto/);

    const siblingNullTranscript: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(null, siblingAgent),
      cwd: root,
      tool_use_id: 'tool-sibling-null-transcript'
    }, { root, state });
    assert.equal(siblingNullTranscript.decision, undefined);

    const parentNullTranscript: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(null, 'parent-thread'),
      cwd: root,
      tool_use_id: 'tool-parent-null-transcript'
    }, { root, state });
    assert.equal(parentNullTranscript.decision, undefined);

    const wrongSessionSameTurn: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(null, blockedAgent, 'different-session'),
      cwd: root,
      tool_use_id: 'tool-wrong-session-same-turn'
    }, { root, state });
    assert.equal(wrongSessionSameTurn.decision, undefined);

    await evaluateHookPayload('subagent-stop', {
      ...subagentPayload(blockedAgent),
      cwd: root,
      hook_event_name: 'SubagentStop',
      agent_transcript_path: blockedTranscript,
      last_assistant_message: 'Blocked before tool use.',
      stop_hook_active: false
    }, { root, state });
    const finalMarker = JSON.parse(await fsp.readFile(path.join(dir, SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME), 'utf8'));
    assert.deepEqual(finalMarker.blockers, ['authoritative_sks_skill_unavailable:sks-naruto']);
    await fsp.rm(path.join(dir, SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME));
    const afterStop: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(blockedTranscript, blockedAgent),
      cwd: root,
      tool_use_id: 'tool-after-stop',
      turn_id: 'turn-resumed-blocked-agent'
    }, { root, state });
    assert.equal(afterStop.decision, undefined);
    const resumedAdmission = JSON.parse(await fsp.readFile(path.join(
      dir,
      'subagent-skill-availability',
      `run-${sha256(JSON.stringify([missionId, workflowRunId]))}`,
      `thread-${sha256(blockedAgent)}.json`
    ), 'utf8'));
    assert.equal(resumedAdmission.status, 'allowed');
    assert.equal(resumedAdmission.turn_id_hash, sha256('turn-resumed-blocked-agent'));
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('blocked siblings remain independently denied after the shared blocker artifact is overwritten', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-skill-path-blocked-siblings-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const missionId = 'M-skill-path-blocked-siblings';
  const workflowRunId = 'run-skill-path-blocked-siblings';
  const firstAgent = 'blocked-sibling-first';
  const secondAgent = 'blocked-sibling-second';
  const baseState = {
    mission_id: missionId,
    route: 'Naruto',
    route_command: '$sks-naruto',
    mode: 'NARUTO',
    route_closed: false,
    requested_subagents: 2,
    official_subagent_run_id: workflowRunId
  };
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
    const dir = await writeOfficialSubagentPlan(root, missionId, workflowRunId, 2);

    await evaluateHookPayload('subagent-start', {
      ...subagentPayload(firstAgent),
      cwd: root
    }, { root, state: { ...baseState, required_skills: ['sks-naruto'] } });

    await installCurrentManagedSkill(home, 'sks-naruto');
    await evaluateHookPayload('subagent-start', {
      ...subagentPayload(secondAgent),
      cwd: root
    }, { root, state: { ...baseState, required_skills: ['sks-honest-mode'] } });

    const sharedMarker = JSON.parse(await fsp.readFile(
      path.join(dir, SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME),
      'utf8'
    ));
    assert.deepEqual(sharedMarker.blockers, ['authoritative_sks_skill_unavailable:sks-honest-mode']);

    const firstTranscript = await writeTranscript(home, firstAgent, true);
    const secondTranscript = await writeTranscript(home, secondAgent, true);
    const firstBlocked: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(firstTranscript, firstAgent),
      cwd: root,
      tool_use_id: 'tool-blocked-sibling-first'
    }, { root, state: admissionBindingState(missionId, workflowRunId) });
    const secondBlocked: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(secondTranscript, secondAgent),
      cwd: root,
      tool_use_id: 'tool-blocked-sibling-second'
    }, { root, state: admissionBindingState(missionId, workflowRunId) });
    assert.equal(firstBlocked.decision, 'block');
    assert.match(String(firstBlocked.reason || ''), /authoritative_sks_skill_unavailable:sks-naruto/);
    assert.equal(secondBlocked.decision, 'block');
    assert.match(String(secondBlocked.reason || ''), /authoritative_sks_skill_unavailable:sks-honest-mode/);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('the exact sks unavailable blocker remains valid in marker and lifecycle evidence', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-skill-path-exact-sks-blocker-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const missionId = 'M-skill-path-exact-sks-blocker';
  const workflowRunId = 'run-skill-path-exact-sks-blocker';
  const agentId = 'exact-sks-blocker-agent';
  const state = {
    mission_id: missionId,
    route: 'Naruto',
    route_command: '$sks-naruto',
    mode: 'NARUTO',
    route_closed: false,
    requested_subagents: 1,
    official_subagent_run_id: workflowRunId,
    required_skills: ['sks']
  };
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const dir = await writeOfficialSubagentPlan(root, missionId, workflowRunId);
    const started: any = await evaluateHookPayload('subagent-start', {
      ...subagentPayload(agentId),
      cwd: root
    }, { root, state });
    assert.match(String(started.additionalContext || ''), /authoritative_sks_skill_unavailable:sks(?:\D|$)/);

    const marker = JSON.parse(await fsp.readFile(
      path.join(dir, SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME),
      'utf8'
    ));
    assert.deepEqual(marker.blockers, ['authoritative_sks_skill_unavailable:sks']);
    const evidence = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-evidence.json'), 'utf8'));
    assert.ok(evidence.blockers.includes('authoritative_sks_skill_unavailable:sks'));
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});
