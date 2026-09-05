import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentRoster } from '../../dist/core/agents/agent-roster.js';
import { decideAgentEffort, decideAgentWorkerModel, decideOfficialSubagentModel } from '../../dist/core/agents/agent-effort-policy.js';

test('native agent effort policy assigns high effort to safety and release lanes', () => {
  const safety = decideAgentEffort({
    persona: { id: 'agent_security', role: 'safety', stable_id: 'security', risk_focus: 'secret leakage' },
    prompt: 'simple docs note'
  });
  const release = decideAgentEffort({
    persona: { id: 'agent_release', role: 'release', stable_id: 'release', risk_focus: 'publish metadata' },
    prompt: 'publish release readiness'
  });

  assert.equal(safety.reasoning_effort, 'high');
  assert.equal(release.reasoning_effort, 'high');
  assert.equal(safety.model, '');
  assert.equal(safety.model_reasoning_effort, 'high');
  assert.equal(safety.model_tier, 'codex-selected-high');
  assert.equal(safety.dynamic, true);
  assert.ok(safety.escalation_triggers.some((trigger) => trigger.includes('DB/security/release')));
});

test('native agent effort policy changes effort without changing the Codex-selected model', () => {
  const simple = decideAgentEffort({
    persona: { id: 'agent_simple', role: 'implementer', stable_id: 'simple', write_policy: 'bounded patch lease' },
    prompt: 'simple one-line typo fix'
  });
  const ordinary = decideAgentEffort({
    persona: { id: 'agent_regular', role: 'implementer', stable_id: 'regular', write_policy: 'bounded patch lease' },
    prompt: 'add a feature to the route parser'
  });

  assert.equal(simple.model, '');
  assert.equal(simple.model_reasoning_effort, 'low');
  assert.equal(simple.model_tier, 'codex-selected-low');
  assert.equal(ordinary.model, '');
  assert.equal(ordinary.model_reasoning_effort, 'medium');
  assert.equal(ordinary.model_tier, 'codex-selected-medium');
});

test('native agent roster records per-agent dynamic effort policy', () => {
  const roster = buildAgentRoster({ agents: 5, concurrency: 2, prompt: 'multi-session release DB safety orchestration' });

  assert.equal(roster.effort_policy.schema, 'sks.agent-effort-policy.v1');
  assert.equal(roster.effort_policy.dynamic, true);
  assert.equal(roster.roster.length, 5);
  assert.equal(roster.concurrency, 2);
  assert.ok(roster.roster.every((agent) => agent.reasoning_effort && agent.reasoning_profile));
  assert.ok(roster.roster.every((agent) => agent.model === '' && agent.model_tier && agent.model_profile));
  assert.ok(roster.roster.every((agent) => ['low', 'medium', 'high'].includes(agent.model_reasoning_effort)));
  assert.ok(roster.roster.some((agent) => agent.reasoning_effort === 'high'));
  assert.ok(roster.roster.some((agent) => agent.model_tier === 'codex-selected-high'));
  assert.ok(roster.roster.every((agent) => agent.dynamic_effort_policy.escalation_triggers.length > 0));
});

test('native agent model policy preserves an arbitrary future Codex model identifier', () => {
  const decision = decideAgentWorkerModel({
    mainModel: 'future-codex-model',
    effort: 'high',
    prompt: 'release architecture review',
    role: 'release'
  });
  assert.equal(decision.model, 'future-codex-model');
  assert.equal(decision.model_reasoning_effort, 'high');
  assert.equal(decision.model_tier, 'future-codex-model-high');
  assert.equal(decision.reason, 'explicit_model_preserved');
});

test('legacy GLM mode flags do not replace the user-selected OpenRouter model', () => {
  const previous = process.env.SKS_GLM_MODE;
  process.env.SKS_GLM_MODE = '1';
  try {
    const decision = decideAgentWorkerModel({
      mainModel: 'anthropic/claude-sonnet-4.5',
      effort: 'high',
      prompt: 'review provider routing',
      role: 'reviewer'
    });
    assert.equal(decision.model, 'anthropic/claude-sonnet-4.5');
    assert.equal(decision.model_reasoning_effort, 'high');
    assert.equal(decision.reason, 'explicit_model_preserved');
  } finally {
    if (previous === undefined) delete process.env.SKS_GLM_MODE;
    else process.env.SKS_GLM_MODE = previous;
  }
});

test('native agent model policy keeps GLM mode on GLM 5.2 with GLM efforts', () => {
  const simple = decideAgentWorkerModel({
    mainModel: 'z-ai/glm-5.2',
    effort: 'low',
    prompt: 'simple one-line docs fix',
    role: 'implementer'
  });
  const ordinary = decideAgentWorkerModel({
    mainModel: 'z-ai/glm-5.2',
    effort: 'medium',
    prompt: 'add a route parser feature',
    role: 'implementer'
  });
  const risky = decideAgentWorkerModel({
    mainModel: 'z-ai/glm-5.2',
    effort: 'high',
    prompt: 'review database migration safety',
    role: 'safety'
  });

  assert.equal(simple.model, 'z-ai/glm-5.2');
  assert.equal(simple.model_reasoning_effort, 'minimal');
  assert.equal(simple.model_tier, 'glm-5.2-minimal');
  assert.equal(ordinary.model, 'z-ai/glm-5.2');
  assert.equal(ordinary.model_reasoning_effort, 'low');
  assert.equal(ordinary.model_tier, 'glm-5.2-low');
  assert.equal(risky.model, 'z-ai/glm-5.2');
  assert.equal(risky.model_reasoning_effort, 'high');
  assert.equal(risky.model_tier, 'glm-5.2-high');
});

test('official subagents use the fixed four-profile matrix', () => {
  const bounded = decideOfficialSubagentModel({ persona: { role: 'worker' }, prompt: 'exact one-line single-file mechanical rename' });
  const implementation = decideOfficialSubagentModel({ persona: { role: 'implementation_specialist' }, prompt: 'implement parser logic' });
  const context = decideOfficialSubagentModel({ persona: { role: 'browser_use_operator' }, prompt: 'collect Chrome browser evidence' });
  const review = decideOfficialSubagentModel({ persona: { role: 'ux' }, prompt: 'review the UI' });
  assert.equal(bounded.model, 'gpt-5.6-luna');
  assert.equal(bounded.model_reasoning_effort, 'max');
  assert.equal(implementation.model, 'gpt-6-astra');
  assert.equal(implementation.model_reasoning_effort, 'high');
  assert.equal(context.model, 'gpt-6-astra');
  assert.equal(context.model_reasoning_effort, 'medium');
  assert.equal(review.model, 'gpt-6-astra');
  assert.equal(review.model_reasoning_effort, 'max');
});
