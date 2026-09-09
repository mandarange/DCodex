import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentRoster } from '../../dist/core/agents/agent-roster.js';
import { buildAgentEffortPolicy, decideAgentEffort, decideAgentWorkerModel, decideOfficialSubagentModel } from '../../dist/core/agents/agent-effort-policy.js';

test('native agent effort policy routes safety and release judgment to Astra Max', () => {
  for (const role of ['safety', 'release']) {
    const decision = decideAgentEffort({ persona: { role }, prompt: 'review security and release readiness' });
    assert.equal(decision.model, 'gpt-6-astra');
    assert.equal(decision.reasoning_effort, 'max');
    assert.equal(decision.model_reasoning_effort, 'max');
    assert.equal(decision.model_tier, 'gpt-6-astra-max');
    assert.equal(decision.dynamic, true);
  }
});

test('native and official agents share task-weighted Astra effort profiles', () => {
  const cases = [
    ['worker', 'exact one-line single-file mechanical rename', 'low'],
    ['browser_use_operator', 'collect Chrome browser evidence', 'medium'],
    ['implementation_specialist', 'implement parser logic', 'high'],
    ['security_reviewer', 'review the security boundary', 'max']
  ];
  for (const [role, prompt, effort] of cases) {
    for (const decide of [decideAgentEffort, decideOfficialSubagentModel]) {
      const result = decide({ persona: { role }, prompt });
      assert.equal(result.model, 'gpt-6-astra', role);
      assert.equal(result.reasoning_effort, effort, role);
      assert.equal(result.model_reasoning_effort, effort, role);
    }
  }
});

test('native agent roster records the Astra-only effort policy', () => {
  const roster = buildAgentRoster({ agents: 5, concurrency: 2, prompt: 'multi-session release DB safety orchestration' });
  assert.equal(roster.effort_policy.schema, 'sks.agent-effort-policy.v1');
  assert.equal(roster.effort_policy.dynamic, true);
  assert.equal(roster.roster.length, 5);
  assert.equal(roster.concurrency, 2);
  assert.deepEqual(roster.effort_policy.model_constraint, ['gpt-6-astra']);
  assert.deepEqual(roster.effort_policy.allowed_efforts, ['low', 'medium', 'high', 'max']);
  assert.ok(roster.roster.every((agent) => agent.model === 'gpt-6-astra' && agent.model_tier && agent.model_profile));
  assert.ok(roster.roster.every((agent) => ['low', 'medium', 'high', 'max'].includes(agent.model_reasoning_effort)));
  assert.ok(roster.roster.every((agent) => agent.dynamic_effort_policy.escalation_triggers.length > 0));
  assert.deepEqual(buildAgentEffortPolicy().model_constraint, ['gpt-6-astra']);
});

test('parent and provider model inputs never replace the child Astra model', () => {
  for (const mainModel of ['future-codex-model', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'z-ai/glm-5.2', 'anthropic/claude-sonnet-4.5']) {
    const decision = decideAgentWorkerModel({ mainModel, effort: 'high', prompt: 'implement parser logic', role: 'implementation_specialist' });
    assert.equal(decision.model, 'gpt-6-astra', mainModel);
    assert.equal(decision.model_reasoning_effort, 'high', mainModel);
    assert.equal(decision.model_tier, 'gpt-6-astra-high', mainModel);
  }
});

test('environment model selections cannot escape the child Astra policy and remain unchanged', () => {
  const keys = ['SKS_GLM_MODE', 'SKS_CODEX_MODEL', 'CODEX_MODEL'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { SKS_GLM_MODE: '1', SKS_CODEX_MODEL: 'z-ai/glm-5.2', CODEX_MODEL: 'anthropic/claude-sonnet-4.5' });
  try {
    for (const [prompt, effort] of [
      ['exact one-line single-file mechanical rename', 'low'],
      ['Read the documentation and scan the repository', 'medium'],
      ['Implement the parser logic', 'high'],
      ['Review database migration safety', 'max']
    ]) {
      const decision = decideAgentWorkerModel({ prompt });
      assert.equal(decision.model, 'gpt-6-astra', prompt);
      assert.equal(decision.model_reasoning_effort, effort, prompt);
    }
    assert.equal(process.env.SKS_CODEX_MODEL, 'z-ai/glm-5.2');
    assert.equal(process.env.CODEX_MODEL, 'anthropic/claude-sonnet-4.5');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
