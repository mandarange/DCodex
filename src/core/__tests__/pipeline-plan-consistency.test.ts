import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPipelinePlan, validatePipelinePlan } from '../pipeline-internals/runtime-core.js';
import { routePrompt, subagentExecutionPolicyText } from '../routes.js';

test('Naruto plan uses canonical official subagent stages without legacy intake commands', () => {
  const missionId = 'M-20260711-test';
  const plan: any = buildPipelinePlan({
    route: routePrompt('$Naruto'),
    task: 'implement and verify the tool recovery flow',
    missionId,
    ambiguity: { required: true, auto_sealed: true }
  });

  assert.equal(plan.stages.filter((stage: any) => stage.id === 'native_agent_intake').length, 0);
  assert.ok(plan.stages.some((stage: any) => stage.id === 'subagent_plan'));
  assert.ok(plan.stages.some((stage: any) => stage.id === 'official_subagent_execution'));
  assert.ok(plan.stages.some((stage: any) => stage.id === 'parent_integration'));
  assert.equal(plan.ambiguity_gate.status, 'auto_sealed');
  assert.equal(plan.route.subagents_required, true);
  assert.equal(plan.route.native_sessions_required, false);

  const actions = plan.next_actions.join('\n');
  assert.match(actions, /read subagent-plan\.json/i);
  assert.match(actions, /official Codex subagent workflow/i);
  assert.doesNotMatch(actions, /sks agent run|clone roster|verification DAG/i);

  assert.equal(plan.verification_budget, 'affected');
  assert.ok(plan.verification.some((command: string) => /official subagent evidence/i.test(command)));
  assert.ok(!plan.verification.some((command: string) => /packcheck|selftest/i.test(command)));
});

test('specialized parallel routes use one official subagent fanout without legacy intake', () => {
  for (const task of [
    '$DB --agents 2 audit all schemas in parallel',
    '$PPT --agents 3 build independent slide sections in parallel'
  ]) {
    const plan: any = buildPipelinePlan({ route: routePrompt(task), task });
    assert.equal(plan.route.subagents_required, true, task);
    assert.equal(plan.official_subagents.required, true, task);
    assert.ok(plan.official_subagents.requested_subagents > 0, task);
    assert.equal('agent_intake' in plan, false, task);
    assert.equal(plan.stages.filter((stage: any) => stage.id === 'native_agent_intake').length, 0, task);
    assert.equal(plan.stages.filter((stage: any) => stage.id === 'official_subagent_execution').length, 1, task);
    assert.doesNotMatch(plan.next_actions.join('\n'), /sks agent run/i, task);
  }
});

test('route-owned QA execution and official Release Review never activate two fanout owners', () => {
  const qaTask = '$QA-LOOP --agents 5 dogfood the API in parallel';
  const qa: any = buildPipelinePlan({ route: routePrompt(qaTask), task: qaTask });
  assert.equal(qa.route.subagents_required, false);
  assert.equal(qa.stages.some((stage: any) => stage.id === 'official_subagent_execution'), false);
  assert.equal(qa.official_subagents.required, false);
  assert.equal(qa.official_subagents.requested_subagents, 0);
  assert.equal('agent_intake' in qa, false);

  const releaseTask = '$Release-Review --agents 5 audit the release';
  const release: any = buildPipelinePlan({ route: routePrompt(releaseTask), task: releaseTask });
  assert.equal(release.route.subagents_required, true);
  assert.equal(release.official_subagents.required, true);
  assert.ok(release.official_subagents.requested_subagents > 0);
  assert.equal('agent_intake' in release, false);
  assert.equal(release.stages.filter((stage: any) => stage.id === 'official_subagent_execution').length, 1);
  assert.doesNotMatch(release.next_actions.join('\n'), /sks agent run/i);
});

test('implicit bounded Naruto routing remains parent-owned without orchestration overhead', () => {
  for (const task of ['work on the parser', '로그인 버그 수정해줘', 'Implement the route parser']) {
    const routed: any = routePrompt(task);
    assert.equal(routed.explicit_invocation, false, task);
    const plan: any = buildPipelinePlan({ route: routed, task });
    assert.equal(plan.route.subagents_required, false, task);
    assert.equal(plan.official_subagents.required, false, task);
    assert.equal(plan.official_subagents.requested_subagents, 0, task);
    assert.equal('agent_intake' in plan, false, task);
    assert.equal(plan.stages.some((stage: any) => stage.id === 'native_agent_intake'), false, task);
    assert.equal(plan.stages.some((stage: any) => stage.id === 'official_subagent_execution'), false, task);
  }

  const explicitWorkRoute: any = routePrompt('$Work');
  assert.equal(explicitWorkRoute.explicit_invocation, true);
  const explicitWork: any = buildPipelinePlan({ route: explicitWorkRoute, task: '$Work' });
  assert.equal(explicitWork.route.subagents_required, true);
  assert.equal(explicitWork.official_subagents.required, true);
  assert.ok(explicitWork.official_subagents.requested_subagents > 0);
  assert.equal('agent_intake' in explicitWork, false);
  assert.equal(explicitWork.stages.some((stage: any) => stage.id === 'native_agent_intake'), false);
});

test('ordinary local bugfixes do not inherit an automatic web-scout stage', () => {
  const task = '로그인 버그 수정해줘';
  const plan: any = buildPipelinePlan({ route: routePrompt(task), task });

  assert.equal(plan.stages.some((stage: any) => stage.id === 'solution_scout'), false);
  assert.doesNotMatch(plan.next_actions.join('\n'), /Solution Scout|web search for similar fixes/i);
  assert.equal('lean_decision' in plan, false);
});

test('subagent policy uses official natural-language delegation without unstable tool contracts', () => {
  const text = subagentExecutionPolicyText(routePrompt('$Naruto'), 'implement the repair');
  assert.match(text, /Codex subagent workflow/i);
  assert.match(text, /SubagentStart\/SubagentStop/i);
  assert.match(text, /wait for all requested agent threads/i);
  assert.doesNotMatch(text, /functions\.exec|functions\.collaboration\.spawn_agent|native multi-session/i);
});

test('pipeline gate and verification budgets follow the task profile', () => {
  const cases = [
    { task: 'hi', gate: 'none', limit: 0, verification: 'none' },
    { task: 'README 오타 고쳐줘', gate: 'minimal', limit: 1, verification: 'single-check' },
    { task: '로그인 버그 수정해줘', gate: 'scoped', limit: 2, verification: 'affected' },
    { task: '여러 패키지를 병렬 검토해줘', gate: 'scoped', limit: 2, verification: 'affected' },
    { task: 'Edit multiple files in parallel', gate: 'scoped', limit: 3, verification: 'affected' },
    { task: 'Fix the database migration', gate: 'full', limit: 4, verification: 'confidence' }
  ];
  for (const row of cases) {
    const plan: any = buildPipelinePlan({ route: routePrompt(row.task), task: row.task });
    assert.equal(plan.gate_profile, row.gate, row.task);
    assert.equal(plan.gate_budget.blocking_gate_limit, row.limit, row.task);
    assert.ok(plan.gate_budget.blocking_gate_count <= row.limit, row.task);
    assert.equal(plan.gate_budget.blocking_gate_count, plan.gate_budget.blocking_gate_ids.length, row.task);
    assert.ok(plan.gate_budget.blocking_stage_count >= plan.gate_budget.blocking_gate_count, row.task);
    assert.ok(plan.stages.every((stage: any) => typeof stage.blocking === 'boolean'), row.task);
    assert.equal(plan.verification_budget, row.verification, row.task);
    assert.equal(validatePipelinePlan(plan).ok, true, row.task);
  }
});

test('pipeline validation fails closed when actual blocking stages exceed the task-profile limit', () => {
  const plan: any = buildPipelinePlan({
    route: routePrompt('README 오타 고쳐줘'),
    task: 'README 오타 고쳐줘'
  });

  assert.equal(plan.task_profile, 'tiny-change');
  assert.equal(plan.gate_budget.blocking_gate_limit, 1);
  plan.stages.push({ id: 'safety_gate', status: 'keep', reason: 'tampered_extra_blocking_gate', blocking: true, blocking_gate: 'safety' });

  const validation = validatePipelinePlan(plan);
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.includes('gate_budget.blocking_gate_limit_exceeded:2>1'));
  assert.ok(validation.issues.includes('gate_budget.blocking_gate_count'));
  assert.ok(validation.issues.includes('gate_budget.blocking_stage_count'));
  assert.ok(validation.issues.includes('gate_budget.blocking_gate_ids'));
});

test('independent stop blockers are represented while sharing the bounded canonical gate groups', () => {
  const task = '$DB --agents 5 conduct a parallel migration safety review';
  const plan: any = buildPipelinePlan({ route: routePrompt(task), task });
  for (const id of [
    'ssot_guard',
    'triwiki_use_first',
    'triwiki_validate_before_final',
    'subagent_plan',
    'official_subagent_execution',
    'parent_integration',
    'route_materialization',
    'work_order_coverage',
    'reflection'
  ]) {
    const stage = plan.stages.find((candidate: any) => candidate.id === id);
    assert.ok(stage, id);
    assert.equal(stage.blocking, true, id);
    assert.ok(stage.blocking_gate, id);
  }
  assert.ok(plan.gate_budget.blocking_stage_count > plan.gate_budget.blocking_gate_count);
  assert.ok(plan.gate_budget.blocking_gate_count <= plan.gate_budget.blocking_gate_limit);
  assert.equal(validatePipelinePlan(plan).ok, true);
});

test('pipeline validation rejects a declared gate budget that is looser than the task-profile SSOT', () => {
  const plan: any = buildPipelinePlan({
    route: routePrompt('로그인 버그 수정해줘'),
    task: '로그인 버그 수정해줘'
  });

  plan.gate_budget.blocking_gate_limit = 99;
  const validation = validatePipelinePlan(plan);
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.includes('gate_budget.blocking_gate_limit'));
});

test('pipeline validation requires every profile-mandated high-risk gate and active status', () => {
  const missing: any = buildPipelinePlan({
    route: routePrompt('DB migration 적용해줘'),
    task: 'DB migration 적용해줘'
  });

  assert.equal(missing.task_profile, 'high-risk');
  missing.stages = missing.stages.filter((stage: any) => ![
    'ambiguity_gate',
    'safety_gate',
    'ownership',
    'listed_verification'
  ].includes(stage.id));
  missing.gate_budget.blocking_gate_count = 0;
  const missingValidation = validatePipelinePlan(missing);
  assert.equal(missingValidation.ok, false);
  for (const id of ['ambiguity_gate', 'safety_gate', 'ownership', 'listed_verification']) {
    assert.ok(missingValidation.issues.includes(`stages.required_count:${id}:0`), id);
  }

  const inactive: any = buildPipelinePlan({
    route: routePrompt('DB migration 적용해줘'),
    task: 'DB migration 적용해줘'
  });
  const safety = inactive.stages.find((stage: any) => stage.id === 'safety_gate');
  safety.status = 'skipped';
  inactive.gate_budget.blocking_gate_count = 3;
  const inactiveValidation = validatePipelinePlan(inactive);
  assert.equal(inactiveValidation.ok, false);
  assert.ok(inactiveValidation.issues.includes('stages.required_inactive:safety_gate:skipped'));
});
