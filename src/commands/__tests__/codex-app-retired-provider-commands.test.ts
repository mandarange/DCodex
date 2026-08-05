import assert from 'node:assert/strict'
import test from 'node:test'
import { run } from '../codex-app.js'

test('retired Codex App provider commands are unavailable and point only to sks bridge', async () => {
  const retired = [
    'glm-profile',
    'set-openrouter-key',
    'use-openrouter',
    'restore-desktop-routing',
    'openrouter-status',
    'openrouter-models',
    'openrouter-test',
    'router-status',
    'router-test',
    'use-router'
  ]
  for (const action of retired) {
    const errors: string[] = []
    const previousExitCode = process.exitCode
    const previousError = console.error
    console.error = (...values: unknown[]) => errors.push(values.map(String).join(' '))
    process.exitCode = undefined
    try {
      await run('codex-app', [action])
      assert.equal(process.exitCode, 1, action)
      const output = errors.join('\n')
      assert.match(output, /sks bridge provider configure\|validate\|enable/, action)
      assert.match(output, /sks bridge catalog sync/, action)
      assert.match(output, /sks bridge route set-default/, action)
      assert.doesNotMatch(output, /use-openrouter|set-openrouter-key|router-status|router-test|use-router/, action)
    } finally {
      console.error = previousError
      process.exitCode = previousExitCode
    }
  }
})
