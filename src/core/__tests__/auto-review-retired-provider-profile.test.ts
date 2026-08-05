import assert from 'node:assert/strict'
import test from 'node:test'
import { isSksGeneratedRetiredProfileText } from '../auto-review.js'

test('retired direct OpenRouter profile bytes are cleanup signatures, not generators', () => {
  const historical = [
    'model_provider = "openrouter"',
    'model = "z-ai/glm-5.2"',
    'model_reasoning_effort = "high"',
    'service_tier = "default"',
    'approval_policy = "on-request"'
  ].join('\n')
  assert.equal(isSksGeneratedRetiredProfileText(historical), true)
  assert.equal(isSksGeneratedRetiredProfileText(historical.replace('high', 'ultra')), false)
})
