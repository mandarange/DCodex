import test from 'node:test'
import assert from 'node:assert/strict'
import { modelRouteReason, routeNarutoGpt56Model } from '../provider/model-router.js'

const models = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']
const modelEfforts = {
  'gpt-5.6-luna': ['xhigh', 'max'],
  'gpt-5.6-terra': ['max'],
  'gpt-5.6-sol': ['high', 'xhigh', 'max', 'ultra']
}

test('Naruto GPT-5.6 routing fails closed for an explicit model outside the family', () => {
  const choice = routeNarutoGpt56Model({
    taskText: 'implementation',
    explicitModel: 'gpt-5.4',
    availableModels: models,
    availableModelEfforts: modelEfforts
  })

  assert.equal(choice.model, '')
  assert.equal(modelRouteReason('agentic', choice, { explicit: true }), 'agentic->blocked (explicit model unavailable)')
})

test('Naruto GPT-5.6 routing preserves a supported explicit family model', () => {
  const choice = routeNarutoGpt56Model({
    taskText: 'implementation',
    explicitModel: 'GPT-5.6-LUNA',
    availableModels: models,
    availableModelEfforts: modelEfforts
  })

  assert.deepEqual(choice, { model: 'gpt-5.6-luna', reasoning: 'max', serviceTier: 'fast' })
  assert.equal(modelRouteReason('agentic', choice, { explicit: true }), 'agentic->gpt-5.6-luna (explicit model preserved)')
})

test('Naruto GPT-5.6 routing preserves Terra Max and auto-selects it for tool work', () => {
  const choice = routeNarutoGpt56Model({
    taskText: 'implementation',
    explicitModel: 'gpt-5.6-terra',
    availableModels: models,
    availableModelEfforts: modelEfforts
  })

  assert.deepEqual(choice, { model: 'gpt-5.6-terra', reasoning: 'max', serviceTier: 'fast' })
  assert.deepEqual(routeNarutoGpt56Model({ taskText: 'browser QA' }), {
    model: 'gpt-5.6-terra', reasoning: 'max', serviceTier: 'fast'
  })
  assert.deepEqual(routeNarutoGpt56Model({ taskText: 'implementation' }), {
    model: 'gpt-5.6-sol', reasoning: 'high', serviceTier: 'fast'
  })
})

test('Naruto GPT-5.6 routing rejects an unavailable model/effort pair without fallback', () => {
  const choice = routeNarutoGpt56Model({
    taskText: 'browser QA',
    availableModels: models,
    availableModelEfforts: { ...modelEfforts, 'gpt-5.6-terra': ['medium'] }
  })
  assert.equal(choice.model, '')
  assert.equal(choice.reasoning, 'max')
})
