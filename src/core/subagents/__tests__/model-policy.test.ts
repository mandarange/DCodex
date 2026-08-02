import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SUBAGENT_EFFORT,
  DEFAULT_SUBAGENT_MODEL,
  LUNA_SUBAGENT_EFFORT,
  LUNA_SUBAGENT_MODEL,
  NARUTO_PARENT_EFFORT,
  NARUTO_PARENT_MODEL,
  SOL_MAX_SUBAGENT_EFFORT,
  SUBAGENT_EFFORT,
  TERRA_SUBAGENT_EFFORT,
  TERRA_SUBAGENT_MODEL,
  THINKING_SUBAGENT_MODEL,
  decideSubagentModel
} from '../model-policy.js'
import { decideOfficialSubagentModel } from '../../agents/agent-effort-policy.js'
import { routeModel, routeNarutoGpt56Model } from '../../provider/model-router.js'

test('official parent and four child profiles expose the sealed model/effort matrix', () => {
  assert.equal(NARUTO_PARENT_MODEL, 'gpt-5.6-sol')
  assert.equal(NARUTO_PARENT_EFFORT, 'max')
  assert.equal(DEFAULT_SUBAGENT_MODEL, 'gpt-5.6-sol')
  assert.equal(DEFAULT_SUBAGENT_EFFORT, 'high')
  assert.equal(THINKING_SUBAGENT_MODEL, 'gpt-5.6-sol')
  assert.equal(SUBAGENT_EFFORT, 'max')
  assert.equal(LUNA_SUBAGENT_MODEL, 'gpt-5.6-luna')
  assert.equal(LUNA_SUBAGENT_EFFORT, 'max')
  assert.equal(TERRA_SUBAGENT_MODEL, 'gpt-5.6-terra')
  assert.equal(TERRA_SUBAGENT_EFFORT, 'max')
  assert.equal(SOL_MAX_SUBAGENT_EFFORT, 'max')
})

test('model decision routes mechanical, implementation, context/tool, and judgment work', () => {
  assert.deepEqual(decideSubagentModel({
    description: 'Apply this exact one-line single-file rename',
    contextMode: 'short',
    scopeSize: 'tiny'
  }), {
    policy: 'luna_max_mechanical',
    kind: 'worker',
    model: 'gpt-5.6-luna',
    modelReasoningEffort: 'max',
    reason: 'luna_max_mechanical'
  })

  for (const description of [
    'Implement the parser logic',
    'Build the UI modal button',
    'Add a backend endpoint handler',
    'Implement the macOS AppKit menu bar'
  ]) {
    const decision = decideSubagentModel({ description })
    assert.equal(decision.policy, 'sol_high_implementation', description)
    assert.equal(decision.model, 'gpt-5.6-sol', description)
    assert.equal(decision.modelReasoningEffort, 'high', description)
  }

  for (const description of [
    'Run browser-only QA in Chrome',
    'Use Computer Use to inspect the native app',
    'Generate an image with gpt-image-2',
    'Extract a repository-wide long-context inventory',
    'Maintain and consolidate the long-term memory for this repository',
    'Rapid large-scale first-draft code processing across many files',
    'Large repository-wide search for every caller',
    '코드베이스 전체 검색으로 진입점을 찾아줘',
    '장기 메모리를 정리하고 통합해줘',
    '대규모 코드 초안을 빠르게 생성해줘'
  ]) {
    const decision = decideSubagentModel({ description })
    assert.equal(decision.policy, 'terra_max_context_tools', description)
    assert.equal(decision.model, 'gpt-5.6-terra', description)
    assert.equal(decision.modelReasoningEffort, 'max', description)
  }

  for (const description of [
    'Apply this exact one-line single-file rename',
    'Simple search for the symbol name and type the replacement',
    'Simple coding change: update this constant',
    'Simple configuration change: set this flag to true',
    'Simple setup: add the one-line local setting',
    '단순 검색으로 키를 찾고 한 줄만 타이핑해줘',
    '간단한 코드 수정으로 상수만 바꿔줘',
    '간단한 설정 변경으로 플래그만 켜줘',
    '간단한 셋업으로 한 줄만 추가해줘'
  ]) {
    const decision = decideSubagentModel({ description })
    assert.equal(decision.policy, 'luna_max_mechanical', description)
    assert.equal(decision.model, 'gpt-5.6-luna', description)
  }
})

test('mass/broad search and exploration route to Terra while tiny typing shards stay on Luna', () => {
  for (const description of [
    'Mass search across the whole repository for every call site',
    'Bulk scan of many files to build an export inventory',
    'Broad exploration of the codebase structure',
    'Simple exploration of the repo layout',
    'Whole-repo search for configuration keys',
    '대량 검색으로 모든 참조를 찾아줘',
    '대량 탐색으로 구조를 파악해줘',
    '전체 검색으로 진입점을 찾아줘',
    '광범위 탐색으로 의존성을 정리해줘',
    '단순 탐색으로 폴더 구조만 파악해줘'
  ]) {
    const decision = decideSubagentModel({ description })
    assert.equal(decision.policy, 'terra_max_context_tools', description)
    assert.equal(decision.model, 'gpt-5.6-terra', description)
    assert.equal(decision.modelReasoningEffort, 'max', description)
  }

  // Tiny typing-level shards stay on Luna even when the surrounding sentence
  // mentions a large fan-out; the shard itself is the classification unit.
  for (const description of [
    'Shard 9 of 16 in the mass fan-out: simple search for the symbol name and type the replacement',
    'Mass fan-out shard: apply the exact rename of one label',
    'Single-symbol lookup shard in a bulk fan-out wave',
    'Simple typing-level coding shard in a 64-wide wave',
    '대량 팬아웃 샤드: 단순 치환으로 문자열을 바꿔줘',
    '단순 입력으로 값을 채워줘',
    '단순 타이핑으로 한 줄만 바꿔줘'
  ]) {
    const decision = decideSubagentModel({ description })
    assert.equal(decision.policy, 'luna_max_mechanical', description)
    assert.equal(decision.model, 'gpt-5.6-luna', description)
    assert.equal(decision.modelReasoningEffort, 'max', description)
  }
})

test('mass-lane keywords never pull judgment or clear implementation off the Sol lanes', () => {
  for (const description of [
    'Security review of the database release plan',
    'Debug the failing migration before release',
    'Audit the repository-wide security scan results'
  ]) {
    const decision = decideSubagentModel({ description })
    assert.equal(decision.policy, 'sol_max_judgment', description)
    assert.equal(decision.model, 'gpt-5.6-sol', description)
    assert.equal(decision.modelReasoningEffort, 'max', description)
  }

  for (const description of [
    'Implement the export inventory command',
    'Build the bulk import feature',
    'Fix the whole-repo search indexer'
  ]) {
    const decision = decideSubagentModel({ description })
    assert.equal(decision.policy, 'sol_high_implementation', description)
    assert.equal(decision.model, 'gpt-5.6-sol', description)
    assert.equal(decision.modelReasoningEffort, 'high', description)
  }
})

test('judgment wins mixed or ambiguous work and Luna is excluded from long context', () => {
  for (const description of [
    'Security review using browser evidence',
    'Debug a failure across a long-context log',
    'Plan the architecture',
    'Review the generated image UX',
    'Handle this task'
  ]) {
    const decision = decideSubagentModel({ description })
    assert.equal(decision.policy, 'sol_max_judgment', description)
    assert.equal(decision.model, 'gpt-5.6-sol', description)
    assert.equal(decision.modelReasoningEffort, 'max', description)
  }

  const longMechanical = decideSubagentModel({
    description: 'Perform an exact rename across a repository-wide long context',
    simpleMechanical: true,
    longContext: true
  })
  assert.equal(longMechanical.policy, 'terra_max_context_tools')
})

test('clear docs exploration and implementation intent outrank incidental judgment vocabulary', () => {
  const docsExploration = decideSubagentModel({
    description: 'Read the latest Codex CLI and Desktop app documentation, explore the repository, and compare the architecture notes'
  })
  assert.equal(docsExploration.policy, 'terra_max_context_tools')
  assert.equal(docsExploration.model, 'gpt-5.6-terra')
  assert.equal(docsExploration.modelReasoningEffort, 'max')

  const boundedImplementation = decideSubagentModel({
    description: 'Implement the bounded scheduler fix; the architecture review and debug context are already resolved'
  })
  assert.equal(boundedImplementation.policy, 'sol_high_implementation')
  assert.equal(boundedImplementation.model, 'gpt-5.6-sol')
  assert.equal(boundedImplementation.modelReasoningEffort, 'high')

  const finalHighRiskJudgment = decideSubagentModel({
    description: 'Perform the final high-risk security judgment before release'
  })
  assert.equal(finalHighRiskJudgment.policy, 'sol_max_judgment')
  assert.equal(finalHighRiskJudgment.modelReasoningEffort, 'max')
})

test('explicit judgment and implementation outrank incidental tiny or tool-heavy signals', () => {
  assert.equal(decideSubagentModel({
    description: 'Review the single-file security change'
  }).policy, 'sol_max_judgment')
  assert.equal(decideSubagentModel({
    description: 'Implement a single-file parser fix'
  }).policy, 'sol_high_implementation')
  assert.equal(decideSubagentModel({
    description: 'Inspect browser evidence for the release decision',
    requiresJudgment: true,
    toolHeavy: true
  }).policy, 'sol_max_judgment')
  assert.equal(decideSubagentModel({
    description: 'Review the current CLI documentation'
  }).policy, 'terra_max_context_tools')
})

test('simple wording never under-classifies multi-file, feature, logic, or ambiguous work', () => {
  for (const description of [
    'Simple coding task: implement a new parser feature',
    'Simple configuration change across multiple files',
    'Single-file business logic fix',
    '간단한 코드 수정으로 새 기능과 로직을 구현해줘',
    '간단한 설정 변경이지만 여러 파일을 수정해줘'
  ]) {
    const decision = decideSubagentModel({ description })
    assert.notEqual(decision.policy, 'luna_max_mechanical', description)
  }
  assert.equal(decideSubagentModel({
    description: 'Review an ambiguous simple setup for security risk'
  }).policy, 'sol_max_judgment')
  for (const description of [
    'Change the configuration',
    'Update the setup',
    '설정을 변경해줘',
    '셋업을 업데이트해줘'
  ]) {
    assert.equal(decideSubagentModel({ description }).policy, 'sol_max_judgment', description)
  }
})

test('explicit mechanical labels cannot override judgment, context, or complexity guards', () => {
  assert.equal(decideSubagentModel({
    taskClass: 'mechanical',
    description: 'Simple multi-file new feature implementation'
  }).policy, 'sol_high_implementation')
  assert.equal(decideSubagentModel({
    taskClass: 'mechanical',
    description: 'Simple but ambiguous ownership change'
  }).policy, 'sol_max_judgment')
  assert.equal(decideSubagentModel({
    taskClass: 'mechanical',
    description: 'Copy labels',
    longContext: true
  }).policy, 'terra_max_context_tools')
  assert.equal(decideSubagentModel({
    taskClass: 'implementation',
    description: 'Implement the requested change',
    requiresJudgment: true
  }).policy, 'sol_max_judgment')
})

test('official effort policy applies the sealed four-profile routing matrix', () => {
  const mechanical = decideOfficialSubagentModel({
    persona: { role: 'implementer', naruto_role: 'worker' },
    prompt: 'apply this exact one-line single-file rename'
  })
  const implementation = decideOfficialSubagentModel({
    persona: { role: 'implementer', naruto_role: 'implementation_specialist' },
    prompt: 'implement the parser logic'
  })
  const context = decideOfficialSubagentModel({
    persona: { role: 'verifier', naruto_role: 'browser_use_operator' },
    prompt: 'collect browser evidence'
  })
  const review = decideOfficialSubagentModel({
    persona: { role: 'safety', naruto_role: 'security_reviewer' },
    prompt: 'review the browser evidence for security risk'
  })

  assert.deepEqual([mechanical.model, mechanical.model_reasoning_effort], ['gpt-5.6-luna', 'max'])
  assert.deepEqual([implementation.model, implementation.model_reasoning_effort], ['gpt-5.6-sol', 'high'])
  assert.deepEqual([context.model, context.model_reasoning_effort], ['gpt-5.6-terra', 'max'])
  assert.deepEqual([review.model, review.model_reasoning_effort], ['gpt-5.6-sol', 'max'])
})

test('Naruto automatic routing uses the exact selected profile and fails closed', () => {
  const catalog = {
    availableModels: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
    availableModelEfforts: {
      'gpt-5.6-luna': ['max'],
      'gpt-5.6-terra': ['max'],
      'gpt-5.6-sol': ['high', 'max']
    }
  }
  assert.deepEqual(routeNarutoGpt56Model({ ...catalog, taskText: 'exact one-line single-file rename' }), {
    model: 'gpt-5.6-luna', reasoning: 'max', serviceTier: 'fast'
  })
  assert.deepEqual(routeNarutoGpt56Model({ ...catalog, taskText: 'implement parser logic' }), {
    model: 'gpt-5.6-sol', reasoning: 'high', serviceTier: 'fast'
  })
  assert.deepEqual(routeNarutoGpt56Model({ ...catalog, taskText: 'browser QA in Chrome' }), {
    model: 'gpt-5.6-terra', reasoning: 'max', serviceTier: 'fast'
  })
  assert.deepEqual(routeNarutoGpt56Model({ ...catalog, taskText: 'UI debugging review' }), {
    model: 'gpt-5.6-sol', reasoning: 'max', serviceTier: 'fast'
  })
  assert.equal(routeNarutoGpt56Model({
    taskText: 'browser QA in Chrome',
    availableModels: ['gpt-5.6-terra'],
    availableModelEfforts: { 'gpt-5.6-terra': ['medium'] }
  }).model, '')
})

test('explicit family models keep their allowed effort profile', () => {
  const catalog = {
    availableModels: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
    availableModelEfforts: {
      'gpt-5.6-luna': ['max'],
      'gpt-5.6-terra': ['max'],
      'gpt-5.6-sol': ['high', 'max']
    }
  }
  assert.deepEqual(routeNarutoGpt56Model({ ...catalog, taskText: 'implement parser', explicitModel: 'gpt-5.6-terra' }), {
    model: 'gpt-5.6-terra', reasoning: 'max', serviceTier: 'fast'
  })
  assert.deepEqual(routeNarutoGpt56Model({ ...catalog, taskText: 'implement parser', explicitModel: 'gpt-5.6-sol' }), {
    model: 'gpt-5.6-sol', reasoning: 'high', serviceTier: 'fast'
  })
  assert.deepEqual(routeNarutoGpt56Model({ ...catalog, taskText: 'security review', explicitModel: 'gpt-5.6-sol' }), {
    model: 'gpt-5.6-sol', reasoning: 'max', serviceTier: 'fast'
  })
})

test('generic routing preserves an arbitrary explicit non-Naruto model', async () => {
  const choice = await routeModel('agentic', { model: 'future-codex-model' })
  assert.equal(choice.model, 'future-codex-model')
})
