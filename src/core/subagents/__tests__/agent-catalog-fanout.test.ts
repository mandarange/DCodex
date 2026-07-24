import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { classifyTaskProfile } from '../../runtime/task-profile.js'
import {
  MAX_ON_DEMAND_SUBAGENT_ROLE_COUNT,
  officialSubagentFanoutPolicy,
  officialSubagentOnDemandRoleCatalog,
  officialSubagentRoleCatalog,
  officialSubagentRolePlan,
  recommendOfficialSubagentRoles,
  selectOfficialSubagentRole
} from '../agent-catalog.js'
import { prepareOfficialSubagentMission } from '../official-subagent-preparation.js'

test('automatic fanout scales bounded, parallel, large-scale, and reviewer-only work differently', () => {
  const pinned = {
    cores: 4,
    freeMemoryBytes: 3 * 1024 * 1024 * 1024,
    totalMemoryBytes: 16 * 1024 * 1024 * 1024,
    processCount: 40,
    fileDescriptorLimit: 64,
    remoteApiRateLimitBudget: 4,
    localLlmMaxParallelRequests: 4
  }
  const bounded = officialSubagentFanoutPolicy({
    taskProfile: classifyTaskProfile('implement the parser fix'),
    goal: 'implement the parser fix',
    suggestedRoles: ['implementation_specialist'],
    hardware: pinned,
    maxThreads: 12
  })
  assert.equal(bounded.requested_subagents, 4)
  assert.equal(bounded.default_subagents, 4)
  assert.match(bounded.selection_reason, /non_trivial_default_parallel/)

  const singleRisk = officialSubagentFanoutPolicy({
    taskProfile: classifyTaskProfile('apply the database migration'),
    goal: 'apply the database migration',
    suggestedRoles: ['database_reviewer'],
    hardware: pinned
  })
  assert.equal(singleRisk.requested_subagents, 2)

  const parallel = officialSubagentFanoutPolicy({
    taskProfile: classifyTaskProfile('fix independent files in parallel'),
    goal: 'fix independent files in parallel',
    suggestedRoles: ['implementation_specialist', 'test_engineer'],
    hardware: pinned,
    maxThreads: 12
  })
  assert.equal(parallel.requested_subagents, 6)
  assert.match(parallel.selection_reason, /explicit_parallel_or_independent_slices/)
  assert.equal(parallel.automatic_reviewer_ceiling, 2)

  const largeScale = officialSubagentFanoutPolicy({
    taskProfile: classifyTaskProfile('implement a large-scale repository-wide migration with many independent files'),
    goal: 'implement a large-scale repository-wide migration with many independent files',
    suggestedRoles: ['implementation_specialist', 'test_engineer', 'integration_reviewer'],
    hardware: pinned,
    maxThreads: 12
  })
  assert.equal(largeScale.requested_subagents, 8)
  assert.equal(largeScale.automatic_ceiling, 12)
  assert.match(largeScale.selection_reason, /large_scale_dynamic_parallel/)

  const abundant = officialSubagentFanoutPolicy({
    taskProfile: classifyTaskProfile('fix independent files in parallel'),
    goal: 'fix independent files in parallel',
    suggestedRoles: ['implementation_specialist', 'test_engineer'],
    maxThreads: 12,
    hardware: {
      cores: 16,
      freeMemoryBytes: 64 * 1024 * 1024 * 1024,
      totalMemoryBytes: 128 * 1024 * 1024 * 1024,
      processCount: 10,
      fileDescriptorLimit: 4096,
      remoteApiRateLimitBudget: 24,
      localLlmMaxParallelRequests: 12
    }
  })
  assert.ok(abundant.requested_subagents >= 6)
  assert.ok(abundant.requested_subagents <= 12)
  assert.match(abundant.selection_reason, /hardware_capacity_boost/)

  const independentRisk = officialSubagentFanoutPolicy({
    taskProfile: classifyTaskProfile('audit database migration security and permissions'),
    goal: 'audit database migration security and permissions',
    suggestedRoles: ['database_reviewer', 'security_reviewer'],
    hardware: pinned
  })
  assert.equal(independentRisk.requested_subagents, 2)
  assert.deepEqual(independentRisk.risk_domains.sort(), ['database', 'security'])

  const critical = officialSubagentFanoutPolicy({
    taskProfile: classifyTaskProfile('critical production database security release audit'),
    goal: 'critical production database security release audit',
    suggestedRoles: ['database_reviewer', 'security_reviewer', 'release_reviewer'],
    hardware: pinned
  })
  assert.equal(critical.requested_subagents, 3)
  assert.equal(critical.automatic_ceiling, 3)
  assert.equal(critical.automatic_reviewer_ceiling, 3)
  assert.equal(critical.critical_multi_domain, true)
})

test('narrow specialists outrank a bounded Luna worker for UI, test, and root-cause language', () => {
  assert.equal(selectOfficialSubagentRole({
    description: 'UI exact bounded change',
    requiresWrite: true
  }), 'ui_implementer')
  assert.equal(selectOfficialSubagentRole({
    description: 'debug exact bounded failure and find the root cause',
    readOnly: true
  }), 'debugger')
  assert.equal(selectOfficialSubagentRole({
    description: 'add one exact bounded regression test fixture',
    requiresWrite: true
  }), 'test_engineer')
})

test('specialist selection covers implementation, judgment, long-context, and Codex tool roles', () => {
  const cases = [
    ['Implement the macOS AppKit menu bar NSStatusItem modal', 'native_app_specialist', false],
    ['Upgrade the npm dependency and repair install doctor build scripts', 'toolchain_specialist', false],
    ['Review the MCP SDK wire protocol schema and backward compatibility', 'protocol_reviewer', true],
    ['Audit hook session locks process cleanup idempotency and deadlock recovery', 'runtime_reliability_reviewer', true],
    ['Validate TriWiki context pack provenance trust anchors and proof artifacts', 'triwiki_evidence_reviewer', true],
    ['Analyze several large files and extensive logs as long context', 'long_context_analyst', true],
    ['Use Computer Use to inspect macOS System Settings', 'computer_use_operator', true],
    ['Use Chrome browser on localhost to capture webapp evidence', 'browser_use_operator', true],
    ['Generate a visual asset with gpt-image-2 imagegen', 'image_generation_operator', false]
  ] as const

  for (const [description, expected, readOnly] of cases) {
    assert.equal(selectOfficialSubagentRole({
      description,
      readOnly,
      requiresWrite: !readOnly
    }), expected)
  }
})

test('mixed tool and judgment recommendations put Sol Max judgment first and retain the Terra operator', () => {
  const securityBrowser = recommendOfficialSubagentRoles({
    description: 'Security review using Chrome browser evidence',
    readOnly: true,
    limit: 3
  })
  assert.equal(securityBrowser[0], 'security_reviewer')
  assert.ok(securityBrowser.includes('browser_use_operator'))

  const debugLongContext = recommendOfficialSubagentRoles({
    description: 'Debug a failure across several large files and extensive logs',
    readOnly: true,
    limit: 3
  })
  assert.equal(debugLongContext[0], 'debugger')
  assert.ok(debugLongContext.includes('long_context_analyst'))
})

test('writable documentation plus code-fix goals retain implementation coverage', () => {
  const roles = recommendOfficialSubagentRoles({
    description: 'Update the Codex integration documentation and implement the scheduler fix',
    requiresWrite: true,
    limit: 6
  })

  assert.ok(roles.includes('docs_maintainer'))
  assert.ok(roles.includes('implementation_specialist'))
})

test('on-demand role metadata is unique, alias-aware, and bounded independently of the installed catalog', () => {
  const full = officialSubagentRoleCatalog()
  const selected = officialSubagentOnDemandRoleCatalog([
    'macos-specialist',
    'native_app_specialist',
    'protocol-reviewer',
    'runtime-reliability-reviewer',
    'triwiki-evidence-reviewer',
    'toolchain-specialist'
  ])

  assert.equal(full.length, 25)
  assert.equal(selected.length, 5)
  assert.deepEqual(selected.map((role) => role.name), [
    'native_app_specialist',
    'protocol_reviewer',
    'runtime_reliability_reviewer',
    'triwiki_evidence_reviewer',
    'toolchain_specialist'
  ])
  assert.equal(new Set(selected.map((role) => role.description)).size, selected.length)
  assert.ok(full.every((role) => role.model_policy.length > 0))
})

test('read-only slices select only explicitly read-only custom agents', () => {
  const roles = recommendOfficialSubagentRoles({
    description: 'Apply exact bounded rename',
    readOnly: true,
    requiresWrite: false,
    limit: 3
  })
  assert.deepEqual(roles, ['expert'])
})

test('explicit operator agent count remains authoritative', () => {
  const policy = officialSubagentFanoutPolicy({
    requestedSubagents: 7,
    requestedExplicit: true,
    taskProfile: 'bounded-work',
    goal: 'implement one bounded change'
  })
  assert.equal(policy.requested_subagents, 7)
  assert.equal(policy.mode, 'explicit_operator_count')
  assert.equal(policy.selection_reason, 'explicit_operator_count_preserved')
})

test('parent decomposition may expand useful implementation shards but not reviewer-only clones', () => {
  const implementation = officialSubagentFanoutPolicy({
    taskProfile: 'parallel-write',
    goal: 'implement independent modules',
    suggestedRoles: ['implementation_specialist', 'test_engineer'],
    independentSliceCount: 8
  })
  assert.equal(implementation.requested_subagents, 8)
  assert.equal(implementation.automatic_ceiling, 12)
  assert.equal(implementation.selection_reason, 'parent_decomposed_independent_slices')

  const reviewers = officialSubagentFanoutPolicy({
    taskProfile: 'parallel-read',
    goal: 'review independent modules',
    suggestedRoles: ['architecture_reviewer', 'security_reviewer'],
    independentSliceCount: 8
  })
  assert.equal(reviewers.requested_subagents, 2)
  assert.equal(reviewers.automatic_ceiling, 2)
})

test('route-owned orchestration count remains authoritative without masquerading as an operator request', () => {
  const policy = officialSubagentFanoutPolicy({
    requestedSubagents: 3,
    requestedExplicit: true,
    requestedSource: 'route_contract',
    taskProfile: 'bounded-work',
    goal: 'run the Research adversarial review contract'
  })
  assert.equal(policy.requested_subagents, 3)
  assert.equal(policy.mode, 'route_owned_contract_count')
  assert.equal(policy.count_source, 'route_contract')
  assert.equal(policy.selection_reason, 'route_owned_contract_count_preserved')
})

test('mission preparation writes the selected automatic count into plan, budget, prompt, and evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-agent-fanout-plan-'))
  const dir = path.join(root, '.sneakoscope', 'missions', 'M-fanout')
  await fs.mkdir(dir, { recursive: true })

  const automatic = await prepareOfficialSubagentMission({
    root,
    dir,
    missionId: 'M-fanout',
    goal: 'fix independent files in parallel',
    route: '$Naruto',
    mode: 'naruto'
  })
  assert.ok(automatic.plan.requested_subagents >= 6)
  assert.ok(automatic.plan.requested_subagents <= 12)
  assert.equal(automatic.budget.requestedSubagents, automatic.plan.requested_subagents)
  assert.equal(automatic.evidence.requested_subagents, automatic.plan.requested_subagents)
  assert.equal(automatic.fanoutPolicy.requested_subagents, automatic.plan.requested_subagents)
  assert.match(automatic.delegationPrompt, new RegExp(`requested subagents: ${automatic.plan.requested_subagents}`))
  assert.equal(automatic.plan.capacity_controller.max_threads_is_cap_not_target, true)
  assert.equal(automatic.plan.agent_catalog.mode, 'on_demand')
  assert.equal(automatic.plan.agent_catalog.full_catalog_injected, false)
  assert.equal(automatic.plan.agent_catalog.total_available, 25)
  assert.equal(Object.keys(automatic.plan.agents).length, automatic.plan.suggested_agents.length)
  assert.equal(Object.keys(automatic.plan.agents).length <= MAX_ON_DEMAND_SUBAGENT_ROLE_COUNT, true)
  assert.equal(
    JSON.stringify(automatic.plan.agents).length < JSON.stringify(officialSubagentRolePlan()).length / 2,
    true
  )

  const explicitDir = path.join(root, '.sneakoscope', 'missions', 'M-explicit')
  await fs.mkdir(explicitDir, { recursive: true })
  const explicit = await prepareOfficialSubagentMission({
    root,
    dir: explicitDir,
    missionId: 'M-explicit',
    goal: 'implement one bounded change',
    route: '$Naruto',
    requestedSubagents: 7,
    requestedSubagentsExplicit: true,
    mode: 'naruto'
  })
  assert.equal(explicit.plan.requested_subagents, 7)
  assert.equal(explicit.evidence.requested_subagents, 7)
  assert.equal(explicit.fanoutPolicy.requested_subagents, 7)

  const researchDir = path.join(root, '.sneakoscope', 'missions', 'M-research')
  await fs.mkdir(researchDir, { recursive: true })
  const research = await prepareOfficialSubagentMission({
    root,
    dir: researchDir,
    missionId: 'M-research',
    goal: 'Review the research evidence and falsification results',
    route: '$Research',
    mode: 'generic',
    readOnly: true
  })
  assert.equal(research.plan.requested_subagents, 3)
  assert.equal(research.plan.requested_subagents_explicit, false)
  assert.equal(research.plan.requested_subagents_source, 'route_contract')
  assert.equal(research.plan.route_owned_count_contract?.count, 3)
  assert.equal(research.fanoutPolicy.selection_reason, 'route_owned_contract_count_preserved')
  assert.match(research.delegationPrompt, /3 \(route-owned exact orchestration contract\)/)
  assert.doesNotMatch(research.delegationPrompt, /3 \(explicit operator request\)/)

  const autoresearchDir = path.join(root, '.sneakoscope', 'missions', 'M-autoresearch')
  await fs.mkdir(autoresearchDir, { recursive: true })
  const autoresearch = await prepareOfficialSubagentMission({
    root,
    dir: autoresearchDir,
    missionId: 'M-autoresearch',
    goal: 'Run the experiment loop and adversarial convergence review',
    route: '$AutoResearch',
    mode: 'generic',
    readOnly: true
  })
  assert.equal(autoresearch.plan.requested_subagents, 3)
  assert.equal(autoresearch.plan.requested_subagents_source, 'route_contract')
  assert.equal(autoresearch.plan.route_owned_count_contract?.reason, 'autoresearch_exact_three_independent_reviewers')
})

test('prepared decomposition applies capacity bounds and fails closed on overlapping writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-agent-capacity-plan-'))
  const safeDir = path.join(root, '.sneakoscope', 'missions', 'M-safe-capacity')
  await fs.mkdir(safeDir, { recursive: true })
  const safe = await prepareOfficialSubagentMission({
    root,
    dir: safeDir,
    missionId: 'M-safe-capacity',
    goal: 'implement four independent modules in parallel',
    route: '$Naruto',
    mode: 'naruto',
    slices: Array.from({ length: 4 }, (_, index) => ({
      id: `S${index + 1}`,
      title: `Module ${index + 1}`,
      description: `Implement module ${index + 1}`,
      kind: 'worker' as const,
      agent: 'implementation_specialist',
      paths: [`src/module-${index + 1}`]
    })),
    capacity: { verifierCapacity: 2 }
  })
  assert.equal(safe.plan.decomposition_status, 'ready')
  assert.equal(safe.plan.requested_subagents, 4)
  assert.equal(safe.plan.first_wave, 2)
  assert.equal(safe.plan.capacity_controller.limiting_factors.includes('verifier_capacity'), true)
  assert.equal(safe.plan.slice_safety.safe, true)

  const blockedDir = path.join(root, '.sneakoscope', 'missions', 'M-blocked-capacity')
  await fs.mkdir(blockedDir, { recursive: true })
  const blocked = await prepareOfficialSubagentMission({
    root,
    dir: blockedDir,
    missionId: 'M-blocked-capacity',
    goal: 'implement overlapping modules in parallel',
    route: '$Naruto',
    mode: 'naruto',
    slices: [
      { id: 'A', title: 'Core', description: 'Change core', kind: 'worker', paths: ['src/core'] },
      { id: 'B', title: 'Nested', description: 'Change nested core', kind: 'worker', paths: ['src/core/subagents'] }
    ]
  })
  assert.equal(blocked.plan.slice_safety.safe, false)
  assert.equal(blocked.plan.first_wave, 0)
  assert.ok(blocked.plan.config_blockers.some((value: string) => value.startsWith('subagent_slice:overlapping_write_scope:')))
  assert.ok(blocked.plan.config_blockers.includes('subagent_capacity_exhausted'))
  assert.equal(blocked.evidence.ok, false)
})
