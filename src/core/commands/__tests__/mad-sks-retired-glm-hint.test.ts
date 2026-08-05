import assert from 'node:assert/strict'
import test from 'node:test'
import { madHighCommand } from '../mad-sks-command.js'

test('MAD retired GLM invocation is blocked with only Desktop Bridge guidance', async () => {
  const previousExitCode = process.exitCode
  const previousError = console.error
  console.error = () => undefined
  try {
    process.exitCode = undefined
    const result: any = await madHighCommand(['--glm'])
    assert.equal(result.ok, false)
    assert.equal(result.status, 'blocked')
    assert.deepEqual(result.blockers, ['retired_glm_mad_flag:--glm'])
    assert.match(result.hint, /sks bridge provider configure\|validate\|enable/)
    assert.match(result.hint, /sks bridge catalog sync/)
    assert.match(result.hint, /sks bridge route set-default/)
    assert.doesNotMatch(result.hint, /sks codex-lb|sks codex-app use-openrouter|sks codex-app set-openrouter-key/)
    assert.equal(process.exitCode, 1)
  } finally {
    console.error = previousError
    process.exitCode = previousExitCode
  }
})
