import assert from 'node:assert/strict'
import test from 'node:test'
import { codexAppStatusWithCodexLbCapabilities } from '../codex-app.js'

test('ordinary Codex App status injects the codex-lb capability report without changing auth', async () => {
  let integrationInput: Record<string, unknown> | null = null
  const result = await codexAppStatusWithCodexLbCapabilities({
    codexLbStatusImpl: async () => ({
      schema: 'sks.codex-lb-status.v2',
      mode: 'desktop-native-bridge',
      overall: 'available_unverified',
      full_capability_verified: false,
      oauth: { present: true, preserved: true, mode: 'chatgpt_oauth' },
      capabilities: {
        schema: 'sks.codex-lb-desktop-capability-status.v2',
        ready: false,
        state: 'available_unverified',
        oauth_preserved: true
      }
    }),
    codexAppStatusImpl: async (input: Record<string, unknown>) => {
      integrationInput = input
      return { ok: true, features: { codex_lb_capabilities: input.codexLbCapabilityReport } }
    }
  })

  const report = (result.features as Record<string, unknown>).codex_lb_capabilities as Record<string, unknown>
  assert.equal(report.availability, 'reported')
  assert.equal(report.mode, 'desktop-native-bridge')
  assert.equal(report.overall, 'available_unverified')
  assert.equal(report.full_capability_verified, false)
  assert.equal((integrationInput as unknown as Record<string, unknown>).codexLbCapabilityReport, report)
  assert.equal('auth' in report, false)
})

test('ordinary Codex App status clearly reports capability evidence as unavailable', async () => {
  const result = await codexAppStatusWithCodexLbCapabilities({
    codexLbStatusImpl: async () => {
      throw new Error('status unavailable')
    },
    codexAppStatusImpl: async (input: Record<string, unknown>) => input
  })
  const report = result.codexLbCapabilityReport as Record<string, unknown>
  assert.equal(report.availability, 'unavailable')
  assert.equal(report.ready, false)
  assert.equal(report.state, 'available_unverified')
  assert.deepEqual(report.blockers, ['codex_lb_capability_report_unavailable'])
})
