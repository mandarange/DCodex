import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertNarutoMultiAgentV2Capability,
  buildCodexCapabilityMatrix
} from '../codex-compat/codex-capability-matrix.js'
import { CURRENT_CODEX_RELEASE_MANIFEST } from '../codex-compat/codex-release-manifest.js'

test('capability matrix prefers live multi_agent_v2 probes over hard version locks', () => {
  const withHelp = buildCodexCapabilityMatrix({
    version: '0.140.0',
    helpText: 'features.multi_agent_v2 and agents.max_concurrent_threads_per_session'
  })
  assert.equal(withHelp.capabilities.multi_agent_v2.available, true)
  assert.equal(withHelp.capabilities.agents_max_concurrent_threads_per_session.available, true)
  assert.equal(assertNarutoMultiAgentV2Capability(withHelp).ok, true)

  const oldWithoutProbe = buildCodexCapabilityMatrix({
    version: '0.140.0',
    helpText: 'codex exec --help'
  })
  assert.equal(oldWithoutProbe.capabilities.multi_agent_v2.available, false)
  const blocked = assertNarutoMultiAgentV2Capability(oldWithoutProbe)
  assert.equal(blocked.ok, false)
  assert.ok(blocked.blockers.includes('naruto_requires_multi_agent_v2'))
  assert.ok(blocked.blockers.includes('update_codex_cli'))
  assert.ok(blocked.guidance.some((line) => /sks codex update|Update Codex CLI/i.test(line)))

  const preferredFloor = buildCodexCapabilityMatrix({
    version: CURRENT_CODEX_RELEASE_MANIFEST.narutoCapabilityFloorVersion,
    helpText: ''
  })
  assert.equal(preferredFloor.capabilities.multi_agent_v2.available, true)
  assert.equal(assertNarutoMultiAgentV2Capability(preferredFloor).ok, true)

  assert.equal(withHelp.capabilities.mcp_startup_tool_timeouts.available, true)
  assert.equal(withHelp.capabilities.gpt56_terra_luna_sol_routing.available, true)
  assert.match(withHelp.warnings.join('\n'), /below preferred/)
})

test('package tracks the current Codex release as its only supported floor', () => {
  assert.equal(CURRENT_CODEX_RELEASE_MANIFEST.preferredCliVersion, '0.146.0')
  assert.equal(CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion, '0.146.0')
  assert.equal(CURRENT_CODEX_RELEASE_MANIFEST.minimumSupportedVersion, '0.146.0')
  assert.equal(CURRENT_CODEX_RELEASE_MANIFEST.narutoCapabilityFloorVersion, '0.146.0')
  assert.equal(CURRENT_CODEX_RELEASE_MANIFEST.featurePolicies.multiAgentV2, 'delegate')
  assert.equal(CURRENT_CODEX_RELEASE_MANIFEST.featurePolicies.mcpStartupToolTimeouts, 'wrap')
})
