import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_NARUTO_MAX_THREADS,
  DEFAULT_NARUTO_REQUESTED_SUBAGENTS,
  HARD_NARUTO_MAX_THREADS,
  resolveSubagentThreadBudget
} from '../thread-budget.js'
import {
  normalizeOfficialSubagentPolicy,
  officialSubagentPipelineStage,
  routeRequiresOfficialSubagents
} from '../../agents/agent-plan.js'
import { routePrompt } from '../../routes.js'

test('official thread budget defaults to four children while reserving only the parent frame slot', () => {
  assert.equal(DEFAULT_NARUTO_REQUESTED_SUBAGENTS, 4)
  assert.equal(DEFAULT_NARUTO_MAX_THREADS, 12)
  assert.equal(HARD_NARUTO_MAX_THREADS, 32)
  const budget = resolveSubagentThreadBudget()
  assert.equal(budget.requestedSubagents, 4)
  assert.equal(budget.maxThreads, 12)
  assert.equal(budget.firstWave, 4)
  assert.equal(budget.waveCount, 1)
  assert.equal(budget.maxDepth, 1)
  assert.equal(budget.capacity.max_threads_is_cap_not_target, true)
  assert.equal(budget.capacity.available_thread_slots, 11)
  assert.equal(budget.capacity.reservations.reviewer_threads, 0)
})

test('max_threads is a cap rather than a target and leaves a protected root slot', () => {
  const budget = resolveSubagentThreadBudget({ requested: 12, configuredMaxThreads: 12 })
  assert.equal(budget.requestedSubagents, 12)
  assert.equal(budget.firstWave, 11)
  assert.equal(budget.waveCount, 2)
  assert.ok(budget.capacity.limiting_factors.includes('available_thread_slots'))
})

test('small thread caps keep one executable child slot by making reservations elastic', () => {
  const budget = resolveSubagentThreadBudget({
    requested: 2,
    configuredMaxThreads: 2,
    parentReservedThreads: 1,
    reviewerReservedThreads: 1
  })
  assert.equal(budget.firstWave, 1)
  assert.equal(budget.waveCount, 2)
  assert.equal(budget.capacity.available_thread_slots, 1)
  assert.deepEqual(budget.capacity.reservations, {
    parent_threads: 1,
    reviewer_threads: 0,
    active_threads: 0
  })
  assert.equal(budget.capacity.exhausted, false)
})

test('explicit twenty subagents remain twenty with capacity-governed waves', () => {
  const budget = resolveSubagentThreadBudget({ requested: 20, configuredMaxThreads: 12 })
  assert.equal(budget.requestedSubagents, 20)
  assert.equal(budget.firstWave, 11)
  assert.equal(budget.waveCount, 2)
  assert.equal(budget.maxDepth, 1)
})

test('thread budget enforces the official hard safety ceiling', () => {
  const budget = resolveSubagentThreadBudget({ requested: 100, configuredMaxThreads: 100 })
  assert.equal(budget.requestedSubagents, 32)
  assert.equal(budget.maxThreads, 32)
  assert.equal(budget.firstWave, 31)
})

test('Naruto concurrency is not capped at four profiles or four desktop slots', () => {
  const budget = resolveSubagentThreadBudget({ requested: 8, configuredMaxThreads: 12 })
  assert.equal(budget.requestedSubagents, 8)
  assert.equal(budget.firstWave, 8)
  assert.ok(budget.firstWave > 4)
  assert.equal(budget.capacity.available_thread_slots, 11)
})

test('idle reviewer reservation no longer collapses max_threads=6 to four children', () => {
  const budget = resolveSubagentThreadBudget({ requested: 6, configuredMaxThreads: 6 })
  assert.equal(budget.firstWave, 5)
  assert.ok(budget.firstWave > 4)
  assert.equal(budget.capacity.reservations.reviewer_threads, 0)
})

test('dynamic capacity is the minimum useful safe bound', () => {
  const budget = resolveSubagentThreadBudget({
    requested: 10,
    configuredMaxThreads: 12,
    readyDagWidth: 8,
    disjointOwnershipCount: 6,
    verifierCapacity: 4,
    toolConcurrency: 7,
    marginalUsefulWorkers: 5
  })
  assert.equal(budget.firstWave, 4)
  assert.equal(budget.waveCount, 3)
  assert.deepEqual(budget.capacity.limiting_factors, ['verifier_capacity'])
  assert.equal(budget.capacity.bounds.disjoint_ownership, 6)
})

test('non-positive marginal useful throughput blocks a new wave', () => {
  const budget = resolveSubagentThreadBudget({
    requested: 6,
    configuredMaxThreads: 12,
    marginalUsefulThroughputPositive: false
  })
  assert.equal(budget.firstWave, 0)
  assert.equal(budget.waveCount, 0)
  assert.equal(budget.capacity.exhausted, true)
  assert.deepEqual(budget.capacity.limiting_factors, ['marginal_useful_workers'])
})

test('official subagent requirement is task-profile aware and canonical-route bound', () => {
  assert.equal(routeRequiresOfficialSubagents('$Naruto', { task: 'implement feature' }), true)
  assert.equal(routeRequiresOfficialSubagents('$Research', { task: 'How does this mechanism work?' }), false)
  assert.equal(routeRequiresOfficialSubagents('$DFix', { task: 'fix a typo' }), false)
  assert.equal(routeRequiresOfficialSubagents('$Release-Review', { task: 'fix the release metadata' }), true)
  assert.equal(routeRequiresOfficialSubagents('$Release-Review', { task: 'fix release metadata in parallel across independent files' }), true)
  assert.equal(routeRequiresOfficialSubagents(routePrompt('work on the parser'), { task: 'work on the parser' }), true)
  assert.equal(routeRequiresOfficialSubagents(routePrompt('What is a parser?'), { task: 'What is a parser?' }), false)
  assert.equal(routeRequiresOfficialSubagents(routePrompt('$Work'), { task: '$Work' }), true)
  assert.equal(routeRequiresOfficialSubagents(routePrompt('parallel implementation'), { task: 'parallel implementation' }), true)
})

test('official subagent policy exposes requested count, waves, and canonical evidence outputs', () => {
  const policy = normalizeOfficialSubagentPolicy('$Naruto', 'implement feature', {
    requestedSubagents: 20,
    maxThreads: 12
  })
  assert.equal(policy.schema, 'sks.official-subagent-policy.v1')
  assert.equal(policy.requested_subagents, 20)
  assert.equal(policy.max_threads, 12)
  assert.equal(policy.wave_count, 2)
  assert.equal(policy.first_wave, 11)
  assert.equal(policy.backend, 'official-codex-subagent')
  assert.ok(policy.outputs.includes('subagent-evidence.json'))

  const stage = officialSubagentPipelineStage(policy)
  assert.equal(stage.workflow, 'official_codex_subagent')
  assert.equal(stage.requested_subagents, 20)
  assert.equal(stage.max_parallel_agent_threads, 11)
  assert.equal(stage.max_depth, 1)
})
