import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNarutoGateResult, narutoCommand, parseNarutoArgs } from '../naruto-command.js'
import { buildNarutoHelpResult } from '../../subagents/naruto-help-contract.js'
import { HARD_NARUTO_MAX_THREADS } from '../../subagents/thread-budget.js'

test('normal Naruto blocks command-local GLM before any provider delegation', async () => {
  const previousExitCode = process.exitCode
  const previousLog = console.log
  const output: string[] = []
  console.log = (...args: unknown[]) => output.push(args.map(String).join(' '))
  try {
    process.exitCode = undefined
    const result: any = await narutoCommand(['--glm', '--json'])
    assert.equal(process.exitCode, 1)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'naruto_gpt_5_6_family_only_glm_override_forbidden')
    assert.deepEqual(result.blockers, ['naruto_gpt_5_6_family_only_glm_override_forbidden'])
    assert.match(output.join('\n'), /naruto_gpt_5_6_family_only_glm_override_forbidden/)
  } finally {
    console.log = previousLog
    process.exitCode = previousExitCode
  }
})

test('Naruto keeps requested official subagent counts and canonical thread and project-trust flags', () => {
  const parsed = parseNarutoArgs([
    'run', 'review', 'the', 'packages', '--agents', '12', '--max-threads', '8', '--trusted-project', '--json'
  ])
  assert.equal(parsed.action, 'run')
  assert.equal(parsed.prompt, 'review the packages')
  assert.equal(parsed.requestedSubagents, 12)
  assert.equal(parsed.maxThreads, 8)
  assert.equal(parsed.trustedProject, true)
  assert.deepEqual(parsed.argumentErrors, [])
})

test('Naruto parser accepts equals syntax and rejects malformed or empty paid fanout requests', () => {
  const equals = parseNarutoArgs(['run', 'review packages', '--agents=12', '--max-threads=8'])
  assert.equal(equals.requestedSubagents, 12)
  assert.equal(equals.maxThreads, 8)
  assert.deepEqual(equals.argumentErrors, [])

  const missing = parseNarutoArgs(['run', 'review packages', '--agents', '--max-threads=oops'])
  assert.ok(missing.argumentErrors.includes('missing_option_value:--agents'))
  assert.ok(missing.argumentErrors.includes('invalid_positive_integer:--max-threads=oops'))

  const empty = parseNarutoArgs(['run', '--agents=8'])
  assert.ok(empty.argumentErrors.includes('empty_task'))

  for (const args of [
    ['--json', 'status', 'latest'],
    ['--agents=8', 'status'],
    ['--max-threads=12', 'proof', 'latest'],
    ['--agents=8', 'run', 'task']
  ]) {
    const misplaced = parseNarutoArgs(args)
    assert.ok(misplaced.argumentErrors.some((error) => error.startsWith('misplaced_subcommand:')), args.join(' '))
  }

  const removedAfterOption = parseNarutoArgs(['--agents=8', 'dashboard'])
  assert.ok(removedAfterOption.argumentErrors.includes('unknown_subcommand:dashboard'))

  const explicitTaskAfterSeparator = parseNarutoArgs(['run', '--', 'dashboard'])
  assert.equal(explicitTaskAfterSeparator.prompt, 'dashboard')
  assert.deepEqual(explicitTaskAfterSeparator.argumentErrors, [])

  const trustTokenAfterSeparator = parseNarutoArgs(['run', '--', '--trusted-project'])
  assert.equal(trustTokenAfterSeparator.prompt, '--trusted-project')
  assert.equal(trustTokenAfterSeparator.trustedProject, false)
  assert.deepEqual(trustTokenAfterSeparator.argumentErrors, [])

  assert.equal(parseNarutoArgs(['run', 'task']).trustedProject, false)

  for (const flag of ['--json=true', '--stdin=true', '--read-only=true', '--readonly=false', '--trusted-project=true', '--help=true']) {
    const booleanValue = parseNarutoArgs(['run', 'task', flag])
    assert.ok(booleanValue.argumentErrors.some((error) => error.startsWith('boolean_option_value_not_supported:')), flag)
  }
})

test('Naruto parser accepts large fan-out up to the hard thread cap and rejects beyond it', () => {
  const large = parseNarutoArgs(['run', 'review packages', '--agents', '100', '--max-threads', '128'])
  assert.equal(large.requestedSubagents, 100)
  assert.equal(large.maxThreads, 128)
  assert.deepEqual(large.argumentErrors, [])

  const atCap = parseNarutoArgs([
    'run', 'review packages',
    `--agents=${HARD_NARUTO_MAX_THREADS}`,
    `--max-threads=${HARD_NARUTO_MAX_THREADS}`
  ])
  assert.equal(atCap.requestedSubagents, HARD_NARUTO_MAX_THREADS)
  assert.equal(atCap.maxThreads, HARD_NARUTO_MAX_THREADS)
  assert.deepEqual(atCap.argumentErrors, [])

  const beyondCap = HARD_NARUTO_MAX_THREADS + 1
  const agentsBeyond = parseNarutoArgs(['run', 'review packages', `--agents=${beyondCap}`])
  assert.equal(agentsBeyond.requestedSubagents, beyondCap)
  assert.ok(agentsBeyond.argumentErrors.includes(`exceeds_hard_thread_cap:--agents=${beyondCap}:${HARD_NARUTO_MAX_THREADS}`))

  const threadsBeyond = parseNarutoArgs(['run', 'review packages', `--max-threads=${beyondCap}`])
  assert.equal(threadsBeyond.maxThreads, beyondCap)
  assert.ok(threadsBeyond.argumentErrors.includes(`exceeds_hard_thread_cap:--max-threads=${beyondCap}:${HARD_NARUTO_MAX_THREADS}`))
})

test('Naruto parent-summary parser requires the exact active-mission stdin surface', () => {
  const valid = parseNarutoArgs([
    'parent-summary', '--mission', 'M-parent-summary', '--stdin', '--json'
  ])
  assert.equal(valid.action, 'parent-summary')
  assert.equal(valid.missionId, 'M-parent-summary')
  assert.equal(valid.stdin, true)
  assert.deepEqual(valid.argumentErrors, [])

  assert.ok(parseNarutoArgs(['parent-summary', '--stdin'])
    .argumentErrors.includes('parent_summary_requires_explicit_mission'))
  assert.ok(parseNarutoArgs(['parent-summary', '--mission', 'M-parent-summary'])
    .argumentErrors.includes('parent_summary_requires_stdin'))
  assert.ok(parseNarutoArgs(['parent-summary', '--mission', 'latest', '--stdin'])
    .argumentErrors.includes('parent_summary_requires_explicit_mission'))
  assert.ok(parseNarutoArgs(['parent-summary', '--mission-id', 'M-parent-summary', '--stdin'])
    .argumentErrors.includes('parent_summary_mission_id_alias_not_supported'))
  assert.ok(parseNarutoArgs(['parent-summary', '--mission', 'M-parent-summary', '--stdin', '--agents', '2'])
    .argumentErrors.includes('parent_summary_unsupported_run_option'))
  assert.ok(parseNarutoArgs(['status', 'latest', '--stdin'])
    .argumentErrors.includes('stdin_only_supported_for_parent_summary'))
})

test('Naruto parser treats non-current backend scheduler pool and model options as unknown', () => {
  const parsed = parseNarutoArgs([
    'run', 'review packages',
    '--backend=codex-sdk',
    '--scheduler', 'legacy',
    '--pool-size=4',
    '--model', 'gpt-5.6-terra'
  ])
  assert.deepEqual(parsed.argumentErrors, [
    'unsupported_argument:--backend',
    'unsupported_argument:--scheduler',
    'unsupported_argument:--pool-size',
    'unsupported_argument:--model'
  ])
})

test('unknown Naruto subcommand fails closed instead of becoming a paid run task', async () => {
  const parsed = parseNarutoArgs(['dashboard', 'latest'])
  assert.equal(parsed.action, 'run')
  assert.ok(parsed.argumentErrors.includes('unknown_subcommand:dashboard'))

  const previousExitCode = process.exitCode
  const previousError = console.error
  const previousLog = console.log
  console.error = () => undefined
  console.log = () => undefined
  try {
    process.exitCode = undefined
    const result: any = await narutoCommand(['dashboard', 'latest', '--json'])
    assert.equal(process.exitCode, 1)
    assert.equal(result.ok, false)
    assert.ok(result.blockers.includes('invalid_naruto_argument:unknown_subcommand:dashboard'))
  } finally {
    console.error = previousError
    console.log = previousLog
    process.exitCode = previousExitCode
  }
})

test('direct Naruto help uses the exact shared fast-help JSON contract', async () => {
  const previousLog = console.log
  console.log = () => undefined
  try {
    const result = await narutoCommand(['help', '--json'])
    assert.deepEqual(result, buildNarutoHelpResult())
  } finally {
    console.log = previousLog
  }
})

test('human Naruto help renders model mapping nesting and durable parent evidence', async () => {
  const previousLog = console.log
  const output: string[] = []
  console.log = (...args: unknown[]) => output.push(args.map(String).join(' '))
  try {
    await narutoCommand(['help'])
    const text = output.join('\n')
    assert.match(text, /Parent: gpt-5\.6-sol \/ max/)
    assert.match(text, /Worker: gpt-5\.6-luna \/ max/)
    assert.match(text, /Expert: gpt-5\.6-sol \/ max/)
    assert.match(text, /max_depth=1/)
    assert.match(text, /subagent-parent-summary\.json/)
  } finally {
    console.log = previousLog
  }
})

test('Naruto rejects removed aliases instead of redirecting them', () => {
  const parsed = parseNarutoArgs(['workers', 'latest', '--clones', '8'])
  assert.equal(parsed.action, 'run')
  assert.equal(parsed.missionId, 'latest')
  assert.equal(parsed.requestedSubagents, undefined)
  assert.ok(parsed.argumentErrors.includes('unknown_subcommand:workers'))
  assert.ok(parsed.argumentErrors.includes('unsupported_argument:--clones'))
})

test('standalone and hook completion share the canonical Naruto gate fields', () => {
  const gate = buildNarutoGateResult({
    missionId: 'M-gate-shape',
    passed: true,
    ssotGuard: true,
    blockers: [],
    evidence: {
      ok: true,
      requested_subagents: 2,
      count_policy: 'exact',
      target_subagents: 2,
      started_threads: 2,
      completed_threads: 2,
      failed_threads: 0,
      parent_summary_present: true,
      event_sources: ['SubagentStart', 'SubagentStop'],
      blockers: []
    }
  })
  assert.equal(gate.status, 'passed')
  assert.equal(gate.subagent_plan_ready, true)
  assert.equal(gate.official_subagent_evidence, true)
  assert.equal(gate.session_cleanup, true)
  assert.deepEqual(gate.missing_fields, [])
})

test('Naruto gate cleanup binds the effective target and rejects unsafe thread state', () => {
  const dynamic = buildNarutoGateResult({
    missionId: 'M-dynamic-gate',
    passed: true,
    ssotGuard: true,
    blockers: [],
    evidence: {
      ok: true,
      requested_subagents: 2,
      count_policy: 'dynamic_automatic',
      target_subagents: 4,
      started_threads: 4,
      completed_threads: 4,
      failed_threads: 0,
      open_thread_ids: [],
      unmatched_stop_thread_ids: [],
      ambiguous_stop_thread_ids: [],
      parent_summary_present: true
    }
  })
  assert.equal(dynamic.requested_subagents, 2)
  assert.equal(dynamic.count_policy, 'dynamic_automatic')
  assert.equal(dynamic.target_subagents, 4)
  assert.equal(dynamic.session_cleanup, true)

  for (const unsafe of [
    { open_thread_ids: ['open'] },
    { unmatched_stop_thread_ids: ['unmatched'] },
    { ambiguous_stop_thread_ids: ['ambiguous'] },
    { failed_threads: 1 },
    { completed_threads: 3 }
  ]) {
    const gate = buildNarutoGateResult({
      missionId: 'M-unsafe-gate',
      passed: false,
      evidence: {
        ...dynamic.evidence,
        ok: false,
        requested_subagents: 2,
        count_policy: 'dynamic_automatic',
        target_subagents: 4,
        started_threads: 4,
        completed_threads: 4,
        failed_threads: 0,
        open_thread_ids: [],
        unmatched_stop_thread_ids: [],
        ambiguous_stop_thread_ids: [],
        ...unsafe
      }
    })
    assert.equal(gate.session_cleanup, false)
  }
})
