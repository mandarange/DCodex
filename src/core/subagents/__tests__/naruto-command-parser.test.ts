import test from 'node:test'
import assert from 'node:assert/strict'
import { parseNarutoArgs } from '../../commands/naruto-command.js'

test('Naruto parser treats non-current execution options as unknown', () => {
  for (const args of [
    ['run', 'task', '--backend', 'codex-sdk'],
    ['run', 'task', '--scheduler', 'legacy'],
    ['run', 'task', '--pool-size=8'],
    ['run', 'task', '--model', 'gpt-5.6-terra'],
    ['run', 'task', '--agent', 'worker']
  ]) {
    const parsed = parseNarutoArgs(args)
    assert.ok(parsed.argumentErrors.some((error) => error.startsWith('unsupported_argument:')), args.join(' '))
  }
})

test('Naruto parser rejects missing fanout values, empty tasks, and misplaced subcommands', () => {
  assert.ok(parseNarutoArgs(['run', 'task', '--agents']).argumentErrors.includes('missing_option_value:--agents'))
  assert.ok(parseNarutoArgs(['run', 'task', '--max-threads=']).argumentErrors.includes('missing_option_value:--max-threads'))
  assert.ok(parseNarutoArgs(['run']).argumentErrors.includes('empty_task'))
  assert.ok(parseNarutoArgs(['status', 'run']).argumentErrors.includes('misplaced_subcommand:run'))
  assert.ok(parseNarutoArgs(['dashboard']).argumentErrors.includes('unknown_subcommand:dashboard'))
})

test('Naruto parser keeps explicit scaling and read-only status surfaces', () => {
  const run = parseNarutoArgs(['run', 'bounded task', '--agents=4', '--max-threads', '8'])
  assert.deepEqual({
    action: run.action,
    prompt: run.prompt,
    requestedSubagents: run.requestedSubagents,
    maxThreads: run.maxThreads,
    errors: run.argumentErrors
  }, {
    action: 'run',
    prompt: 'bounded task',
    requestedSubagents: 4,
    maxThreads: 8,
    errors: []
  })
  assert.equal(parseNarutoArgs(['status', 'latest']).action, 'status')
  assert.equal(parseNarutoArgs(['subagents', 'M-123']).action, 'subagents')
  assert.equal(parseNarutoArgs(['proof', 'latest']).action, 'proof')
})

test('Naruto parser admits documented host/model flags only on run actions', () => {
  const previousProviderKey = process.env.GATEWAY_API_KEY
  process.env.GATEWAY_API_KEY = 'test-only-present'
  try {
    const run = parseNarutoArgs([
      'run',
      'bounded task',
      '--auth-mode=host',
      '--model-provider',
      'gateway',
      '--provider-env-key',
      'GATEWAY_API_KEY',
      '--parent-model',
      'gpt-5.6-sol',
      '--parent-effort=max',
      '--subagent-model',
      'gpt-6-astra',
      '--subagent-effort=max',
      '--no-forced-login-method'
    ])
    assert.deepEqual(run.argumentErrors, [])
    assert.equal(run.prompt, 'bounded task')
    assert.equal(run.credentialPolicy.authMode, 'host')
    assert.equal(run.credentialPolicy.modelProvider, 'gateway')
    assert.deepEqual(run.credentialPolicy.blockers, [])
  } finally {
    if (previousProviderKey === undefined) delete process.env.GATEWAY_API_KEY
    else process.env.GATEWAY_API_KEY = previousProviderKey
  }

  for (const args of [
    ['status', 'latest', '--agents', '8'],
    ['proof', 'latest', '--max-threads=8'],
    ['subagents', 'latest', '--auth-mode=host']
  ]) {
    const parsed = parseNarutoArgs(args)
    assert.ok(parsed.argumentErrors.some((entry) => entry.startsWith('option_not_supported_for_action:')), args.join(' '))
  }

  assert.ok(parseNarutoArgs(['run', 'task', '--auth-mode'])
    .argumentErrors.includes('missing_option_value:--auth-mode'))
  assert.ok(parseNarutoArgs(['run', 'task', '--parent-model=a', '--parent-model=b'])
    .argumentErrors.includes('duplicate_option:--parent-model'))
})

test('Naruto read-only and help actions ignore malformed credential environment defaults', () => {
  const previous = process.env.SKS_NARUTO_AUTH_MODE
  process.env.SKS_NARUTO_AUTH_MODE = 'definitely-invalid'
  try {
    assert.deepEqual(parseNarutoArgs(['status', 'latest']).credentialPolicy.blockers, [])
    assert.deepEqual(parseNarutoArgs(['proof', 'latest']).credentialPolicy.blockers, [])
    assert.deepEqual(parseNarutoArgs(['help']).credentialPolicy.blockers, [])
    assert.ok(parseNarutoArgs(['run', 'task']).credentialPolicy.blockers.includes(
      'naruto_auth_mode_invalid:definitely-invalid'
    ))
  } finally {
    if (previous === undefined) delete process.env.SKS_NARUTO_AUTH_MODE
    else process.env.SKS_NARUTO_AUTH_MODE = previous
  }
})

test('Naruto parser accepts top-level and subcommand-local help without positional errors', () => {
  for (const args of [
    ['--help'],
    ['run', '--help'],
    ['run', 'ignored task', '--help'],
    ['status', '--help'],
    ['subagents', '--help'],
    ['proof', '--help']
  ]) {
    const parsed = parseNarutoArgs(args)
    assert.equal(parsed.action, 'help', args.join(' '))
    assert.deepEqual(parsed.argumentErrors, [], args.join(' '))
  }

  const jsonHelp = parseNarutoArgs(['status', '--help', '--json'])
  assert.equal(jsonHelp.action, 'help')
  assert.equal(jsonHelp.json, true)
})

test('Naruto help does not erase unknown or malformed options', () => {
  const unknown = parseNarutoArgs(['run', 'task', '--model', 'gpt-6-astra', '--help'])
  assert.equal(unknown.action, 'help')
  assert.ok(unknown.argumentErrors.includes('unsupported_argument:--model'))

  const malformed = parseNarutoArgs(['run', 'task', '--agents', '--help'])
  assert.equal(malformed.action, 'help')
  assert.ok(malformed.argumentErrors.includes('missing_option_value:--agents'))
})
