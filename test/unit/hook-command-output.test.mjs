// First import: hook evaluation consults the managed skill availability guard
// under $HOME/.agents/skills — isolate the home, then seed the managed skills
// so the guard reflects a healthy install instead of the operator's real one.
import '../../dist/core/__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../../dist/core/fsx.js';

const { reconcileSkills } = await import('../../dist/core/init/skills.js');
await reconcileSkills({ targetDir: path.join(os.homedir(), '.agents', 'skills'), scope: 'global', fix: true });

const hookBin = path.join(process.cwd(), 'dist', 'bin', 'sks.js');

async function runHook(name, payload) {
  const result = await runProcess(process.execPath, [hookBin, 'hook', name], {
    cwd: process.cwd(),
    input: JSON.stringify({ cwd: process.cwd(), ...payload }),
    timeoutMs: 15000,
    maxOutputBytes: 128 * 1024
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('hook command emits Codex canonical UserPromptSubmit output shape', async () => {
  const output = await runHook('user-prompt-submit', { prompt: '이 변경 검수해줘' });
  assert.equal(output.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.equal(typeof output.hookSpecificOutput.additionalContext, 'string');
  assert.ok(!Object.hasOwn(output, 'additionalContext'));
});

test('hook command emits Codex canonical PreToolUse deny output shape', async () => {
  const output = await runHook('pre-tool', {
    tool_name: 'Bash',
    tool_input: { command: 'psql -c "DROP TABLE users"' }
  });
  assert.equal(output.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(typeof output.hookSpecificOutput.permissionDecisionReason, 'string');
  assert.ok(!Object.hasOwn(output, 'reason'));
});

test('PreToolUse hook denies recursive SKS route command in agent worker context', async () => {
  const output = await runHook('pre-tool', {
    tool_name: 'Bash',
    tool_input: { command: 'sks naruto run "nested route"', env: { SKS_AGENT_WORKER: '1' } }
  });
  assert.equal(output.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput?.permissionDecisionReason, /recursion guard/i);
});
