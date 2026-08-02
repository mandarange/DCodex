import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OAUTH_CALLBACK_RECOVERY_GUIDANCE,
  inspectOAuthCallbackPortConflict,
  oauthCallbackDoctorGuidance,
  oauthCallbackRecoveryGuidance,
  type OAuthCallbackDiagnosticRunner
} from '../oauth-callback-port-diagnostic.js'

function processResult(input: {
  code?: number | null
  stdout?: string
  stderr?: string
  timedOut?: boolean
}) {
  const stdout = input.stdout || ''
  const stderr = input.stderr || ''
  return {
    code: input.code ?? 0,
    stdout,
    stderr,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    truncated: false,
    timedOut: input.timedOut === true
  }
}

const dualListenerOutput = [
  'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
  'codex-app 410 user 17u IPv4 0x1 0t0 TCP 127.0.0.1:1455 (LISTEN)',
  'com.docker 922 user 18u IPv6 0x2 0t0 TCP *:1455 (LISTEN)'
].join('\n')

test('detects a separate wildcard process beside the realistically truncated Codex app-server listener', async () => {
  let calls = 0
  const run: OAuthCallbackDiagnosticRunner = async (command, args, options) => {
    calls += 1
    assert.equal(command, 'lsof')
    assert.deepEqual(args, ['-nP', '-iTCP:1455', '-sTCP:LISTEN'])
    assert.ok(Number(options.timeoutMs) > 0)
    assert.ok(Number(options.timeoutMs) <= 1_500)
    return processResult({ stdout: dualListenerOutput })
  }

  const result = await inspectOAuthCallbackPortConflict({ run })

  assert.equal(calls, 1)
  assert.equal(result.status, 'conflict')
  assert.equal(result.conflict, true)
  assert.deepEqual(result.warnings, ['oauth_callback_port_1455_conflict'])
  assert.deepEqual(result.listeners.map((listener) => ({
    command: listener.command,
    pid: listener.pid,
    address: listener.address,
    scope: listener.scope
  })), [
    { command: 'codex-app', pid: 410, address: '127.0.0.1:1455', scope: 'loopback_ipv4' },
    { command: 'com.docker', pid: 922, address: '*:1455', scope: 'wildcard' }
  ])
})

test('does not report conflict without both required listener classes', async () => {
  const fixtures = [
    'codex 410 user 17u IPv4 0x1 0t0 TCP 127.0.0.1:1455 (LISTEN)',
    'com.docker 922 user 18u IPv6 0x2 0t0 TCP [::]:1455 (LISTEN)',
    [
      'codex 410 user 17u IPv4 0x1 0t0 TCP 127.0.0.1:1455 (LISTEN)',
      'helper 922 user 18u IPv4 0x2 0t0 TCP 192.168.1.2:1455 (LISTEN)'
    ].join('\n'),
    [
      'ChatGPT 410 user 17u IPv4 0x1 0t0 TCP 127.0.0.1:1455 (LISTEN)',
      'com.docker 922 user 18u IPv6 0x2 0t0 TCP [::]:1455 (LISTEN)'
    ].join('\n')
  ]
  for (const stdout of fixtures) {
    const result = await inspectOAuthCallbackPortConflict({
      run: async () => processResult({ stdout })
    })
    assert.equal(result.status, 'clear')
    assert.equal(result.conflict, false)
    assert.deepEqual(result.warnings, [])
  }
})

test('does not report conflict when one Codex process owns both sockets', async () => {
  const stdout = [
    'codex-app-server 410 user 17u IPv4 0x1 0t0 TCP 127.0.0.1:1455 (LISTEN)',
    'codex-app-server 410 user 18u IPv6 0x2 0t0 TCP [::]:1455 (LISTEN)'
  ].join('\n')
  const result = await inspectOAuthCallbackPortConflict({
    run: async () => processResult({ stdout })
  })

  assert.equal(result.status, 'clear')
  assert.equal(result.conflict, false)
})

test('degrades gracefully when lsof is unavailable', async () => {
  const result = await inspectOAuthCallbackPortConflict({
    run: async () => {
      const error = new Error('spawn lsof ENOENT')
      ;(error as NodeJS.ErrnoException).code = 'ENOENT'
      throw error
    }
  })

  assert.equal(result.status, 'unavailable')
  assert.equal(result.available, false)
  assert.equal(result.conflict, false)
  assert.deepEqual(result.listeners, [])
  assert.deepEqual(result.warnings, [])
})

test('uses a bounded timeout and returns no conflict after timeout', async () => {
  let observedTimeout = 0
  const result = await inspectOAuthCallbackPortConflict({
    timeoutMs: 60_000,
    run: async (_command, _args, options) => {
      observedTimeout = Number(options.timeoutMs)
      return processResult({ code: 124, timedOut: true, stderr: 'probe timed out' })
    }
  })

  assert.equal(observedTimeout, 1_500)
  assert.equal(result.status, 'timeout')
  assert.equal(result.conflict, false)
  assert.deepEqual(result.warnings, [])
})

test('returns the recovery hint only for an auth failure with a detected conflict', () => {
  assert.deepEqual(
    oauthCallbackRecoveryGuidance('Error: not logged in; run codex login', { conflict: true }),
    [OAUTH_CALLBACK_RECOVERY_GUIDANCE]
  )
  assert.deepEqual(
    oauthCallbackRecoveryGuidance('Error: not logged in; run codex login', { conflict: false }),
    []
  )
  assert.deepEqual(
    oauthCallbackRecoveryGuidance('Error: MCP initialization failed', { conflict: true }),
    []
  )
  assert.equal(
    OAUTH_CALLBACK_RECOVERY_GUIDANCE,
    'If the OAuth callback ends on a dead page, replace localhost with 127.0.0.1 in the address bar and retry immediately; the authorization code is short-lived and one-time.'
  )
})

test('Doctor guidance is present whenever and only when the listener conflict is present', () => {
  assert.deepEqual(oauthCallbackDoctorGuidance({ conflict: true }), [OAUTH_CALLBACK_RECOVERY_GUIDANCE])
  assert.deepEqual(oauthCallbackDoctorGuidance({ conflict: false }), [])
})

test('never returns raw lsof errors or sensitive command text', async () => {
  const secret = 'sk-sensitive-listener-fixture'
  const stdout = [
    dualListenerOutput,
    `codex;--api-key=${secret} 777 user 19u IPv4 0x3 0t0 TCP 127.0.0.1:1455 (LISTEN)`
  ].join('\n')
  const result = await inspectOAuthCallbackPortConflict({
    run: async () => processResult({
      stdout,
      stderr: `lsof internal command: codex app-server --api-key=${secret}`
    })
  })
  const serialized = JSON.stringify(result)

  assert.doesNotMatch(serialized, /--api-key/)
  assert.doesNotMatch(serialized, new RegExp(secret))
  assert.doesNotMatch(serialized, /\buser\b/)
  assert.equal(result.listeners.length, 2)
})
