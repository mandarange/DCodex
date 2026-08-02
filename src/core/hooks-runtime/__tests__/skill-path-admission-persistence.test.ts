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

test('HOME admission survives transient project and artifact guard write failures', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-skill-path-home-fallback-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const missionId = 'M-skill-path-home-fallback';
  const workflowRunId = 'run-skill-path-home-fallback';
  const agentId = 'home-fallback-agent';
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
  try {
    process.env.HOME = home;
    await installCurrentManagedSkill(home, 'sks-naruto');
    const dir = await writeOfficialSubagentPlan(root, missionId, workflowRunId);
    const projectCollision = path.join(root, '.sneakoscope', 'guards', 'subagent-skill-availability');
    const artifactCollision = path.join(dir, 'subagent-skill-availability');
    await fsp.mkdir(path.dirname(projectCollision), { recursive: true });
    await fsp.writeFile(projectCollision, 'transient project guard collision');
    await fsp.writeFile(artifactCollision, 'transient artifact guard collision');

    const started: any = await evaluateHookPayload('subagent-start', {
      ...subagentPayload(agentId),
      cwd: root
    }, { root, state });
    assert.doesNotMatch(String(started.additionalContext || ''), /MANDATORY SKS PARENT-BLOCK HANDOFF/);
    assert.doesNotMatch(String(started.additionalContext || ''), /guard_persistence_failed/);

    const homeGuardRoot = path.join(
      await homeAdmissionGuardRoot(home, root),
      `run-${sha256(JSON.stringify([missionId, workflowRunId]))}`
    );
    const sessionHash = sha256('shared-parent-session');
    const turnHash = sha256(`turn-${agentId}`);
    const threadAdmission = JSON.parse(await fsp.readFile(
      path.join(homeGuardRoot, `thread-${sha256(agentId)}.json`),
      'utf8'
    ));
    const turnAdmission = JSON.parse(await fsp.readFile(
      path.join(homeGuardRoot, `turn-${sha256(`${sessionHash}:${turnHash}`)}.json`),
      'utf8'
    ));
    assert.equal(threadAdmission.status, 'allowed');
    assert.deepEqual(threadAdmission, turnAdmission);

    await Promise.all([
      fsp.rm(projectCollision, { force: true }),
      fsp.rm(artifactCollision, { force: true })
    ]);
    const allowed: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(null, agentId),
      cwd: root
    }, { root, state });
    assert.equal(allowed.decision, undefined);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('SubagentStart rejects mission-local-only admission when stable guard roots cannot persist', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-skill-path-mission-local-only-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const missionId = 'M-skill-path-mission-local-only';
  const workflowRunId = 'run-skill-path-mission-local-only';
  const agentId = 'mission-local-only-agent';
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
  try {
    process.env.HOME = home;
    await installCurrentManagedSkill(home, 'sks-naruto');
    const dir = await writeOfficialSubagentPlan(root, missionId, workflowRunId);
    const projectCollision = path.join(root, '.sneakoscope', 'guards', 'subagent-skill-availability');
    const homeCollision = await homeAdmissionGuardRoot(home, root);
    await Promise.all([
      fsp.mkdir(path.dirname(projectCollision), { recursive: true }),
      fsp.mkdir(path.dirname(homeCollision), { recursive: true })
    ]);
    await Promise.all([
      fsp.writeFile(projectCollision, 'project stable guard collision'),
      fsp.writeFile(homeCollision, 'home stable guard collision')
    ]);

    const started: any = await evaluateHookPayload('subagent-start', {
      ...subagentPayload(agentId),
      cwd: root
    }, { root, state });
    assert.match(String(started.additionalContext || ''), /MANDATORY SKS PARENT-BLOCK HANDOFF/);
    assert.match(String(started.additionalContext || ''), /subagent_skill_availability_guard_persistence_failed/);

    const marker = JSON.parse(await fsp.readFile(
      path.join(dir, SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME),
      'utf8'
    ));
    assert.deepEqual(marker.blockers, ['subagent_skill_availability_guard_persistence_failed']);
    const missionLocalAdmission = JSON.parse(await fsp.readFile(
      path.join(
        dir,
        'subagent-skill-availability',
        `run-${sha256(JSON.stringify([missionId, workflowRunId]))}`,
        `thread-${sha256(agentId)}.json`
      ),
      'utf8'
    ));
    assert.equal(missionLocalAdmission.status, 'blocked');
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('all guard write failures retain durable proof and exact-schema child tools fail closed', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-skill-path-all-guard-writes-fail-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const missionId = 'M-skill-path-all-guard-writes-fail';
  const workflowRunId = 'run-skill-path-all-guard-writes-fail';
  const agentId = 'all-guard-writes-fail-agent';
  const siblingAgentId = 'all-guard-writes-fail-sibling';
  const state = {
    mission_id: missionId,
    route: 'Naruto',
    route_command: '$sks-naruto',
    mode: 'NARUTO',
    route_closed: false,
    requested_subagents: 2,
    official_subagent_run_id: workflowRunId,
    required_skills: ['sks-naruto']
  };
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    await installCurrentManagedSkill(home, 'sks-naruto');
    const dir = await writeOfficialSubagentPlan(root, missionId, workflowRunId, 2);
    const projectCollision = path.join(root, '.sneakoscope', 'guards', 'subagent-skill-availability');
    const artifactCollision = path.join(dir, 'subagent-skill-availability');
    const homeCollision = await homeAdmissionGuardRoot(home, root);
    await Promise.all([
      fsp.mkdir(path.dirname(projectCollision), { recursive: true }),
      fsp.mkdir(path.dirname(homeCollision), { recursive: true })
    ]);
    await Promise.all([
      fsp.writeFile(projectCollision, 'project guard collision'),
      fsp.writeFile(artifactCollision, 'artifact guard collision'),
      fsp.writeFile(homeCollision, 'home guard collision')
    ]);

    const started: any = await evaluateHookPayload('subagent-start', {
      ...subagentPayload(agentId),
      cwd: root
    }, { root, state });
    assert.match(String(started.additionalContext || ''), /subagent_skill_availability_guard_persistence_failed/);
    const siblingStarted: any = await evaluateHookPayload('subagent-start', {
      ...subagentPayload(siblingAgentId),
      cwd: root
    }, { root, state });
    assert.match(String(siblingStarted.additionalContext || ''), /subagent_skill_availability_guard_persistence_failed/);

    const marker = JSON.parse(await fsp.readFile(
      path.join(dir, SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME),
      'utf8'
    ));
    assert.deepEqual(marker.blockers, ['subagent_skill_availability_guard_persistence_failed']);
    assert.equal(marker.thread_id_hash, sha256(siblingAgentId));
    const emergencyDir = path.join(dir, 'subagent-skill-availability-emergency-denials');
    assert.equal((await fsp.readdir(emergencyDir)).length, 2);
    const sessionEmergencyDir = path.join(
      root,
      '.sneakoscope',
      'state',
      'subagents',
      sha256('shared-parent-session').slice(0, 32),
      'subagent-skill-availability-emergency-denials'
    );
    assert.equal((await fsp.readdir(sessionEmergencyDir)).length, 2);
    const evidence = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-evidence.json'), 'utf8'));
    assert.ok(evidence.blockers.includes('subagent_skill_availability_guard_persistence_failed'));

    await Promise.all([
      fsp.rm(projectCollision, { force: true }),
      fsp.rm(artifactCollision, { force: true }),
      fsp.rm(homeCollision, { force: true })
    ]);
    const exactChildPayload = {
      ...preToolPayload(null, agentId),
      cwd: root,
      state: {}
    };
    assert.equal('agent_id' in exactChildPayload, false);
    const denied: any = await evaluateHookPayload('pre-tool', exactChildPayload, {
      root,
      state: admissionBindingState(missionId, workflowRunId)
    });
    assert.equal(denied.decision, 'block');
    assert.match(String(denied.reason || ''), /subagent_skill_availability_guard_persistence_failed/);

    const siblingDenied: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(null, siblingAgentId),
      cwd: root,
      state: {},
      tool_use_id: 'tool-all-writes-fail-sibling'
    }, { root, state: admissionBindingState(missionId, workflowRunId) });
    assert.equal(siblingDenied.decision, 'block');
    assert.match(String(siblingDenied.reason || ''), /subagent_skill_availability_guard_persistence_failed/);

    const unrelatedParent: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(null, 'unrelated-parent', 'unrelated-parent-session'),
      cwd: root,
      state: {},
      tool_use_id: 'tool-unrelated-parent'
    }, { root, state: {} });
    assert.equal(unrelatedParent.decision, undefined);

    const restarted: any = await evaluateHookPayload('subagent-start', {
      ...subagentPayload(agentId),
      cwd: root
    }, { root, state });
    assert.doesNotMatch(String(restarted.additionalContext || ''), /MANDATORY SKS PARENT-BLOCK HANDOFF/);
    assert.equal((await fsp.readdir(emergencyDir)).length, 1);
    assert.equal((await fsp.readdir(sessionEmergencyDir)).length, 1);
    const markerAfterRestart = JSON.parse(await fsp.readFile(
      path.join(dir, SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME),
      'utf8'
    ));
    assert.equal(markerAfterRestart.thread_id_hash, sha256(siblingAgentId));

    const restartedTool: any = await evaluateHookPayload('pre-tool', exactChildPayload, {
      root,
      state: admissionBindingState(missionId, workflowRunId)
    });
    const siblingStillDenied: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(null, siblingAgentId),
      cwd: root,
      state: {},
      tool_use_id: 'tool-all-writes-fail-sibling-after-restart'
    }, { root, state: admissionBindingState(missionId, workflowRunId) });
    assert.equal(restartedTool.decision, undefined);
    assert.equal(siblingStillDenied.decision, 'block');
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('unsafe or oversized emergency denial files keep a healthy restart fail-closed without reading or changing external content', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-emergency-denial-confinement-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const outside = path.join(fixture, 'outside');
  const missionId = 'M-emergency-denial-confinement';
  const workflowRunId = 'run-emergency-denial-confinement';
  const agentId = 'emergency-denial-confinement-agent';
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
  try {
    process.env.HOME = home;
    await installCurrentManagedSkill(home, 'sks-naruto');
    const dir = await writeOfficialSubagentPlan(root, missionId, workflowRunId);
    await fsp.mkdir(outside, { recursive: true });
    const externalFile = path.join(outside, 'oversized-external-denial.json');
    const externalText = 'x'.repeat((64 * 1024) + 1);
    await fsp.writeFile(externalFile, externalText);
    const artifactEmergencyDir = path.join(dir, 'subagent-skill-availability-emergency-denials');
    const sessionEmergencyDir = path.join(
      root,
      '.sneakoscope',
      'state',
      'subagents',
      sha256('shared-parent-session').slice(0, 32),
      'subagent-skill-availability-emergency-denials'
    );
    await Promise.all([
      fsp.mkdir(artifactEmergencyDir, { recursive: true }),
      fsp.mkdir(sessionEmergencyDir, { recursive: true })
    ]);
    const symlinkDenial = path.join(artifactEmergencyDir, `deny-${'a'.repeat(64)}.json`);
    const oversizedDenial = path.join(sessionEmergencyDir, `deny-${'b'.repeat(64)}.json`);
    await fsp.symlink(externalFile, symlinkDenial);
    await fsp.writeFile(oversizedDenial, externalText);

    const started: any = await evaluateHookPayload('subagent-start', {
      ...subagentPayload(agentId),
      cwd: root
    }, { root, state });
    assert.match(String(started.additionalContext || ''), /subagent_skill_availability_blocker_artifact_write_failed/);

    const denied: any = await evaluateHookPayload('pre-tool', {
      ...preToolPayload(null, agentId),
      cwd: root
    }, { root, state: admissionBindingState(missionId, workflowRunId) });
    assert.equal(denied.decision, 'block');
    assert.equal(await fsp.readlink(symlinkDenial), externalFile);
    assert.equal((await fsp.stat(oversizedDenial)).size, Buffer.byteLength(externalText));
    assert.equal(await fsp.readFile(externalFile, 'utf8'), externalText);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});
