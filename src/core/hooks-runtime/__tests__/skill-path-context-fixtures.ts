import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { evaluateHookPayload, normalizeHookResult } from '../../hooks-runtime.js';
import { initProject } from '../../init.js';
import { installGlobalSkills } from '../../init/skills.js';
import { missionDir, setCurrent } from '../../mission.js';
import { sha256 } from '../../fsx.js';
import {
  validateCompactSemanticOutput,
  validatePreToolUseSemanticOutput,
  validateSessionStartSemanticOutput,
  validateSubagentStartSemanticOutput
} from '../../codex-compat/codex-hook-semantic-validator.js';
import { validateCodexHookOutput } from '../../codex-compat/codex-hook-schema.js';
import {
  SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME
} from '../subagent-skill-availability.js';
export { escapeRegExp } from '../../text/regex.js';

export {
  assert,
  evaluateHookPayload,
  fsp,
  initProject,
  installGlobalSkills,
  missionDir,
  normalizeHookResult,
  os,
  path,
  setCurrent,
  sha256,
  SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME,
  test,
  validateCodexHookOutput,
  validateCompactSemanticOutput,
  validatePreToolUseSemanticOutput,
  validateSessionStartSemanticOutput,
  validateSubagentStartSemanticOutput
};

export async function writeManagedSkill(root: string, name: string) {
  const file = path.join(root, name, 'SKILL.md');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, [
    '---',
    `name: ${name}`,
    'description: fixture',
    '---',
    '',
    `<!-- BEGIN SKS MANAGED SKILL v-test name=${name} -->`,
    ''
  ].join('\n'));
  return file;
}

export async function installCurrentManagedSkill(home: string, name: string) {
  const seedHome = path.join(home, '.packaged-skill-seed');
  await fsp.mkdir(seedHome, { recursive: true });
  const install = await installGlobalSkills(seedHome);
  assert.equal(install.ok, true);
  const source = path.join(seedHome, '.agents', 'skills', name, 'SKILL.md');
  const file = path.join(home, '.agents', 'skills', name, 'SKILL.md');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.copyFile(source, file);
  return file;
}

export async function writeTranscript(home: string, threadId: string, officialSubagent: boolean) {
  const file = path.join(home, '.codex', 'sessions', 'fixture', `rollout-${threadId}.jsonl`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: threadId,
      source: officialSubagent ? { subagent: { thread_spawn: { parent_thread_id: 'parent-thread' } } } : {}
    }
  })}\n`);
  return file;
}

export function subagentPayload(agentId: string, transcriptPath: string | null = null) {
  return {
    cwd: '/tmp/project',
    session_id: 'shared-parent-session',
    turn_id: `turn-${agentId}`,
    agent_id: agentId,
    agent_type: 'worker',
    hook_event_name: 'SubagentStart',
    model: 'gpt-5.6-luna',
    permission_mode: 'default',
    transcript_path: transcriptPath
  };
}

export function preToolPayload(
  transcriptPath: string | null,
  threadId = 'parent-thread',
  sessionId = 'shared-parent-session'
) {
  return {
    cwd: '/tmp/project',
    hook_event_name: 'PreToolUse',
    model: 'gpt-5.6-luna',
    permission_mode: 'default',
    session_id: sessionId,
    tool_input: { command: 'pwd' },
    tool_name: 'Bash',
    tool_use_id: 'tool-skill-availability',
    transcript_path: transcriptPath,
    turn_id: `turn-${threadId}`
  };
}

export async function writeOfficialSubagentPlan(
  root: string,
  missionId: string,
  workflowRunId: string,
  requestedSubagents = 1
) {
  const dir = missionDir(root, missionId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
    schema: 'sks.subagent-plan.v1',
    workflow: 'official_codex_subagent',
    mission_id: missionId,
    workflow_run_id: workflowRunId,
    requested_subagents: requestedSubagents
  }));
  return dir;
}

export async function homeAdmissionGuardRoot(home: string, root: string) {
  return path.join(
    home,
    '.sneakoscope',
    'guards',
    'subagent-skill-availability',
    sha256(await fsp.realpath(root))
  );
}

export function admissionBindingState(missionId: string, workflowRunId: string) {
  return {
    mission_id: missionId,
    official_subagent_run_id: workflowRunId
  };
}
