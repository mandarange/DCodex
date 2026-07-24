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
  assert.equal(TERRA_SUBAGENT_EFFORT, 'medium')
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
    'Large repository-wide search for every caller',
    '코드베이스 전체 검색으로 진입점을 찾아줘'
  ]) {
    const decision = decideSubagentModel({ description })
    assert.equal(decision.policy, 'terra_medium_context_tools', description)
    assert.equal(decision.model, 'gpt-5.6-terra', description)
    assert.equal(decision.modelReasoningEffort, 'medium', description)
  }

  for (const description of [
    'Apply this exact one-line single-file rename',
    'Simple search for the symbol name and type the replacement',
    '단순 검색으로 키를 찾고 한 줄만 타이핑해줘'
  ]) {
    const decision = decideSubagentModel({ description })
    assert.equal(decision.policy, 'luna_max_mechanical', description)
    assert.equal(decision.model, 'gpt-5.6-luna', description)
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
  assert.equal(longMechanical.policy, 'terra_medium_context_tools')
})

test('clear docs exploration and implementation intent outrank incidental judgment vocabulary', () => {
  const docsExploration = decideSubagentModel({
    description: 'Read the latest Codex CLI and Desktop app documentation, explore the repository, and compare the architecture notes'
  })
  assert.equal(docsExploration.policy, 'terra_medium_context_tools')
  assert.equal(docsExploration.model, 'gpt-5.6-terra')
  assert.equal(docsExploration.modelReasoningEffort, 'medium')

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
  assert.deepEqual([context.model, context.model_reasoning_effort], ['gpt-5.6-terra', 'medium'])
  assert.deepEqual([review.model, review.model_reasoning_effort], ['gpt-5.6-sol', 'max'])
})

test('Naruto automatic routing uses the exact selected profile and fails closed', () => {
  const catalog = {
    availableModels: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
    availableModelEfforts: {
      'gpt-5.6-luna': ['max'],
      'gpt-5.6-terra': ['medium'],
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
    model: 'gpt-5.6-terra', reasoning: 'medium', serviceTier: 'fast'
  })
  assert.deepEqual(routeNarutoGpt56Model({ ...catalog, taskText: 'UI debugging review' }), {
    model: 'gpt-5.6-sol', reasoning: 'max', serviceTier: 'fast'
  })
  assert.equal(routeNarutoGpt56Model({
    taskText: 'browser QA in Chrome',
    availableModels: ['gpt-5.6-terra'],
    availableModelEfforts: { 'gpt-5.6-terra': ['max'] }
  }).model, '')
})

test('explicit family models keep their allowed effort profile', () => {
  const catalog = {
    availableModels: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
    availableModelEfforts: {
      'gpt-5.6-luna': ['max'],
      'gpt-5.6-terra': ['medium'],
      'gpt-5.6-sol': ['high', 'max']
    }
  }
  assert.deepEqual(routeNarutoGpt56Model({ ...catalog, taskText: 'implement parser', explicitModel: 'gpt-5.6-terra' }), {
    model: 'gpt-5.6-terra', reasoning: 'medium', serviceTier: 'fast'
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
