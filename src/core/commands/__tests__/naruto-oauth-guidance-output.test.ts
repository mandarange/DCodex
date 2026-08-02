import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attachNarutoLaunchDiagnostics,
  renderNarutoOperatorActionLines
} from '../naruto-command.js'
import { OAUTH_CALLBACK_RECOVERY_GUIDANCE } from '../../codex/oauth-callback-port-diagnostic.js'

test('blocked Naruto result carries and renders the exact OAuth callback guidance without raw diagnostic stderr', () => {
  const result = attachNarutoLaunchDiagnostics({
    schema: 'sks.naruto-result.v1',
    status: 'blocked',
    mission_id: 'M-oauth-conflict',
    blockers: ['codex_parent_exit:1']
  }, {
    operator_actions: [OAUTH_CALLBACK_RECOVERY_GUIDANCE],
    oauth_callback_port_diagnostic: {
      schema: 'sks.codex-oauth-callback-port-diagnostic.v1',
      port: 1455,
      status: 'conflict',
      available: true,
      conflict: true,
      listeners: [
        { command: 'codex-app', pid: 410, address: '127.0.0.1:1455', scope: 'loopback_ipv4' },
        { command: 'com.docker', pid: 922, address: '[::]:1455', scope: 'wildcard' }
      ],
      warnings: ['oauth_callback_port_1455_conflict'],
      stderr: 'codex app-server --api-key=sk-sensitive-naruto-fixture'
    }
  })
  const lines = renderNarutoOperatorActionLines(result)
  const incompleteLines = renderNarutoOperatorActionLines({
    ...result,
    status: 'incomplete',
    blockers: []
  })
  const serialized = JSON.stringify(result)

  assert.deepEqual(result.operator_actions, [OAUTH_CALLBACK_RECOVERY_GUIDANCE])
  assert.ok(lines.includes(`Action: ${OAUTH_CALLBACK_RECOVERY_GUIDANCE}`))
  assert.ok(incompleteLines.includes(`Action: ${OAUTH_CALLBACK_RECOVERY_GUIDANCE}`))
  assert.equal(result.oauth_callback_port_diagnostic.conflict, true)
  assert.doesNotMatch(serialized, /stderr|api-key|sk-sensitive-naruto-fixture/)
})
