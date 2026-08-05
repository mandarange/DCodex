import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatch } from '../router.js'

test('router retired GLM hint points only to Desktop Bridge routing', async () => {
  const originalExitCode = process.exitCode
  const originalError = console.error
  console.error = () => undefined
  try {
    process.exitCode = 0
    const result: any = await dispatch(['--glm'])
    assert.equal(result.reason, 'glm_mad_removed')
    assert.match(result.hint, /sks bridge provider configure/)
    assert.match(result.hint, /sks bridge catalog sync/)
    assert.match(result.hint, /sks bridge route set-default/)
    assert.doesNotMatch(result.hint, /use-openrouter|set-openrouter-key/)
  } finally {
    console.error = originalError
    process.exitCode = originalExitCode
  }
})
