import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTaskProfile,
  gateProfileForTask
} from '../../runtime/task-profile.js'
import { chooseVerificationBudget } from '../../runtime/verification-budget.js'
import { DEPRECATED_AGENT_TERMS, SUBAGENT_TERMS } from '../terminology.js'

test('task profiles keep greetings and answers off execution routes', () => {
  assert.equal(classifyTaskProfile(''), 'passthrough')
  assert.equal(classifyTaskProfile('안녕하세요!'), 'passthrough')
  assert.equal(classifyTaskProfile('How does the parser work?'), 'answer')
  assert.equal(classifyTaskProfile('How do I fix a typo in README?'), 'answer')
  assert.equal(classifyTaskProfile('How do we review multiple files in parallel?'), 'answer')
  assert.equal(classifyTaskProfile('Can you explain how to fix this typo?'), 'answer')
  assert.equal(classifyTaskProfile('Can you fix the typo in README?'), 'tiny-change')
  assert.equal(gateProfileForTask('answer'), 'none')
})

test('task profiles distinguish tiny, bounded, parallel, and high-risk work', () => {
  assert.equal(classifyTaskProfile('Fix the typo in README'), 'tiny-change')
  assert.equal(classifyTaskProfile('Implement the route parser'), 'bounded-work')
  assert.equal(classifyTaskProfile('UI implementation 해줘'), 'bounded-work')
  assert.equal(classifyTaskProfile('UI 버그 고치고 리뷰해줘'), 'bounded-work')
  assert.equal(classifyTaskProfile('parallel implementation'), 'parallel-write')
  assert.equal(classifyTaskProfile('이 문제는 이번 버전에서 반드시 해결해야해'), 'bounded-work')
  assert.equal(classifyTaskProfile('Audit all files in parallel'), 'parallel-read')
  assert.equal(classifyTaskProfile('Edit multiple files in parallel'), 'parallel-write')
  assert.equal(classifyTaskProfile('Audit all runtime paths'), 'bounded-work')
  assert.equal(classifyTaskProfile('Review multiple files'), 'bounded-work')
  assert.equal(classifyTaskProfile('Fix the auth label typo in README'), 'tiny-change')
  assert.equal(classifyTaskProfile('Remove one-line security check'), 'high-risk')
  assert.equal(classifyTaskProfile('Delete one-line SQL migration'), 'high-risk')
  assert.equal(classifyTaskProfile('Fix the database migration'), 'high-risk')
  assert.equal(classifyTaskProfile('DB migration 적용해줘'), 'high-risk')
  assert.equal(classifyTaskProfile('apply the migration'), 'high-risk')
  assert.equal(classifyTaskProfile('migration 적용해줘'), 'high-risk')
  assert.equal(classifyTaskProfile('review the migration'), 'high-risk')
  assert.equal(classifyTaskProfile('마이그레이션 검토해줘'), 'high-risk')
  assert.equal(classifyTaskProfile('Apply this migration code to Postgres'), 'high-risk')
  assert.equal(classifyTaskProfile('Prisma migration code 적용해줘'), 'high-risk')
  assert.notEqual(classifyTaskProfile('마이그레이션'), 'high-risk')
  assert.equal(classifyTaskProfile('Delete database records'), 'high-risk')

  for (const prompt of [
    'fix the migration parser',
    'review the migration route',
    'remove the migration command',
    'update migration docs',
    'fix the migration code parser',
    '마이그레이션 라우트 수정해줘',
    '마이그레이션 문서 업데이트해줘'
  ]) {
    assert.equal(classifyTaskProfile(prompt), 'bounded-work', prompt)
  }

  assert.equal(gateProfileForTask('tiny-change'), 'minimal')
  assert.equal(gateProfileForTask('bounded-work'), 'scoped')
  assert.equal(gateProfileForTask('parallel-write'), 'scoped')
  assert.equal(gateProfileForTask('high-risk'), 'full')
})

test('verification budgets follow task risk instead of decorative gate count', () => {
  assert.equal(chooseVerificationBudget({ taskProfile: 'passthrough', changedFiles: [] }), 'none')
  assert.equal(chooseVerificationBudget({ taskProfile: 'answer', changedFiles: [] }), 'none')
  assert.equal(chooseVerificationBudget({ taskProfile: 'tiny-change', changedFiles: ['README.md'] }), 'single-check')
  assert.equal(chooseVerificationBudget({ taskProfile: 'bounded-work', changedFiles: ['src/a.ts'] }), 'affected')
  assert.equal(chooseVerificationBudget({ taskProfile: 'high-risk', changedFiles: ['src/release.ts'] }), 'confidence')
  assert.equal(chooseVerificationBudget({ taskProfile: 'bounded-work', changedFiles: ['src/a.ts'], failedChecks: ['unit'] }), 'confidence')
  assert.equal(chooseVerificationBudget({ taskProfile: 'bounded-work', changedFiles: ['package.json'] }), 'release')
})

test('official terminology uses Naruto as the product parallel vocabulary', () => {
  assert.equal(SUBAGENT_TERMS.system, 'Naruto')
  assert.equal(SUBAGENT_TERMS.workflow, 'Naruto parallel workflow')
  assert.equal(SUBAGENT_TERMS.thread, 'Naruto child thread')
  assert.equal(SUBAGENT_TERMS.transport, 'official Codex subagent')
  assert.ok(DEPRECATED_AGENT_TERMS.includes('shadow clone'))
  assert.ok(DEPRECATED_AGENT_TERMS.includes('native agent'))
})


test('simplification requests in Korean and English remain execution work', () => {
  for (const prompt of [
    '불필요한 기능 및 게이트 및 코드를 제거하고 핵심 컨셉만 유지해줘',
    'gpt6 아스트라 모델에 맞게 최적화하고 미비점을 개선해줘',
    '코드를 단순화하고 정리해줘',
    'Simplify the runtime',
    'Optimize the parser',
    'Improve the workflow'
  ]) assert.equal(classifyTaskProfile(prompt), 'bounded-work', prompt)
  assert.equal(classifyTaskProfile('최적화 방법을 설명해줘'), 'answer')
  assert.equal(classifyTaskProfile('인증 권한 검사를 제거해줘'), 'high-risk')
})
