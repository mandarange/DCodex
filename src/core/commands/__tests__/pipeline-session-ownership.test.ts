import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pipelineCommand } from '../pipeline-command.js';
import { createMission, setCurrent } from '../../mission.js';
import { resetVerificationProfileCache } from '../../verification-profile.js';

test('pipeline status and replanning use the calling session instead of the latest mirror', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-pipeline-owner-'));
  const priorCwd = process.cwd();
  const priorThread = process.env.CODEX_THREAD_ID;
  const priorProfile = process.env.SKS_VERIFICATION_PROFILE;
  const priorStandalone = process.env.SKS_NARUTO_STANDALONE_CLI;
  const priorLog = console.log;
  const output: string[] = [];
  try {
    const own = await createMission(root, { mode: 'sks', prompt: 'Improve the parser', sessionKey: 'caller' });
    await setCurrent(root, { mission_id: own.id, route: 'SKS', route_command: '$sks', prompt: 'Improve the parser' }, { sessionKey: 'caller' });
    await createMission(root, { mode: 'wiki', prompt: 'Refresh unrelated wiki', sessionKey: 'other' });
    process.chdir(root);
    process.env.CODEX_THREAD_ID = 'caller';
    process.env.SKS_NARUTO_STANDALONE_CLI = '0';
    process.env.SKS_VERIFICATION_PROFILE = 'essential';
    resetVerificationProfileCache();
    console.log = (value: unknown) => { output.push(String(value)); };
    await pipelineCommand(['status', '--json']);
    assert.equal(JSON.parse(output.pop()!).state.mission_id, own.id);
    await pipelineCommand(['plan', '--no-agents', '--json']);
    const result = JSON.parse(output.pop()!);
    assert.equal(result.mission_id, own.id);
    assert.equal(result.plan.route.stop_gate, 'none');
    assert.equal(result.plan.task_profile, 'bounded-work');
    const plan = JSON.parse(await fs.readFile(path.join(own.dir, 'pipeline-plan.json'), 'utf8'));
    assert.equal(plan.mission_id, own.id);
  } finally {
    console.log = priorLog;
    process.chdir(priorCwd);
    if (priorThread === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = priorThread;
    if (priorProfile === undefined) delete process.env.SKS_VERIFICATION_PROFILE; else process.env.SKS_VERIFICATION_PROFILE = priorProfile;
    if (priorStandalone === undefined) delete process.env.SKS_NARUTO_STANDALONE_CLI; else process.env.SKS_NARUTO_STANDALONE_CLI = priorStandalone;
    resetVerificationProfileCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});
