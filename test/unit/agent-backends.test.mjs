import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcessAgent } from '../../dist/core/agents/agent-runner-process.js';

const agent = { id: 'agent_backend', session_id: 'agent_backend-session', persona_id: 'agent_backend' };
const slice = { id: 'slice-backend', description: 'backend fixture' };

test('process backend records pid, exit code, stdout, stderr, and timeout fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-agent-process-backend-'));
  const result = await runProcessAgent(agent, slice, {
    missionId: 'M-backend',
    agentRoot: root,
    cwd: root,
    command: [process.execPath, '-e', 'console.log("process-ok"); console.error("process-err")']
  });
  assert.equal(result.status, 'done');
  const report = JSON.parse(await fs.readFile(path.join(root, result.artifacts[0]), 'utf8'));
  assert.equal(report.backend, 'process');
  assert.equal(typeof report.pid, 'number');
  assert.equal(report.exit_code, 0);
  assert.match(report.stdout_tail, /process-ok/);
  assert.match(report.stderr_tail, /process-err/);
  assert.equal(report.timed_out, false);
});
