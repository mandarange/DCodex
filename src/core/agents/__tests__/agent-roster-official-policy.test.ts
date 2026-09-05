import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentRoster } from '../agent-roster.js'

test('official Naruto roster policy seals Luna/Astra four-profile routing', () => {
  const roster = buildAgentRoster({
    agents: 3,
    prompt: 'implement the parser and review the security boundary',
    officialSubagentPolicy: true
  })
  assert.ok(roster.roster.every((agent) => /^(gpt-5\.6-luna|gpt-6-astra)$/.test(String(agent.model || ''))))
  assert.ok(roster.roster.every((agent) => ['medium', 'high', 'max'].includes(String(agent.model_reasoning_effort || ''))))
  assert.equal(roster.effort_policy.model_catalog_policy, 'official_subagent_four_profile_matrix')
})
