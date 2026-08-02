import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NARUTO_REQUESTED_SUBAGENTS, OFFICIAL_SUBAGENT_EXECUTION_STAGE_ID } from '../../dist/core/agents/agent-schema.js';
import { normalizeOfficialSubagentPolicy, officialSubagentPipelineStage, routeRequiresOfficialSubagents } from '../../dist/core/agents/agent-plan.js';
import { routePrompt } from '../../dist/core/routes.js';

test('official subagent policy is explicit and task-profile aware', () => {
  assert.equal(routeRequiresOfficialSubagents('$Naruto', { task: 'implement feature' }), true);
  assert.equal(routeRequiresOfficialSubagents('$Research', { task: 'investigate mechanism' }), false);
  assert.equal(routeRequiresOfficialSubagents('$DFix', { task: 'tiny copy edit' }), false);
  assert.equal(routeRequiresOfficialSubagents(routePrompt('work on the parser'), { task: 'work on the parser' }), false);
  assert.equal(routeRequiresOfficialSubagents(routePrompt('$Work'), { task: '$Work' }), true);
  const policy = normalizeOfficialSubagentPolicy('$Naruto', 'implement feature', {});
  assert.equal(policy.stage_id, OFFICIAL_SUBAGENT_EXECUTION_STAGE_ID);
  assert.equal(policy.requested_subagents, DEFAULT_NARUTO_REQUESTED_SUBAGENTS);
  assert.equal(policy.backend, 'official-codex-subagent');
  assert.equal(Object.hasOwn(policy, 'agent_count'), false);
  assert.equal(Object.hasOwn(policy, 'deprecated_fields'), false);
});

test('official subagent execution stage declares thread budget and event evidence', () => {
  const stage = officialSubagentPipelineStage(normalizeOfficialSubagentPolicy('$Naruto', 'fixture', {}));
  assert.equal(stage.id, 'official_subagent_execution');
  assert.equal(stage.backend, 'official-codex-subagent');
  assert.equal(stage.max_threads, 256);
  assert.equal(stage.max_depth, 1);
  assert.equal(stage.read_only, false);
  assert.match(stage.write_policy, /bounded workspace-write/);
  assert.ok(stage.outputs.includes('subagent-evidence.json'));
  assert.ok(stage.outputs.includes('subagent-parent-summary.json'));
  assert.equal(stage.outputs.includes('verification-summary.json'), false);
  assert.equal(Object.hasOwn(stage, 'agent_count'), false);
  assert.equal(Object.hasOwn(stage, 'deprecated_fields'), false);
});
