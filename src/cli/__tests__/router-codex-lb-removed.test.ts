import test from 'node:test'
import assert from 'node:assert/strict'
import { dispatch, normalizeCommand } from '../router.js'

test('retired sks codex-lb is absent from normalization and returns unknown_command', async () => {
  assert.equal(normalizeCommand(['codex-lb', 'status']).command, null)

  const stdout: string[] = []
  const stderr: string[] = []
  const previousLog = console.log
  const previousError = console.error
  const previousExitCode = process.exitCode
  try {
    console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '))
    console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '))
    process.exitCode = undefined
    const result: any = await dispatch(['codex-lb', 'status', '--json'])

    assert.equal(result.ok, false)
    assert.equal(result.status, 'blocked')
    assert.equal(result.command, 'codex-lb')
    assert.equal(result.reason, 'unknown_command')
    assert.equal(process.exitCode, 1)
    assert.match(stdout.join('\n'), /"reason": "unknown_command"/)
    assert.match(stderr.join('\n'), /Unknown command: codex-lb/)
  } finally {
    console.log = previousLog
    console.error = previousError
    process.exitCode = previousExitCode
  }
})
