import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateHookPayloadOnce } from '../../hooks-runtime.js';
import { normalizeHookResult } from '../hook-io.js';
import { subagentSpawnPolicyBlockReason } from '../subagent-spawn-policy.js';
import { sealedSubagentRoutingContext } from '../subagent-context.js';

test('child spawns require Astra and a bounded context contract', () => {
  const input = { model: 'gpt-6-astra', reasoning_effort: 'high', fork_turns: 'none', message: 'Implement the assigned parser change.' };
  const payload = { tool_name: 'collaboration.spawn_agent', tool_input: input };
  assert.equal(subagentSpawnPolicyBlockReason(payload), null);
  assert.equal(subagentSpawnPolicyBlockReason({ ...payload, tool_input: { ...input, fork_turns: '3' } }), null);
  for (const model of [undefined, 'gpt-5.6-sol', 'gpt-5.6-luna', 'anthropic/claude-sonnet-4.5']) {
    assert.match(subagentSpawnPolicyBlockReason({ ...payload, tool_input: { ...input, model } })!, /must use gpt-6-astra/);
  }
  for (const fork_turns of [undefined, 'all']) {
    assert.match(subagentSpawnPolicyBlockReason({ ...payload, tool_input: { ...input, fork_turns } })!, /full-history\/default forks/);
  }
  assert.equal(subagentSpawnPolicyBlockReason({ tool_name: 'exec_command', tool_input: { cmd: 'echo spawn_agent' } }), null);
});

test('actual PreToolUse dispatch denies a non-Astra spawn on every repeated invocation', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-astra-spawn-'));
  try {
    const payload = {
      session_id: 'astra-parent', turn_id: 'turn-1', tool_use_id: 'spawn-1',
      tool_name: 'spawn_agent', tool_input: { model: 'gpt-5.6-sol', fork_turns: 'none', message: 'Implement the parser.' }
    };
    for (let i = 0; i < 2; i++) {
      const result = await evaluateHookPayloadOnce('pre-tool', payload, { root });
      const wire: any = normalizeHookResult('pre-tool', result);
      assert.equal(wire.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(Object.hasOwn(wire, 'continue'), false);
      assert.match(wire.hookSpecificOutput.permissionDecisionReason, /must use gpt-6-astra/);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('resumed old plans cannot reintroduce a non-Astra sealed profile', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-astra-resume-'));
  try {
    await fsp.writeFile(path.join(root, 'subagent-plan.json'), JSON.stringify({
      workflow: 'official_codex_subagent', agents: { worker: { routed_model: 'gpt-5.6-luna', routed_model_reasoning_effort: 'max' } }
    }));
    const context = await sealedSubagentRoutingContext(root, { agent_type: 'worker' });
    assert.match(context, /model: gpt-6-astra/);
    assert.match(context, /model_reasoning_effort: low/);
    assert.doesNotMatch(context, /gpt-5\.6/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
