import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_GENERATION_DEPTH_ENV,
  MAX_AGENT_GENERATION_DEPTH,
  agentGenerationDepth,
  agentGenerationDepthExceeded,
  agentWorkerHookContext,
  agentWorkerHookRecursionDecision,
  nextAgentGenerationEnv
} from '../agent-recursion-guard.js'
import { buildOfficialSubagentChildEnv } from '../../subagents/official-subagent-runner.js'

/**
 * Two reported symptoms, one cause: the runtime guard was reading a marker
 * nobody sets.
 *
 * `native-cli-worker-runtime` marks a worker by putting `SKS_AGENT_WORKER=1`
 * into the spawned *process* environment. The hook that is supposed to refuse a
 * nested fan-out read only the tool-call payload, so an agent running
 * `sks naruto run` through its shell — which has no reason to redeclare that
 * variable in the tool input — sailed straight through. Unbounded nesting was
 * one consequence. The other was that the same predicate gates whether a hook
 * hands out parent wave-spawn guidance, so child workers were being told to
 * spawn the parent's own waves and re-ran the parent's session instead of their
 * assigned slice.
 */

const WORKER_ENV = { SKS_AGENT_WORKER: '1' } as NodeJS.ProcessEnv

test('a worker is recognized from the environment its spawner actually set', () => {
  // The payload is empty on purpose: this is what a real shell tool call looks
  // like from inside a worker.
  assert.equal(agentWorkerHookContext({}, {}, WORKER_ENV), true)
  assert.equal(agentWorkerHookContext({}, {}, { SKS_DISABLE_ROUTE_RECURSION: '1' }), true)
  assert.equal(agentWorkerHookContext({}, {}, {}), false, 'a root session is not a worker')
})

test('a payload that declares the worker env still counts', () => {
  // A caller describing a child it is about to spawn is telling the truth about
  // that child, so the old source is kept rather than replaced.
  assert.equal(agentWorkerHookContext({}, { tool_input: { env: WORKER_ENV } }, {}), true)
  assert.equal(agentWorkerHookContext({}, { agent_worker: true }, {}), true)
})

test('a nested route launch from inside a worker is refused', () => {
  const decision = agentWorkerHookRecursionDecision({}, { env: WORKER_ENV }, 'sks naruto run --agents 8')
  assert.ok(decision, 'the guard must fire for a worker')
  assert.equal(decision.decision, 'block')
  assert.equal(decision.permissionDecision, 'deny')
  assert.match(String(decision.reason), /recursion/i)
})

test('a root session is not blocked from launching the first fan-out', () => {
  // The guard must not make the product unusable: depth 0 is the legitimate
  // entry point and has to stay open.
  assert.equal(agentWorkerHookRecursionDecision({}, { env: {} }, 'sks naruto run --agents 8'), null)
})

test('generation depth increments across a spawn boundary and then refuses', () => {
  assert.equal(agentGenerationDepth({}), 0)
  const first = nextAgentGenerationEnv({})
  assert.equal(first[AGENT_GENERATION_DEPTH_ENV], '1')
  assert.equal(agentGenerationDepthExceeded(first), false, 'one generation of workers is the product')

  const second = nextAgentGenerationEnv(first)
  assert.equal(second[AGENT_GENERATION_DEPTH_ENV], String(MAX_AGENT_GENERATION_DEPTH + 1))
  assert.equal(agentGenerationDepthExceeded(second), true, 'a worker spawning its own fan-out is the bug')
})

test('a depth marker alone identifies a worker, even if the boolean was lost', () => {
  // Defence in depth: a counter survives one boundary forgetting the boolean.
  assert.equal(agentWorkerHookContext({}, {}, { [AGENT_GENERATION_DEPTH_ENV]: '1' }), true)
})

test('an unreadable depth reads as zero rather than as permission', () => {
  for (const value of ['', 'NaN', '-3', 'many', '1e9999']) {
    const depth = agentGenerationDepth({ [AGENT_GENERATION_DEPTH_ENV]: value })
    assert.ok(depth >= 0 && Number.isFinite(depth), `${value} produced ${depth}`)
  }
  // A garbage value must not read as "infinitely deep" and lock the product out.
  assert.equal(agentGenerationDepthExceeded({ [AGENT_GENERATION_DEPTH_ENV]: 'many' }), false)
})

test('the official subagent child inherits the markers instead of looking like a fresh root', () => {
  // This boundary rebuilds the child environment from an allowlist. Dropping the
  // markers here handed every spawned Codex a process indistinguishable from a
  // first invocation, so its own hooks had no reason to refuse another fan-out.
  const childEnv = buildOfficialSubagentChildEnv({ env: {} })
  assert.equal(childEnv.SKS_AGENT_WORKER, '1')
  assert.equal(childEnv.SKS_DISABLE_ROUTE_RECURSION, '1')
  assert.equal(childEnv[AGENT_GENERATION_DEPTH_ENV], '1')
  assert.equal(agentWorkerHookContext({}, {}, childEnv), true)
})

test('a child spawned from inside a worker carries the next generation, not the same one', () => {
  const childEnv = buildOfficialSubagentChildEnv({
    env: { ...WORKER_ENV, [AGENT_GENERATION_DEPTH_ENV]: '1' }
  })
  assert.equal(childEnv[AGENT_GENERATION_DEPTH_ENV], '2')
  assert.equal(agentGenerationDepthExceeded(childEnv), true)
})

test('the child environment still carries no secret-bearing variable', () => {
  // The allowlist grew, so re-assert what it exists to keep out.
  const childEnv = buildOfficialSubagentChildEnv({
    env: {
      OPENAI_API_KEY: 'sk-should-never-appear',
      AWS_SECRET_ACCESS_KEY: 'should-never-appear',
      HTTPS_PROXY: 'http://user:pass@proxy.invalid'
    } as NodeJS.ProcessEnv
  })
  const rendered = JSON.stringify(childEnv)
  assert.equal(rendered.includes('should-never-appear'), false)
  assert.equal(rendered.includes('user:pass'), false)
})
