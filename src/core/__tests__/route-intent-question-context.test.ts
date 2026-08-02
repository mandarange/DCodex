import test from 'node:test';
import assert from 'node:assert/strict';
import { narutoDecisionForRoute, routePrompt, routeRequiresSubagents } from '../routes.js';

const cases = [
  { prompt: '이거 왜 안 고쳐져? 로그인 버그 수정해줘', expectedRoute: 'Naruto', reason: 'direct_work' },
  { prompt: 'Can you fix the login bug?', expectedRoute: 'Naruto', reason: 'direct_work' },
  { prompt: '왜 모든 물음표를 answer로 보내? 이 라우팅 고쳐줘', expectedRoute: 'Naruto', reason: 'question_shaped_directive' },
  { prompt: 'How do I fix a typo in README?', expectedRoute: 'Answer', reason: 'answer_only' },
  { prompt: '이 함수가 왜 이렇게 동작해?', expectedRoute: 'Answer', reason: 'answer_only' },
  { prompt: '이거 가능한지 확인하고 문제 있으면 고쳐줘', expectedRoute: 'Naruto', reason: 'conditional_work' },
  { prompt: 'Could you update package version and prepare release?', expectedRoute: 'Naruto', reason: 'direct_work' },
  { prompt: '이 문구 오타만 고쳐줄 수 있어?', expectedRoute: 'DFix', reason: 'tiny_direct_fix' },
] as const;

test('question-shaped prompts route by intent instead of question mark shape', () => {
  for (const row of cases) {
    const route = routePrompt(row.prompt);
    assert.equal(route?.id, row.expectedRoute, row.prompt);
    assert.ok(
      Array.isArray(route?.intent_scores?.reasons) && route.intent_scores.reasons.includes(row.reason),
      `${row.prompt} should expose route reason ${row.reason}`
    );
  }
});

test('greetings and bounded work stay parent-owned while explicit parallel work requires subagents', () => {
  assert.equal(routePrompt('hi'), null);
  assert.equal(routePrompt('이 함수 설명해줘')?.id, 'Answer');
  const bounded = routePrompt('로그인 버그 수정해줘');
  assert.equal(routeRequiresSubagents(bounded, '로그인 버그 수정해줘'), false);
  const parallel = routePrompt('여러 패키지를 병렬 검토해줘');
  assert.equal(parallel?.id, 'Naruto');
  assert.equal(routeRequiresSubagents(parallel, '여러 패키지를 병렬 검토해줘'), true);
  for (const prompt of ['audit all packages', 'Review all files']) {
    const route = routePrompt(prompt);
    assert.ok(route, prompt);
    assert.equal(route?.task_profile, 'bounded-work', prompt);
    assert.equal(routeRequiresSubagents(route, prompt), false, prompt);
  }
  const explicitlyParallelAudit = 'one agent per package audit';
  assert.equal(routeRequiresSubagents(routePrompt(explicitlyParallelAudit), explicitlyParallelAudit), true);
  assert.equal(routeRequiresSubagents(routePrompt('$Naruto implement one fix'), '$Naruto implement one fix'), true);
  assert.equal(routePrompt('$Work')?.id, 'Naruto');
  assert.equal(routePrompt('$Work')?.explicit_invocation, true);
  const ordinaryWork = routePrompt('work on the parser');
  assert.equal(ordinaryWork?.id, 'Naruto');
  assert.equal(ordinaryWork?.task_profile, 'bounded-work');
  assert.equal(ordinaryWork?.explicit_invocation, false);
  assert.equal(routeRequiresSubagents(ordinaryWork, 'work on the parser'), false);
});

test('removed dollar-command aliases do not redirect into current execution routes', () => {
  for (const prompt of ['$Agent fix this', '$Team fix this', '$Swarm fix this', '$ShadowClone fix this', '$Kagebunshin fix this', '$MAD-DB truncate public.events']) {
    const route = routePrompt(prompt);
    assert.equal(route, null, prompt);
  }
});

test('implementation language and Korean fix conjugations route as work', () => {
  for (const prompt of ['UI implementation 해줘', 'UI 버그 고치고 리뷰해줘', '이 문제는 이번 버전에서 반드시 해결해야해']) {
    const route = routePrompt(prompt);
    assert.equal(route?.id, 'Naruto', prompt);
    assert.equal(route?.task_profile, 'bounded-work', prompt);
  }
  const parallel = routePrompt('parallel implementation');
  assert.equal(parallel?.id, 'Naruto');
  assert.equal(parallel?.task_profile, 'parallel-write');
  assert.equal(routeRequiresSubagents(parallel, 'parallel implementation'), true);
});

test('legacy DB command and routing discussion stays out of the database route', () => {
  for (const prompt of [
    'remove the public legacy db usage topic from routes constants',
    'fix the DB route parser regression',
    '레거시 sks db 커맨드를 삭제해줘'
  ]) {
    const route = routePrompt(prompt);
    assert.equal(route?.id, 'Naruto', prompt);
    assert.equal(route?.task_profile, 'bounded-work', prompt);
  }

  for (const prompt of [
    'How does the sks db command work?',
    'Explain the DB routing regex'
  ]) {
    assert.equal(routePrompt(prompt)?.id, 'Answer', prompt);
  }

  const actualDatabaseWork = routePrompt('DB migration 적용해줘');
  assert.equal(actualDatabaseWork?.id, 'DB');
  assert.equal(actualDatabaseWork?.task_profile, 'high-risk');

  for (const prompt of ['apply the migration', 'migration 적용해줘', 'review the migration', '마이그레이션 검토해줘']) {
    const route = routePrompt(prompt);
    assert.equal(route?.id, 'DB', prompt);
    assert.equal(route?.task_profile, 'high-risk', prompt);
  }

  for (const prompt of ['Apply this migration code to Postgres', 'Prisma migration code 적용해줘']) {
    const route = routePrompt(prompt);
    assert.equal(route?.id, 'DB', prompt);
    assert.equal(route?.task_profile, 'high-risk', prompt);
  }

  for (const prompt of ['fix the migration parser', 'review the migration route', 'remove the migration command', 'update migration docs']) {
    const route = routePrompt(prompt);
    assert.notEqual(route?.id, 'DB', prompt);
    assert.equal(route?.task_profile, 'bounded-work', prompt);
  }
});

test('specialized Research prompts keep their route-owned orchestration when parallel execution is requested', () => {
  for (const prompt of ['research this topic in parallel', 'research this topic with subagents', '이 주제를 병렬로 연구해줘']) {
    const route = routePrompt(prompt);
    assert.equal(route?.id, 'Research', prompt);
    assert.ok(['parallel-read', 'parallel-write'].includes(route?.task_profile), prompt);
    assert.equal(routeRequiresSubagents(route, prompt), false, prompt);
    assert.equal(narutoDecisionForRoute(route, prompt).mode, 'route_owned', prompt);
  }

  assert.equal(routePrompt('fix the Research parser in parallel')?.id, 'Naruto');
});
