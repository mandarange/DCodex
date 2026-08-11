import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateHookPayload, normalizeHookResult } from '../../hooks-runtime.js';
import { installGlobalSkills } from '../../init/skills.js';
import { loadStateForSession, missionDir } from '../../mission.js';
import { prepareRoute } from '../../pipeline-internals/runtime-core.js';
import {
  allowlistedManagedRouteSkillNames,
  explicitManagedSkillNames,
  INVALID_EXPLICIT_MANAGED_SKILL_NAME,
  MANAGED_ROUTE_SKILL_NAMES,
  managedSkillNamesForPrompt,
  routePrompt
} from '../../routes.js';
import { escapeRegExp } from '../../text/regex.js';

test('explicit managed dollar/app skills are allowlisted, ordered, and never reflect unknown tokens', () => {
  const cases = [
    ['$Work implement the fix', ['sks-work']],
    ['$Fast-Off', ['sks-fast-off']],
    ['[$UX-Review](skill://unsafe\nsecret) inspect', ['sks-image-ux-review']],
    ['$Computer-Use inspect native settings', ['sks-computer-use']],
    ['$sks-loop continue the bounded mission', [INVALID_EXPLICIT_MANAGED_SKILL_NAME]],
    ['$sks-init-deep refresh managed context', ['sks-init-deep']],
    ['$sks-align modernize prompts and skills', ['sks-align']],
    ['$sks-cleanup blank TriWiki', ['sks-cleanup']],
    ['$Release-Review audit', ['sks-release-review']],
    ['$Naruto $sks-context7-docs inspect current docs', ['sks-naruto', 'sks-context7-docs']],
    ['$Naruto $sks-hproof-claim-ledger verify claims', ['sks-naruto', 'sks-hproof-claim-ledger']],
    ['$Naruto $sks-solution-scout inspect precedent', ['sks-naruto', 'sks-solution-scout']],
    ['$MAD-SKS $Naruto implement safely', ['sks-mad-sks', 'sks-naruto']],
    ['$Unknown-Skill $../../escape [$Also-Unknown](secret://value)', []],
    ['$sks-attacker-secret', [INVALID_EXPLICIT_MANAGED_SKILL_NAME]]
  ] as const;

  for (const [prompt, expected] of cases) {
    const selected = explicitManagedSkillNames(prompt);
    assert.deepEqual(selected, expected, prompt);
    assert.doesNotMatch(JSON.stringify(selected), /unsafe|attacker-secret|escape|also-unknown/i, prompt);
  }
  for (const coreSkill of ['sks-computer-use', 'sks-init-deep', 'sks-align', 'sks-cleanup']) {
    assert.ok(MANAGED_ROUTE_SKILL_NAMES.includes(coreSkill), coreSkill);
  }
  assert.equal(MANAGED_ROUTE_SKILL_NAMES.includes('sks-loop'), false);

  const workRoute = routePrompt('$Work implement the fix');
  assert.deepEqual(
    managedSkillNamesForPrompt(workRoute, '$Work implement the fix'),
    [...workRoute.requiredSkills, 'sks-work']
  );
  assert.deepEqual(
    allowlistedManagedRouteSkillNames(['sks-naruto', INVALID_EXPLICIT_MANAGED_SKILL_NAME]),
    ['sks-naruto', INVALID_EXPLICIT_MANAGED_SKILL_NAME]
  );
});

test('UserPromptSubmit loads the exact explicit alias and canonical git/release route skills', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-explicit-route-skills-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
    await fsp.mkdir(home, { recursive: true });
    const installed = await installGlobalSkills(home);
    assert.equal(installed.ok, true);
    await fsp.mkdir(path.join(root, '.sneakoscope', 'wiki'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), JSON.stringify({
      attention: { use_first: [], hydrate_first: [] }
    }));

    const cases = [
      ['$Work implement one bounded fix', 'sks-work'],
      ['$Fast-Off', 'sks-fast-off'],
      ['$UX-Review inspect this screenshot', 'sks-image-ux-review'],
      ['$Computer-Use inspect native settings', 'sks-computer-use'],
      ['$Release-Review release audit', 'sks-release-review'],
      ['$Commit current changes', 'sks-commit'],
      ['$Commit-And-Push current changes', 'sks-commit-and-push'],
      ['$Answer $sks-context7-docs explain the current API contract', 'sks-context7-docs'],
      ['$Answer $sks-hproof-claim-ledger classify these claims', 'sks-hproof-claim-ledger']
    ] as const;

    for (const [prompt, skillName] of cases) {
      const result: any = await evaluateHookPayload('user-prompt-submit', {
        cwd: root,
        conversation_id: `explicit-${skillName}`,
        turn_id: `turn-${skillName}`,
        prompt
      }, { root, state: {} });
      assert.notEqual(result.decision, 'block', prompt);
      assert.match(
        String(result.additionalContext || ''),
        new RegExp(escapeRegExp(path.join(home, '.agents', 'skills', skillName, 'SKILL.md'))),
        prompt
      );
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('a strict support skill persists with a real route while an unknown strict skill fails closed', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-strict-support-skill-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
    await fsp.mkdir(home, { recursive: true });
    const installed = await installGlobalSkills(home);
    assert.equal(installed.ok, true);

    const sessionKey = 'strict-support-persisted';
    const prepared: any = await prepareRoute(root, '$Fast-Off $sks-context7-docs', {}, { sessionKey });
    const state: any = await loadStateForSession(root, sessionKey);
    assert.ok(prepared.mission_id);
    assert.ok(state.required_skills.includes('sks-fast-off'));
    assert.ok(state.required_skills.includes('sks-context7-docs'));

    const hostileName = 'sks-attacker-secret-marker';
    const blocked: any = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      conversation_id: 'strict-unknown-session',
      turn_id: 'strict-unknown-turn',
      prompt: `$Naruto $${hostileName} implement one fix`
    }, { root, state: {} });
    assert.equal(blocked.decision, 'block');
    assert.match(String(blocked.reason || ''), /sks-invalid-explicit-managed-skill/);
    assert.doesNotMatch(JSON.stringify(blocked), new RegExp(hostileName, 'i'));
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('persisted explicit alias skills survive compact resume and PreToolUse without turning an ordinary child into Naruto', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-explicit-skill-state-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const sessionKey = 'explicit-fast-off-session';
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
    await fsp.mkdir(home, { recursive: true });
    const installed = await installGlobalSkills(home);
    assert.equal(installed.ok, true);

    const prepared: any = await prepareRoute(root, '$Fast-Off', {}, { sessionKey });
    const state: any = await loadStateForSession(root, sessionKey);
    assert.ok(prepared.mission_id);
    assert.deepEqual(state.required_skills, ['sks-fast-mode', 'sks-honest-mode', 'sks-fast-off']);
    const context = JSON.parse(await fsp.readFile(
      path.join(missionDir(root, prepared.mission_id), 'route-context.json'),
      'utf8'
    ));
    assert.deepEqual(context.required_skills, state.required_skills);

    const skillPath = path.join(home, '.agents', 'skills', 'sks-fast-off', 'SKILL.md');
    const sessionStart: any = await evaluateHookPayload('session-start', {
      cwd: root,
      session_id: sessionKey,
      hook_event_name: 'SessionStart'
    }, { root, state });
    assert.match(String(sessionStart.additionalContext || ''), new RegExp(escapeRegExp(skillPath)));

    for (const hook of ['pre-compact', 'post-compact'] as const) {
      const compact: any = await evaluateHookPayload(hook, {
        cwd: root,
        session_id: sessionKey,
        hook_event_name: hook
      }, { root, state });
      assert.match(String(compact.systemMessage || ''), /refresh active managed-skill paths/i);
      assert.deepEqual(state.required_skills, ['sks-fast-mode', 'sks-honest-mode', 'sks-fast-off']);
    }

    const preTool: any = await evaluateHookPayload('pre-tool', {
      cwd: root,
      session_id: sessionKey,
      turn_id: 'explicit-fast-off-tool-turn',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
      tool_use_id: 'explicit-fast-off-tool'
    }, { root, state });
    assert.equal(preTool.continue, true);
    assert.match(String(preTool.additionalContext || ''), new RegExp(escapeRegExp(skillPath)));

    const child: any = await evaluateHookPayload('subagent-start', {
      cwd: root,
      session_id: sessionKey,
      turn_id: 'explicit-fast-off-child-turn',
      agent_id: 'explicit-fast-off-child',
      agent_type: 'worker',
      hook_event_name: 'SubagentStart'
    }, { root, state });
    const normalized: any = normalizeHookResult('subagent-start', child);
    assert.doesNotMatch(String(normalized.hookSpecificOutput?.additionalContext || ''), new RegExp(escapeRegExp(skillPath)));
    assert.doesNotMatch(String(normalized.hookSpecificOutput?.additionalContext || ''), /SKS Naruto policy|Authoritative SKS skill sources/i);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('$MAD-SKS $Naruto persists both explicitly invoked managed skills', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-mad-naruto-skills-'));
  const root = path.join(fixture, 'project');
  const sessionKey = 'mad-naruto-explicit-skills';
  try {
    await fsp.mkdir(path.join(root, '.sneakoscope', 'wiki'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), JSON.stringify({
      attention: { use_first: [], hydrate_first: [] }
    }));
    const prepared: any = await prepareRoute(
      root,
      '$MAD-SKS $Naruto implement two independent safe fixes',
      {},
      { sessionKey }
    );
    const state: any = await loadStateForSession(root, sessionKey);
    assert.ok(prepared.mission_id);
    assert.ok(state.required_skills.includes('sks-mad-sks'));
    assert.ok(state.required_skills.includes('sks-naruto'));
    const context = JSON.parse(await fsp.readFile(
      path.join(missionDir(root, prepared.mission_id), 'route-context.json'),
      'utf8'
    ));
    assert.ok(context.required_skills.includes('sks-mad-sks'));
    assert.ok(context.required_skills.includes('sks-naruto'));
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('standalone Naruto parent attach restores the owning route alias for parent and child hooks', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-standalone-route-skills-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  const oldLaunch = process.env.SKS_NARUTO_PARENT_LAUNCH;
  const oldMission = process.env.SKS_NARUTO_PARENT_MISSION_ID;
  const oldRun = process.env.SKS_NARUTO_PARENT_WORKFLOW_RUN_ID;
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
    delete process.env.SKS_NARUTO_PARENT_WORKFLOW_RUN_ID;
    await fsp.mkdir(home, { recursive: true });
    const installed = await installGlobalSkills(home);
    assert.equal(installed.ok, true);
    await fsp.mkdir(path.join(root, '.sneakoscope', 'wiki'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), JSON.stringify({
      attention: { use_first: [], hydrate_first: [] }
    }));

    const cases = [
      ['$Release-Review audit the release read-only', 'sks-release-review'],
      ['$Work implement one bounded fix', 'sks-work'],
      ['$From-Chat-IMG implement the bounded screenshot request', 'sks-from-chat-img']
    ] as const;

    for (const [prompt, skillName] of cases) {
      const outerSession = `outer-${skillName}`;
      await prepareRoute(root, prompt, {}, { sessionKey: outerSession, parentModel: 'gpt-5.6-sol' });
      const outerState: any = await loadStateForSession(root, outerSession);
      assert.ok(outerState.required_skills.includes(skillName), prompt);
      process.env.SKS_NARUTO_PARENT_LAUNCH = '1';
      process.env.SKS_NARUTO_PARENT_MISSION_ID = outerState.mission_id;

      const childSession = `child-${skillName}`;
      const attached: any = await evaluateHookPayload('user-prompt-submit', {
        cwd: root,
        session_id: childSession,
        turn_id: `attach-${skillName}`,
        prompt: 'Continue the sealed standalone parent mission.'
      }, { root });
      const childState: any = await loadStateForSession(root, childSession);
      const skillPath = path.join(home, '.agents', 'skills', skillName, 'SKILL.md');
      assert.equal(attached.continue, true, prompt);
      assert.equal(attached.attached_parent_mission_id, outerState.mission_id, prompt);
      assert.ok(childState.required_skills.includes(skillName), prompt);
      assert.match(String(attached.additionalContext || ''), new RegExp(escapeRegExp(skillPath)), prompt);

      const started: any = await evaluateHookPayload('subagent-start', {
        cwd: root,
        session_id: childSession,
        turn_id: `subagent-${skillName}`,
        agent_id: `agent-${skillName}`,
        agent_type: 'worker',
        hook_event_name: 'SubagentStart'
      }, { root, state: childState });
      const normalized: any = normalizeHookResult('subagent-start', started);
      assert.match(
        String(normalized.hookSpecificOutput?.additionalContext || ''),
        new RegExp(escapeRegExp(skillPath)),
        prompt
      );
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    if (oldLaunch === undefined) delete process.env.SKS_NARUTO_PARENT_LAUNCH;
    else process.env.SKS_NARUTO_PARENT_LAUNCH = oldLaunch;
    if (oldMission === undefined) delete process.env.SKS_NARUTO_PARENT_MISSION_ID;
    else process.env.SKS_NARUTO_PARENT_MISSION_ID = oldMission;
    if (oldRun === undefined) delete process.env.SKS_NARUTO_PARENT_WORKFLOW_RUN_ID;
    else process.env.SKS_NARUTO_PARENT_WORKFLOW_RUN_ID = oldRun;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('standalone Naruto parent rejects a traversal mission id before reading escaped route context', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-standalone-route-skill-traversal-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const invalidMissionId = 'M-parent/../../../outside';
  const escapedDir = missionDir(root, invalidMissionId);
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  const oldLaunch = process.env.SKS_NARUTO_PARENT_LAUNCH;
  const oldMission = process.env.SKS_NARUTO_PARENT_MISSION_ID;
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
    process.env.SKS_NARUTO_PARENT_LAUNCH = '1';
    process.env.SKS_NARUTO_PARENT_MISSION_ID = invalidMissionId;
    await fsp.mkdir(home, { recursive: true });
    const installed = await installGlobalSkills(home);
    assert.equal(installed.ok, true);
    await fsp.mkdir(escapedDir, { recursive: true });
    await fsp.writeFile(path.join(escapedDir, 'route-context.json'), JSON.stringify({
      required_skills: ['sks-context7-docs']
    }));

    const result: any = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      session_id: 'standalone-traversal-session',
      turn_id: 'standalone-traversal-turn',
      prompt: 'Continue the sealed standalone parent mission.'
    }, { root });

    assert.equal(result.decision, 'block');
    assert.match(String(result.reason || ''), /sks-invalid-explicit-managed-skill/);
    assert.doesNotMatch(
      String(result.additionalContext || ''),
      new RegExp(escapeRegExp(path.join(home, '.agents', 'skills', 'sks-context7-docs', 'SKILL.md')))
    );
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(escapedDir, 'route-context.json'), 'utf8')), {
      required_skills: ['sks-context7-docs']
    });
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    if (oldLaunch === undefined) delete process.env.SKS_NARUTO_PARENT_LAUNCH;
    else process.env.SKS_NARUTO_PARENT_LAUNCH = oldLaunch;
    if (oldMission === undefined) delete process.env.SKS_NARUTO_PARENT_MISSION_ID;
    else process.env.SKS_NARUTO_PARENT_MISSION_ID = oldMission;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('standalone Naruto parent rejects a project .sneakoscope symlink without reading or writing externally', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-standalone-route-skill-project-symlink-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const external = path.join(fixture, 'external');
  const missionId = 'M-standalone-project-symlink';
  const externalMissionDir = path.join(external, 'missions', missionId);
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  const oldLaunch = process.env.SKS_NARUTO_PARENT_LAUNCH;
  const oldMission = process.env.SKS_NARUTO_PARENT_MISSION_ID;
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
    process.env.SKS_NARUTO_PARENT_LAUNCH = '1';
    process.env.SKS_NARUTO_PARENT_MISSION_ID = missionId;
    await fsp.mkdir(home, { recursive: true });
    const installed = await installGlobalSkills(home);
    assert.equal(installed.ok, true);
    await fsp.mkdir(root, { recursive: true });
    await fsp.mkdir(externalMissionDir, { recursive: true });
    await fsp.writeFile(path.join(externalMissionDir, 'route-context.json'), JSON.stringify({
      required_skills: ['sks-context7-docs']
    }));
    await fsp.writeFile(path.join(externalMissionDir, 'subagent-plan.json'), JSON.stringify({
      schema: 'sks.subagent-plan.v1',
      workflow: 'official_codex_subagent',
      mission_id: missionId,
      workflow_run_id: 'external-run',
      goal: 'No host capabilities requested.'
    }));
    await fsp.symlink(external, path.join(root, '.sneakoscope'));
    const before = await fsp.readdir(externalMissionDir);

    const result: any = await evaluateHookPayload('user-prompt-submit', {
      cwd: root,
      session_id: 'standalone-project-symlink-session',
      turn_id: 'standalone-project-symlink-turn',
      prompt: 'Continue the sealed standalone parent mission.'
    }, { root });

    assert.equal(result.decision, 'block');
    assert.match(String(result.reason || ''), /host_capability_parent_artifact_dir_unsafe/);
    assert.doesNotMatch(
      String(result.additionalContext || ''),
      new RegExp(escapeRegExp(path.join(home, '.agents', 'skills', 'sks-context7-docs', 'SKILL.md')))
    );
    assert.deepEqual((await fsp.readdir(externalMissionDir)).sort(), before.sort());
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    if (oldLaunch === undefined) delete process.env.SKS_NARUTO_PARENT_LAUNCH;
    else process.env.SKS_NARUTO_PARENT_LAUNCH = oldLaunch;
    if (oldMission === undefined) delete process.env.SKS_NARUTO_PARENT_MISSION_ID;
    else process.env.SKS_NARUTO_PARENT_MISSION_ID = oldMission;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});
