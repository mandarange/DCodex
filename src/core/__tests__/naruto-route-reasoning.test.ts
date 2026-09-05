import test from 'node:test'
import assert from 'node:assert/strict'
import { ROUTES, routeReasoning, reasoningInstruction } from '../routes.js'

const naruto = ROUTES.find((route) => route.id === 'Naruto')

test('explicit Naruto route reasoning matches the Astra Max parent policy', () => {
  assert.ok(naruto)
  for (const prompt of [
    'tiny typo fix',
    'terminal config repair',
    'ordinary coding task',
    'run browser e2e verification'
  ]) {
    const result = routeReasoning(naruto, prompt)
    assert.equal(result.effort, 'max', prompt)
    assert.equal(result.profile, 'sks-research-max', prompt)
    assert.equal(result.reason, 'explicit_naruto_parent_policy_max', prompt)
  }
})

test('implicit Naruto routing scales reasoning to task risk', () => {
  assert.ok(naruto)
  const bounded = routeReasoning({ ...naruto, explicit_invocation: false, task_profile: 'bounded-work' }, 'implement one parser fix')
  assert.equal(bounded.effort, 'medium')
  assert.equal(bounded.reason, 'implicit_naruto_bounded_parent_medium')

  const parallel = routeReasoning({ ...naruto, explicit_invocation: false, task_profile: 'parallel-write' }, 'implement independent fixes in parallel')
  assert.equal(parallel.effort, 'max')

  const tiny = routeReasoning({ ...naruto, explicit_invocation: false, task_profile: 'tiny-change' }, 'fix one typo')
  assert.equal(tiny.effort, 'low')
})

test('Naruto complex and high-risk parent routes use max reasoning', () => {
  assert.ok(naruto)
  for (const prompt of [
    'forensic GUI verification',
    'security release migration',
    'refactor the architecture and integration strategy'
  ]) {
    const result = routeReasoning(naruto, prompt)
    assert.equal(result.effort, 'max', prompt)
    assert.equal(result.profile, 'sks-research-max', prompt)
  }
})


test('route effort is advisory and preserves the selected runtime settings', () => {
  const text = reasoningInstruction({ effort: 'high' })
  assert.match(text, /Preserve the user-selected model, reasoning effort, and service tier/)
  assert.doesNotMatch(text, /in Fast service tier|use high reasoning/)
})
