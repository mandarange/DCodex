import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { sha256 } from '../../fsx.js'
import { HOST_CAPABILITY_DESCRIPTORS, hostCapabilityDigest } from '../../agent-bridge/agent-manifest.js'
import {
  SUBAGENT_PARENT_SUMMARY_SCHEMA,
  SUBAGENT_PARENT_SUMMARY_FILENAME,
  SUBAGENT_EVIDENCE_FILENAME,
  SUBAGENT_EVENT_LOG_FILENAME,
  bindTrustworthySubagentParentSummaryToRun,
  buildSubagentEvidence,
  normalizeSubagentEvent,
  persistOrReuseTrustworthySubagentParentSummary,
  readSubagentEvents,
  recordSubagentEvent,
  writeSubagentEvidence
} from '../subagent-evidence.js'

function parentSummary(threadIds: string[], status: 'completed' | 'blocked' | 'failed' = 'completed') {
  return {
    schema: SUBAGENT_PARENT_SUMMARY_SCHEMA,
    status,
    summary: status === 'completed' ? 'Integrated every requested slice.' : 'Parent reported a blocked workflow.',
    thread_outcomes: threadIds.map((threadId) => ({
      thread_id: threadId,
      status,
      summary: `${threadId}:${status}`
    })),
    changed_files: [],
    verification: [],
    blockers: status === 'completed' ? [] : ['fixture_blocker']
  }
}

function hostCapabilityEvidence(status: 'passed' | 'failed' = 'passed') {
  const artifact = {
    path: 'reports/monthly.xlsx',
    kind: 'spreadsheet',
    media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sha256: `sha256:${'a'.repeat(64)}`,
    bytes: 4,
    role: 'deliverable' as const
  }
  const blocker = status === 'failed' ? 'host_capability_call_failed:host.spreadsheet.workbook.v1' : null
  const createEventHash = `sha256:${'d'.repeat(64)}`
  const inspectEventHash = `sha256:${'1'.repeat(64)}`
  const toolCalls = status === 'passed'
    ? [{ server: 'acas-tools', tool: 'spreadsheet_create', status, event_sha256: createEventHash },
        { server: 'acas-tools', tool: 'spreadsheet_inspect', status, event_sha256: inspectEventHash }]
    : [{ server: 'acas-tools', tool: 'spreadsheet_create', status, event_sha256: createEventHash }]
  const workbookTools = status === 'passed' ? ['spreadsheet_create', 'spreadsheet_inspect'] : ['spreadsheet_create']
  return {
    schema: 'sks.host-capability-evidence.v1' as const,
    ok: status === 'passed',
    runtime: {
      schema: 'sks.host-capability-runtime.v1' as const,
      ok: true,
      server: 'acas-tools' as const,
      server_present: true,
      server_enabled: true,
      server_scope: 'project' as const,
      inventory_source: 'fixture',
      health_status: 'healthy',
      requested_capability_ids: ['host.spreadsheet.workbook.v1', 'host.artifact.receipt.v1'],
      task_workflows: ['spreadsheet_create' as const, 'artifact_delivery' as const],
      requested_tool_names: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update'],
      observed_tool_names: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update'],
      allowed_tool_names: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update'],
      denied_tool_names: [],
      explicit_denied_tool_names: [],
      allowlist_digest: `sha256:${'b'.repeat(64)}`,
      capability_digest: hostCapabilityDigest(HOST_CAPABILITY_DESCRIPTORS),
      capabilities: [],
      blockers: []
    },
    tool_calls: toolCalls,
    capabilities_used: [{
      id: 'host.spreadsheet.workbook.v1',
      status,
      tool_names: workbookTools,
      receipt_sha256: capabilityReceiptHash(
        'host.spreadsheet.workbook.v1',
        status === 'passed' ? [createEventHash, inspectEventHash] : [createEventHash],
        []
      )
    }, {
      id: 'host.artifact.receipt.v1',
      status,
      tool_names: ['spreadsheet_create'],
      receipt_sha256: capabilityReceiptHash(
        'host.artifact.receipt.v1',
        [createEventHash],
        status === 'passed' ? [createEventHash] : []
      )
    }],
    artifacts: status === 'passed' ? [artifact] : [],
    artifact_sources: status === 'passed' ? [{
      path: artifact.path,
      source_tool: 'spreadsheet_create',
      source_event_sha256: createEventHash
    }] : [],
    blockers: blocker ? [blocker] : []
  }
}

function capabilityReceiptHash(id: string, calls: string[], artifacts: string[]): string {
  return `sha256:${sha256(JSON.stringify({ id, calls, artifacts }))}`
}

test('event normalization prefers explicit thread ids, supports official agent ids, and never promotes a session id', () => {
  const explicit = normalizeSubagentEvent({
    hook_event_name: 'SubagentStart',
    thread_id: 'thread-1',
    agent_id: 'agent-1',
    session_id: 'parent-session'
  })
  const officialHook = normalizeSubagentEvent({
    hook_event_name: 'SubagentStop',
    agent_id: 'agent-2',
    session_id: 'parent-session'
  })

  assert.equal(explicit?.thread_id, 'thread-1')
  assert.equal(explicit?.thread_id_source, 'thread_id')
  assert.equal(officialHook?.thread_id, 'agent-2')
  assert.equal(officialHook?.thread_id_source, 'agent_id')

  const sessionOnly = normalizeSubagentEvent({
    hook_event_name: 'SubagentStart',
    session_id: 'parent-session'
  })
  assert.equal(sessionOnly?.thread_id, null)
  assert.equal(sessionOnly?.thread_id_source, null)
  assert.equal(sessionOnly?.session_id, 'parent-session')

  const nested = normalizeSubagentEvent({
    type: 'SubagentStart',
    payload: { thread: { id: 'thread-nested' } }
  })
  assert.equal(nested?.thread_id, 'thread-nested')
})

test('a shared session id cannot masquerade as an official child identity', () => {
  const evidence = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: parentSummary(['parent-session']),
    events: [
      { event_name: 'SubagentStart', session_id: 'parent-session' },
      { event_name: 'SubagentStop', session_id: 'parent-session' }
    ]
  })

  assert.equal(evidence.started_threads, 0)
  assert.equal(evidence.completed_threads, 0)
  assert.equal(evidence.ok, false)
  assert.ok(evidence.blockers.includes('subagent_event_thread_id_missing'))
})

test('evidence completes only unique correlated start and stop thread ids with a parent summary', () => {
  const evidence = buildSubagentEvidence({
    requestedSubagents: 2,
    parentSummary: parentSummary(['thread-a', 'thread-b']),
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStart', thread_id: 'thread-b' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-b' }
    ]
  })

  assert.equal(evidence.started_threads, 2)
  assert.equal(evidence.completed_threads, 2)
  assert.equal(evidence.failed_threads, 0)
  assert.deepEqual(evidence.event_sources, ['SubagentStart', 'SubagentStop'])
  assert.equal(evidence.parent_summary_present, true)
  assert.equal(evidence.parent_summary_trustworthy, true)
  assert.equal(evidence.ok, true)
})

test('a blocked parent can still prove that every requested child slice completed', () => {
  const evidence = buildSubagentEvidence({
    requestedSubagents: 2,
    parentSummary: {
      schema: SUBAGENT_PARENT_SUMMARY_SCHEMA,
      status: 'blocked',
      summary: 'Integration is blocked by an external release prerequisite.',
      thread_outcomes: ['thread-a', 'thread-b'].map((threadId) => ({
        thread_id: threadId,
        status: 'completed',
        summary: `${threadId}: assigned review completed`
      })),
      changed_files: [],
      verification: [],
      blockers: ['external_release_prerequisite']
    },
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStart', thread_id: 'thread-b' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-b' }
    ]
  })

  assert.equal(evidence.started_threads, 2)
  assert.equal(evidence.completed_threads, 2)
  assert.equal(evidence.failed_threads, 0)
  assert.deepEqual(evidence.open_thread_ids, [])
  assert.equal(evidence.parent_summary_status, 'blocked')
  assert.equal(evidence.parent_summary_trustworthy, true)
  assert.equal(evidence.ok, false)
  assert.equal(evidence.status, 'blocked')
  assert.ok(evidence.blockers.includes('parent_summary_blocked'))
  assert.ok(!evidence.blockers.includes('parent_summary_failed'))
})

test('changed files require a named passed check or a justified not-applicable verification row', () => {
  const events = [
    { event_name: 'SubagentStart', thread_id: 'thread-a' },
    { event_name: 'SubagentStop', thread_id: 'thread-a' }
  ]
  const missing = { ...parentSummary(['thread-a']), changed_files: ['src/a.ts'] }
  const blocked = buildSubagentEvidence({ requestedSubagents: 1, parentSummary: missing, events })
  assert.equal(blocked.ok, false)
  assert.ok(blocked.blockers.includes('parent_summary_verification_missing'))

  const verified = { ...missing, verification: [{ name: 'focused typecheck', status: 'passed' }] }
  assert.equal(buildSubagentEvidence({ requestedSubagents: 1, parentSummary: verified, events }).ok, true)
})

test('parent artifact and capability receipts require trusted host evidence and completed summaries reject failed receipts', () => {
  const trusted = hostCapabilityEvidence()
  const completed = {
    ...parentSummary(['thread-a']),
    artifacts: trusted.artifacts,
    capabilities_used: trusted.capabilities_used
  }
  const events = [
    { event_name: 'SubagentStart', thread_id: 'thread-a' },
    { event_name: 'SubagentStop', thread_id: 'thread-a' }
  ]
  const withoutEvidence = buildSubagentEvidence({ requestedSubagents: 1, parentSummary: completed, events })
  assert.equal(withoutEvidence.ok, false)
  assert.ok(withoutEvidence.blockers.includes('parent_summary_host_capability_evidence_missing'))

  const emptyReceipts = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: {
      ...parentSummary(['thread-a']),
      artifacts: [],
      capabilities_used: []
    },
    events
  })
  assert.equal(emptyReceipts.ok, true)

  const failed = hostCapabilityEvidence('failed')
  const contradicted = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: {
      ...parentSummary(['thread-a']),
      artifacts: failed.artifacts,
      capabilities_used: failed.capabilities_used
    },
    events,
    hostCapabilityEvidence: failed
  })
  assert.equal(contradicted.ok, false)
  assert.equal(contradicted.parent_summary_trustworthy, false)
  assert.ok(contradicted.blockers.includes('parent_summary_capability_not_passed:host.spreadsheet.workbook.v1'))
})

test('trusted passed capability receipts must bind to observed tool call hashes', () => {
  const trusted = hostCapabilityEvidence()
  const forged = {
    ...trusted,
    tool_calls: [],
    artifacts: [],
    capabilities_used: trusted.capabilities_used.map((receipt) => ({
      ...receipt,
      tool_names: [],
      receipt_sha256: `sha256:${'9'.repeat(64)}`
    }))
  }
  const summary = {
    ...parentSummary(['thread-a']),
    artifacts: forged.artifacts,
    capabilities_used: forged.capabilities_used
  }
  const evidence = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: summary,
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' }
    ],
    hostCapabilityEvidence: forged as any
  })

  assert.equal(evidence.ok, false)
  assert.equal(evidence.host_capability_evidence, undefined)
  assert.ok(evidence.blockers.includes('host_capability_evidence_invalid'))
})

test('trusted artifact capability receipts bind artifact production to the source event hash', () => {
  const trusted = hostCapabilityEvidence()
  const forged = {
    ...trusted,
    capabilities_used: trusted.capabilities_used.map((receipt) => receipt.id === 'host.artifact.receipt.v1'
      ? {
          ...receipt,
          receipt_sha256: capabilityReceiptHash(
            receipt.id,
            [trusted.tool_calls[0]!.event_sha256],
            [`sha256:${'8'.repeat(64)}`]
          )
        }
      : receipt)
  }
  const evidence = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: {
      ...parentSummary(['thread-a']),
      artifacts: forged.artifacts,
      capabilities_used: forged.capabilities_used
    },
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' }
    ],
    hostCapabilityEvidence: forged
  })

  assert.equal(evidence.ok, false)
  assert.ok(evidence.blockers.includes('host_capability_evidence_invalid'))
})

test('trusted passed artifact receipts reject a failed duplicate source-tool call', () => {
  const trusted = hostCapabilityEvidence()
  const artifactReceipt = trusted.capabilities_used.find((receipt) => receipt.id === 'host.artifact.receipt.v1')!
  const forged = {
    ...trusted,
    runtime: {
      ...trusted.runtime,
      requested_capability_ids: ['host.artifact.receipt.v1']
    },
    tool_calls: [
      trusted.tool_calls[0]!,
      {
        server: 'acas-tools',
        tool: 'spreadsheet_create',
        status: 'failed' as const,
        event_sha256: `sha256:${'7'.repeat(64)}`
      }
    ],
    capabilities_used: [artifactReceipt]
  }
  const evidence = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: {
      ...parentSummary(['thread-a']),
      artifacts: forged.artifacts,
      capabilities_used: forged.capabilities_used
    },
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' }
    ],
    hostCapabilityEvidence: forged
  })

  assert.equal(evidence.ok, false)
  assert.ok(evidence.blockers.includes('host_capability_evidence_invalid'))
})

test('evidence rejects observed fanout that exceeds the planned subagent count', () => {
  const evidence = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: parentSummary(['thread-a', 'thread-b']),
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStart', thread_id: 'thread-b' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-b' }
    ]
  })

  assert.equal(evidence.requested_subagents, 1)
  assert.equal(evidence.started_threads, 2)
  assert.equal(evidence.completed_threads, 2)
  assert.equal(evidence.ok, false)
  assert.ok(evidence.blockers.includes('requested_subagent_starts_exceeded:2/1'))
  assert.ok(evidence.blockers.includes('requested_subagent_completions_exceeded:2/1'))
})

test('dynamic automatic evidence grows a two-thread request to four observed trustworthy outcomes', () => {
  const threadIds = ['thread-a', 'thread-b', 'thread-c', 'thread-d']
  const evidence = buildSubagentEvidence({
    requestedSubagents: 2,
    countPolicy: 'dynamic_automatic',
    targetSubagents: 4,
    parentSummary: parentSummary(threadIds),
    events: threadIds.flatMap((threadId) => [
      { event_name: 'SubagentStart', thread_id: threadId },
      { event_name: 'SubagentStop', thread_id: threadId }
    ])
  })

  assert.equal(evidence.requested_subagents, 2)
  assert.equal(evidence.count_policy, 'dynamic_automatic')
  assert.equal(evidence.target_subagents, 4)
  assert.equal(evidence.started_threads, 4)
  assert.equal(evidence.completed_threads, 4)
  assert.equal(evidence.ok, true)
})

test('exact evidence keeps a two-thread target and blocks four observed outcomes', () => {
  const threadIds = ['thread-a', 'thread-b', 'thread-c', 'thread-d']
  const evidence = buildSubagentEvidence({
    requestedSubagents: 2,
    countPolicy: 'exact',
    targetSubagents: 4,
    parentSummary: parentSummary(threadIds),
    events: threadIds.flatMap((threadId) => [
      { event_name: 'SubagentStart', thread_id: threadId },
      { event_name: 'SubagentStop', thread_id: threadId }
    ])
  })

  assert.equal(evidence.requested_subagents, 2)
  assert.equal(evidence.count_policy, 'exact')
  assert.equal(evidence.target_subagents, 2)
  assert.equal(evidence.ok, false)
  assert.ok(evidence.blockers.includes('requested_subagent_starts_exceeded:4/2'))
  assert.ok(evidence.blockers.includes('requested_subagent_completions_exceeded:4/2'))
})

test('unsafe terminal thread states still block a dynamic target', () => {
  const cases = [
    {
      name: 'open',
      events: [{ event_name: 'SubagentStart', thread_id: 'thread-a' }],
      summary: parentSummary(['thread-a']),
      blocker: 'subagent_threads_still_open:1'
    },
    {
      name: 'failed',
      events: [
        { event_name: 'SubagentStart', thread_id: 'thread-a' },
        { event_name: 'SubagentStop', thread_id: 'thread-a', failed: true }
      ],
      summary: parentSummary(['thread-a'], 'failed'),
      blocker: 'subagent_threads_failed:1'
    },
    {
      name: 'unmatched',
      events: [{ event_name: 'SubagentStop', thread_id: 'thread-a' }],
      summary: parentSummary([]),
      blocker: 'subagent_stops_without_start:1'
    },
    {
      name: 'ambiguous',
      events: [
        { event_name: 'SubagentStart', thread_id: 'thread-a' },
        { event_name: 'SubagentStop', thread_id: 'thread-a' }
      ],
      summary: null,
      blocker: 'subagent_thread_outcomes_ambiguous:1'
    }
  ]
  for (const fixture of cases) {
    const evidence = buildSubagentEvidence({
      requestedSubagents: 1,
      countPolicy: 'dynamic_automatic',
      targetSubagents: 1,
      events: fixture.events,
      parentSummary: fixture.summary
    })
    assert.equal(evidence.ok, false, fixture.name)
    assert.ok(evidence.blockers.includes(fixture.blocker), fixture.name)
  }
})

test('parent thread outcomes must exactly equal the observed started thread ids', () => {
  const extraOutcome = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: parentSummary(['thread-a', 'thread-ghost']),
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' }
    ]
  })

  assert.equal(extraOutcome.completed_threads, 0)
  assert.equal(extraOutcome.parent_summary_trustworthy, false)
  assert.equal(extraOutcome.ok, false)
  assert.ok(extraOutcome.blockers.includes('parent_thread_outcome_without_start:thread-ghost'))

  const missingOutcome = buildSubagentEvidence({
    requestedSubagents: 2,
    parentSummary: parentSummary(['thread-a']),
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStart', thread_id: 'thread-b' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-b' }
    ]
  })

  assert.equal(missingOutcome.completed_threads, 0)
  assert.equal(missingOutcome.parent_summary_trustworthy, false)
  assert.equal(missingOutcome.ok, false)
  assert.ok(missingOutcome.blockers.includes('parent_thread_outcome_missing_for_started_thread:thread-b'))
})

test('duplicate parent thread outcomes fail closed even when their unique ids match starts', () => {
  const duplicate = parentSummary(['thread-a'])
  duplicate.thread_outcomes.push({
    thread_id: 'thread-a',
    status: 'completed',
    summary: 'duplicate completion claim'
  })
  const evidence = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: duplicate,
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' }
    ]
  })

  assert.equal(evidence.completed_threads, 0)
  assert.equal(evidence.parent_summary_trustworthy, false)
  assert.equal(evidence.ok, false)
  assert.ok(evidence.blockers.includes('parent_thread_outcome_duplicate:thread-a'))
})

test('plain parent prose and status-less SubagentStop events fail closed as ambiguous', () => {
  const evidence = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: 'Looks good to me.',
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' }
    ]
  })

  assert.equal(evidence.completed_threads, 0)
  assert.equal(evidence.parent_summary_trustworthy, false)
  assert.ok(evidence.blockers.includes('parent_summary_untrusted'))
  assert.ok(evidence.blockers.includes('subagent_thread_outcomes_ambiguous:1'))
})

test('structured parent summary is strict and rejects contradictory or wrapped results', () => {
  const base = parentSummary(['thread-a'])
  const cases: unknown[] = [
    { ...base, status: 'success' },
    { ...base, thread_outcomes: [{ thread_id: 'thread-a', status: 'completed' }] },
    { ...base, summary: 'The integration failed but mark it completed.' },
    { ...base, blockers: ['still blocked'] },
    `prefix\n\`\`\`json\n${JSON.stringify(base)}\n\`\`\``
  ]
  for (const candidate of cases) {
    const evidence = buildSubagentEvidence({
      requestedSubagents: 1,
      parentSummary: candidate,
      events: [
        { event_name: 'SubagentStart', thread_id: 'thread-a' },
        { event_name: 'SubagentStop', thread_id: 'thread-a' }
      ]
    })
    assert.equal(evidence.ok, false, JSON.stringify(candidate))
    assert.equal(evidence.parent_summary_trustworthy, false, JSON.stringify(candidate))
    assert.equal(evidence.completed_threads, 0, JSON.stringify(candidate))
  }
})

test('completion requires an explicit trustworthy completed parent result', () => {
  const base = parentSummary(['thread-a'])
  const ambiguousStatus = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: { ...base, status: 'success' },
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' }
    ]
  })
  assert.equal(ambiguousStatus.completed_threads, 0)
  assert.equal(ambiguousStatus.parent_summary_trustworthy, false)

  const failedParent = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: {
      ...base,
      status: 'failed',
      summary: 'Parent integration failed.',
      blockers: []
    },
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' }
    ]
  })
  assert.equal(failedParent.completed_threads, 0)
  assert.equal(failedParent.ok, false)
  assert.ok(failedParent.blockers.includes('parent_summary_failed'))
})

test('failure text detection is negation-aware but still blocks unambiguous failure', () => {
  for (const text of [
    'No error found.',
    'Not blocked; completed.',
    'No failure occurred.',
    'Could not find any issues.',
    'Failure-path tests passed and the slice completed.',
    'Build failed-path coverage passed.',
    'Unable to reproduce the reported error; no issue found.',
    '오류가 없습니다.',
    '실패한 테스트가 없습니다.',
    '차단된 항목이 없습니다.'
  ]) {
    const evidence = buildSubagentEvidence({
      requestedSubagents: 1,
      parentSummary: parentSummary(['thread-a']),
      events: [
        { event_name: 'SubagentStart', thread_id: 'thread-a' },
        { event_name: 'SubagentStop', thread_id: 'thread-a', last_assistant_message: text }
      ]
    })
    assert.equal(evidence.ok, true, text)
  }

  for (const text of [
    'The slice failed with an error.',
    'Unable to complete the assigned work.',
    '작업을 완료하지 못했습니다.',
    '12 tests failed.',
    'Typecheck failed.',
    'Build failed.',
    'npm test failed.',
    'Compilation error TS2322.'
  ]) {
    const evidence = buildSubagentEvidence({
      requestedSubagents: 1,
      parentSummary: parentSummary(['thread-a']),
      events: [
        { event_name: 'SubagentStart', thread_id: 'thread-a' },
        { event_name: 'SubagentStop', thread_id: 'thread-a', last_assistant_message: text }
      ]
    })
    assert.equal(evidence.ok, false, text)
    assert.equal(evidence.failed_threads, 1, text)

    const contradictoryParent = buildSubagentEvidence({
      requestedSubagents: 1,
      parentSummary: { ...parentSummary(['thread-a']), summary: text },
      events: [
        { event_name: 'SubagentStart', thread_id: 'thread-a' },
        { event_name: 'SubagentStop', thread_id: 'thread-a' }
      ]
    })
    assert.equal(contradictoryParent.completed_threads, 0, text)
    assert.equal(contradictoryParent.parent_summary_trustworthy, false, text)
  }
})

test('ambiguous result text cannot be upgraded by a completed parent status', () => {
  for (const text of [
    'Tests not run.',
    'Typecheck not verified.',
    'Verification pending.',
    'Result unknown.',
    'Unable to verify the build.',
    'Partially completed.'
  ]) {
    const evidence = buildSubagentEvidence({
      requestedSubagents: 1,
      parentSummary: parentSummary(['thread-a']),
      events: [
        { event_name: 'SubagentStart', thread_id: 'thread-a' },
        { event_name: 'SubagentStop', thread_id: 'thread-a', last_assistant_message: text }
      ]
    })
    assert.equal(evidence.completed_threads, 0, text)
    assert.equal(evidence.failed_threads, 0, text)
    assert.deepEqual(evidence.ambiguous_stop_thread_ids, ['thread-a'], text)
    assert.equal(evidence.ok, false, text)

    const contradictoryParent = buildSubagentEvidence({
      requestedSubagents: 1,
      parentSummary: { ...parentSummary(['thread-a']), summary: text },
      events: [
        { event_name: 'SubagentStart', thread_id: 'thread-a' },
        { event_name: 'SubagentStop', thread_id: 'thread-a' }
      ]
    })
    assert.equal(contradictoryParent.parent_summary_trustworthy, false, text)
    assert.equal(contradictoryParent.completed_threads, 0, text)
  }
})

test('completed read-only review boundaries do not masquerade as unfinished verification', () => {
  const evidence = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: parentSummary(['thread-a']),
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      {
        event_name: 'SubagentStop',
        thread_id: 'thread-a',
        last_assistant_message: 'Read-only inspection covered the assigned review scope. No tests were executed and no files were changed.'
      }
    ]
  })

  assert.equal(evidence.ok, true)

  const withoutParent = buildSubagentEvidence({
    requestedSubagents: 1,
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      {
        event_name: 'SubagentStop',
        thread_id: 'thread-a',
        last_assistant_message: 'Read-only inspection covered the assigned review scope. No tests were executed and no files were changed.'
      }
    ]
  })
  assert.equal(withoutParent.ok, false)
  assert.equal(withoutParent.completed_threads, 0)
})

test('the latest stop attempt controls retry outcome while parent evidence remains mandatory', () => {
  for (const firstOutcome of [
    { last_assistant_message: 'The first attempt failed with an error.' },
    { last_assistant_message: 'Verification pending.' }
  ]) {
    const recovered = buildSubagentEvidence({
      requestedSubagents: 1,
      parentSummary: parentSummary(['thread-a']),
      events: [
        { event_name: 'SubagentStart', thread_id: 'thread-a' },
        { event_name: 'SubagentStop', thread_id: 'thread-a', ...firstOutcome },
        { event_name: 'SubagentStop', thread_id: 'thread-a', last_assistant_message: 'Retry completed the assigned slice.' }
      ]
    })
    assert.equal(recovered.ok, true)
    assert.deepEqual(recovered.completed_thread_ids, ['thread-a'])
    assert.deepEqual(recovered.failed_thread_ids, [])
    assert.deepEqual(recovered.ambiguous_stop_thread_ids, [])
  }

  const finalFailure = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: parentSummary(['thread-a']),
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-a', last_assistant_message: 'Retry completed the assigned slice.' },
      { event_name: 'SubagentStop', thread_id: 'thread-a', last_assistant_message: 'The final slice failed with an error.' }
    ]
  })
  assert.equal(finalFailure.ok, false)
  assert.deepEqual(finalFailure.failed_thread_ids, ['thread-a'])
})

test('persisted normalized ambiguous outcomes survive event-log round trips', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-subagent-event-roundtrip-'))
  try {
    await recordSubagentEvent(dir, { thread_id: 'thread-a' }, 'SubagentStart')
    await recordSubagentEvent(dir, { thread_id: 'thread-a', last_assistant_message: 'Tests not run.' }, 'SubagentStop')
    const events = await readSubagentEvents(dir)
    assert.equal(events[1]?.outcome, 'ambiguous')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('run-scoped evidence rejects stale and unbound events without letting them satisfy the active run', () => {
  const scopedSummary = {
    ...parentSummary(['agent-new']),
    run_id: 'run-new',
    run_epoch: 2
  }
  const currentAndStale = buildSubagentEvidence({
    requestedSubagents: 1,
    runId: 'run-new',
    runEpoch: 2,
    parentSummary: scopedSummary,
    events: [
      { event_name: 'SubagentStart', agent_id: 'agent-old', run_id: 'run-old', run_epoch: 1 },
      { event_name: 'SubagentStop', agent_id: 'agent-old', run_id: 'run-old', run_epoch: 1 },
      { event_name: 'SubagentStart', agent_id: 'agent-new', run_id: 'run-new', run_epoch: 2 },
      { event_name: 'SubagentStop', agent_id: 'agent-new', run_id: 'run-new', run_epoch: 2 }
    ]
  })

  assert.equal(currentAndStale.ok, true)
  assert.deepEqual(currentAndStale.started_thread_ids, ['agent-new'])
  assert.deepEqual(currentAndStale.completed_thread_ids, ['agent-new'])
  assert.equal(currentAndStale.rejected_stale_events, 2)
  assert.deepEqual(currentAndStale.rejected_stale_thread_ids, ['agent-old'])

  const staleOnly = buildSubagentEvidence({
    requestedSubagents: 1,
    runId: 'run-new',
    runEpoch: 2,
    parentSummary: scopedSummary,
    events: [
      { event_name: 'SubagentStart', agent_id: 'agent-new', run_id: 'run-old', run_epoch: 1 },
      { event_name: 'SubagentStop', agent_id: 'agent-new', run_id: 'run-old', run_epoch: 1 }
    ]
  })
  assert.equal(staleOnly.started_threads, 0)
  assert.equal(staleOnly.completed_threads, 0)
  assert.equal(staleOnly.ok, false)
  assert.equal(staleOnly.rejected_stale_events, 2)

  const unbound = buildSubagentEvidence({
    requestedSubagents: 1,
    runId: 'run-new',
    runEpoch: 2,
    parentSummary: scopedSummary,
    events: [
      { event_name: 'SubagentStart', agent_id: 'agent-new' },
      { event_name: 'SubagentStop', agent_id: 'agent-new' }
    ]
  })
  assert.equal(unbound.completed_threads, 0)
  assert.equal(unbound.unbound_run_events, 2)
  assert.equal(unbound.parent_summary_trustworthy, false)
  assert.ok(unbound.blockers.includes('subagent_events_run_scope_missing:2'))
})

test('mixed run identities and an unbound parent summary fail closed', () => {
  const evidence = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: parentSummary(['agent-a']),
    events: [
      { event_name: 'SubagentStart', agent_id: 'agent-a', run_id: 'run-a' },
      { event_name: 'SubagentStop', agent_id: 'agent-a', run_id: 'run-a' },
      { event_name: 'SubagentStart', agent_id: 'agent-b', run_id: 'run-b' },
      { event_name: 'SubagentStop', agent_id: 'agent-b', run_id: 'run-b' }
    ]
  })

  assert.equal(evidence.completed_threads, 0)
  assert.equal(evidence.parent_summary_trustworthy, false)
  assert.equal(evidence.ok, false)
  assert.equal(evidence.run_id, 'run-b')
  assert.equal(evidence.rejected_stale_events, 2)
  assert.ok(evidence.blockers.includes('parent_summary_run_id_missing'))
})

test('official turn ids select the newest execution epoch without requiring user-authored run fields', () => {
  const evidence = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: parentSummary(['agent-new']),
    events: [
      { event_name: 'SubagentStart', agent_id: 'agent-old', turn_id: 'turn-old' },
      { event_name: 'SubagentStop', agent_id: 'agent-old', turn_id: 'turn-old' },
      { event_name: 'SubagentStart', agent_id: 'agent-new', turn_id: 'turn-new' },
      { event_name: 'SubagentStop', agent_id: 'agent-new', turn_id: 'turn-new' }
    ]
  })

  assert.equal(evidence.ok, true)
  assert.equal(evidence.run_id, 'turn-new')
  assert.equal(evidence.run_scope_source, 'event_turn_id')
  assert.equal(evidence.rejected_stale_events, 2)
  assert.deepEqual(evidence.completed_thread_ids, ['agent-new'])
})

test('structured parent summaries are bound only when trustworthy and reject a mismatched run id', () => {
  const summary = parentSummary(['thread-a'])
  assert.deepEqual(bindTrustworthySubagentParentSummaryToRun(summary, 'run-current'), {
    ...summary,
    run_id: 'run-current'
  })
  const stale = { ...summary, run_id: 'run-old' }
  assert.equal(bindTrustworthySubagentParentSummaryToRun(stale, 'run-current'), null)
  const ambiguous = { ...summary, status: 'success' }
  assert.deepEqual(bindTrustworthySubagentParentSummaryToRun(ambiguous, 'run-current'), ambiguous)
})

test('a delayed stale parent summary cannot overwrite or replace the active run summary', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-subagent-parent-summary-run-scope-'))
  try {
    const current = { ...parentSummary(['thread-current']), run_id: 'run-current' }
    const stale = { ...parentSummary(['thread-old']), run_id: 'run-old' }
    await persistOrReuseTrustworthySubagentParentSummary(dir, current, { runId: 'run-current' })

    const rejected = bindTrustworthySubagentParentSummaryToRun(stale, 'run-current')
    assert.equal(rejected, null)
    assert.deepEqual(
      await persistOrReuseTrustworthySubagentParentSummary(dir, rejected, { runId: 'run-current' }),
      current
    )
    assert.deepEqual(
      JSON.parse(await fsp.readFile(path.join(dir, SUBAGENT_PARENT_SUMMARY_FILENAME), 'utf8')),
      current
    )

    await fsp.writeFile(path.join(dir, SUBAGENT_PARENT_SUMMARY_FILENAME), JSON.stringify(stale))
    assert.equal(
      await persistOrReuseTrustworthySubagentParentSummary(dir, 'Completion Summary: ambiguous current retry', { runId: 'run-current' }),
      'Completion Summary: ambiguous current retry'
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('preparation, missing summary, unmatched stops, and failed threads never count as completion', () => {
  const events = [
    { event_name: 'SubagentStart', thread_id: 'thread-a' },
    { event_name: 'SubagentStop', thread_id: 'thread-a' },
    { event_name: 'SubagentStop', thread_id: 'thread-never-started' }
  ]
  const preparation = buildSubagentEvidence({
    requestedSubagents: 1,
    events,
    parentSummary: 'Prepared context only.',
    workflowStatus: 'delegation_context_ready'
  })
  assert.equal(preparation.ok, false)
  assert.equal(preparation.status, 'preparation_only')
  assert.ok(preparation.blockers.includes('subagent_workflow_preparation_only'))
  assert.ok(preparation.blockers.includes('subagent_stops_without_start:1'))

  const missingSummary = buildSubagentEvidence({ requestedSubagents: 1, events: events.slice(0, 2) })
  assert.equal(missingSummary.ok, false)
  assert.ok(missingSummary.blockers.includes('parent_summary_missing'))

  const failed = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: parentSummary(['thread-a']),
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-a', last_assistant_message: 'The slice failed with an error.' }
    ]
  })
  assert.equal(failed.completed_threads, 0)
  assert.equal(failed.failed_threads, 1)
  assert.equal(failed.ok, false)
})

test('external official config blockers prevent otherwise complete evidence from passing', () => {
  const evidence = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: parentSummary(['thread-a']),
    events: [
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStop', thread_id: 'thread-a' }
    ],
    additionalBlockers: [
      'official_subagent_config:project_official_subagent_config_toml_parse_failed',
      'official_subagent_config:project_official_subagent_config_toml_parse_failed'
    ]
  })

  assert.equal(evidence.completed_threads, 1)
  assert.equal(evidence.ok, false)
  assert.deepEqual(evidence.blockers, [
    'official_subagent_config:project_official_subagent_config_toml_parse_failed'
  ])
})

test('a stop before its start and an extra observed thread invalidate the whole parent outcome set', () => {
  const evidence = buildSubagentEvidence({
    requestedSubagents: 1,
    parentSummary: parentSummary(['thread-b']),
    events: [
      { event_name: 'SubagentStop', thread_id: 'thread-a' },
      { event_name: 'SubagentStart', thread_id: 'thread-a' },
      { event_name: 'SubagentStart', thread_id: 'thread-b' },
      { event_name: 'SubagentStop', thread_id: 'thread-b' }
    ]
  })

  assert.equal(evidence.completed_threads, 0)
  assert.equal(evidence.parent_summary_trustworthy, false)
  assert.deepEqual(evidence.open_thread_ids, ['thread-a', 'thread-b'])
  assert.equal(evidence.ok, false)
  assert.ok(evidence.blockers.includes('parent_thread_outcome_missing_for_started_thread:thread-a'))
  assert.ok(evidence.blockers.includes('subagent_threads_still_open:2'))
  assert.ok(evidence.blockers.includes('subagent_stops_without_start:1'))
})

test('event recorder and evidence writer use the canonical artifact names', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-subagent-evidence-'))
  try {
    await recordSubagentEvent(dir, { thread_id: 'thread-a' }, 'SubagentStart')
    await recordSubagentEvent(dir, { thread_id: 'thread-a' }, 'SubagentStop')
    const evidence = await writeSubagentEvidence(dir, {
      requestedSubagents: 1,
      parentSummary: parentSummary(['thread-a'])
    })

    assert.equal(evidence.ok, true)
    assert.equal((await fsp.stat(path.join(dir, SUBAGENT_EVENT_LOG_FILENAME))).isFile(), true)
    assert.equal((await fsp.stat(path.join(dir, SUBAGENT_EVIDENCE_FILENAME))).isFile(), true)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('trusted host capability receipts discard additive fields before persistence and reuse', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-subagent-host-capability-evidence-'))
  try {
    const trusted = hostCapabilityEvidence()
    const additiveTrusted = {
      ...trusted,
      artifacts: trusted.artifacts.map((receipt) => ({
        ...receipt,
        arguments: { token: 'artifact-secret-not-persisted' }
      })),
      capabilities_used: trusted.capabilities_used.map((receipt) => ({
        ...receipt,
        rows: ['capability-secret-not-persisted']
      }))
    }
    const additiveSummary = {
      ...parentSummary(['thread-a']),
      artifacts: additiveTrusted.artifacts,
      capabilities_used: additiveTrusted.capabilities_used
    }
    const canonicalSummary = {
      ...parentSummary(['thread-a']),
      artifacts: trusted.artifacts,
      capabilities_used: trusted.capabilities_used
    }
    await recordSubagentEvent(dir, { thread_id: 'thread-a' }, 'SubagentStart')
    await recordSubagentEvent(dir, { thread_id: 'thread-a' }, 'SubagentStop')
    assert.deepEqual(await persistOrReuseTrustworthySubagentParentSummary(dir, additiveSummary), canonicalSummary)
    const evidence = await writeSubagentEvidence(dir, {
      requestedSubagents: 1,
      parentSummary: additiveSummary,
      hostCapabilityEvidence: additiveTrusted
    })

    assert.equal(evidence.ok, true)
    assert.deepEqual(evidence.host_capability_evidence, trusted)
    const persisted = JSON.parse(await fsp.readFile(path.join(dir, SUBAGENT_EVIDENCE_FILENAME), 'utf8'))
    assert.deepEqual(persisted.host_capability_evidence, trusted)
    assert.doesNotMatch(JSON.stringify(persisted), /secret-not-persisted|arguments|rows/)
    assert.doesNotMatch(
      await fsp.readFile(path.join(dir, SUBAGENT_PARENT_SUMMARY_FILENAME), 'utf8'),
      /secret-not-persisted|arguments|rows/
    )
    assert.equal(evidence.blockers.includes('parent_summary_artifact_unknown_field'), false)
    assert.equal(evidence.blockers.includes('parent_summary_capability_use_unknown_field'), false)
    assert.deepEqual(
      await persistOrReuseTrustworthySubagentParentSummary(dir, 'Completion Summary: prose retry'),
      canonicalSummary
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a later prose final cannot downgrade a persisted trustworthy parent summary', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-subagent-parent-summary-'))
  try {
    const structured = parentSummary(['thread-a'])
    assert.deepEqual(await persistOrReuseTrustworthySubagentParentSummary(dir, structured), structured)
    assert.deepEqual(await persistOrReuseTrustworthySubagentParentSummary(dir, 'Completion Summary: prose retry'), structured)
    const persisted = JSON.parse(await fsp.readFile(path.join(dir, SUBAGENT_PARENT_SUMMARY_FILENAME), 'utf8'))
    assert.deepEqual(persisted, structured)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a trustworthy blocked parent summary persists as canonical terminal evidence', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-subagent-parent-summary-blocked-'))
  try {
    const blocked = {
      schema: SUBAGENT_PARENT_SUMMARY_SCHEMA,
      status: 'blocked',
      summary: 'Parent integration is blocked by an external prerequisite.',
      thread_outcomes: [{
        thread_id: 'thread-a',
        status: 'completed',
        summary: 'Assigned audit completed.'
      }],
      changed_files: [],
      verification: [],
      blockers: ['external_prerequisite'],
      run_id: 'run-blocked'
    }

    assert.deepEqual(
      await persistOrReuseTrustworthySubagentParentSummary(dir, blocked, {
        workflowStatus: 'parent_completed',
        runId: 'run-blocked'
      }),
      blocked
    )
    assert.deepEqual(
      JSON.parse(await fsp.readFile(path.join(dir, SUBAGENT_PARENT_SUMMARY_FILENAME), 'utf8')),
      blocked
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('an honest prose final cannot delete same-run trustworthy blocked parent evidence', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-subagent-parent-summary-blocked-prose-'))
  try {
    const blocked = {
      schema: SUBAGENT_PARENT_SUMMARY_SCHEMA,
      status: 'blocked',
      summary: 'Parent integration is blocked by external publication prerequisites.',
      thread_outcomes: [{
        thread_id: 'thread-a',
        status: 'completed',
        summary: 'Assigned audit completed.'
      }],
      changed_files: [],
      verification: [],
      blockers: ['worktree_not_clean'],
      run_id: 'run-blocked'
    }
    await persistOrReuseTrustworthySubagentParentSummary(dir, blocked, {
      workflowStatus: 'parent_completed',
      runId: 'run-blocked'
    })

    const honestFinal = '검증 실패 0건입니다. 다만 실제 배포는 worktree_not_clean 때문에 차단된 상태이며 배포 준비 완료라고 주장하지 않습니다.'
    assert.deepEqual(
      await persistOrReuseTrustworthySubagentParentSummary(dir, honestFinal, {
        workflowStatus: 'parent_completed',
        runId: 'run-blocked'
      }),
      blocked
    )
    assert.deepEqual(
      JSON.parse(await fsp.readFile(path.join(dir, SUBAGENT_PARENT_SUMMARY_FILENAME), 'utf8')),
      blocked
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('explicit failure output invalidates persisted successful parent evidence', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-subagent-parent-summary-failure-'))
  try {
    const structured = parentSummary(['thread-a'])
    await persistOrReuseTrustworthySubagentParentSummary(dir, structured)
    const failedText = 'Integration failed with an error and did not complete.'
    assert.equal(await persistOrReuseTrustworthySubagentParentSummary(dir, failedText), failedText)
    await assert.rejects(fsp.access(path.join(dir, SUBAGENT_PARENT_SUMMARY_FILENAME)))
    assert.equal(await persistOrReuseTrustworthySubagentParentSummary(dir, 'Completion Summary: retry'), 'Completion Summary: retry')

    await persistOrReuseTrustworthySubagentParentSummary(dir, structured)
    assert.equal(await persistOrReuseTrustworthySubagentParentSummary(dir, structured, { workflowStatus: 'parent_failed' }), null)
    await assert.rejects(fsp.access(path.join(dir, SUBAGENT_PARENT_SUMMARY_FILENAME)))
    const contradicted = buildSubagentEvidence({
      requestedSubagents: 1,
      parentSummary: await persistOrReuseTrustworthySubagentParentSummary(dir, structured, { workflowStatus: 'parent_failed' }),
      workflowStatus: 'parent_failed',
      events: [
        { event_name: 'SubagentStart', thread_id: 'thread-a' },
        { event_name: 'SubagentStop', thread_id: 'thread-a' }
      ]
    })
    assert.equal(contradicted.ok, false)
    assert.ok(contradicted.blockers.includes('parent_summary_missing'))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('trustworthy structured failure replaces and remains as canonical parent evidence', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-subagent-parent-summary-structured-failure-'))
  try {
    const completed = parentSummary(['thread-a'])
    const failed = parentSummary(['thread-a'], 'failed')
    await persistOrReuseTrustworthySubagentParentSummary(dir, completed)

    assert.deepEqual(
      await persistOrReuseTrustworthySubagentParentSummary(dir, failed, { workflowStatus: 'parent_failed' }),
      failed
    )
    const persisted = JSON.parse(await fsp.readFile(path.join(dir, SUBAGENT_PARENT_SUMMARY_FILENAME), 'utf8'))
    assert.deepEqual(persisted, failed)
    assert.deepEqual(
      await persistOrReuseTrustworthySubagentParentSummary(dir, 'Completion Summary: ambiguous retry'),
      failed
    )
    assert.deepEqual(
      await persistOrReuseTrustworthySubagentParentSummary(
        dir,
        'Integration remains blocked because the automatic fanout cap was exceeded.',
        { workflowStatus: 'parent_completed' }
      ),
      failed
    )
    assert.deepEqual(
      JSON.parse(await fsp.readFile(path.join(dir, SUBAGENT_PARENT_SUMMARY_FILENAME), 'utf8')),
      failed
    )

    const evidence = buildSubagentEvidence({
      requestedSubagents: 1,
      parentSummary: persisted,
      workflowStatus: 'parent_failed',
      events: [
        { event_name: 'SubagentStart', thread_id: 'thread-a' },
        { event_name: 'SubagentStop', thread_id: 'thread-a' }
      ]
    })
    assert.equal(evidence.ok, false)
    assert.equal(evidence.parent_summary_trustworthy, true)
    assert.equal(evidence.parent_summary_status, 'failed')
    assert.ok(evidence.blockers.includes('parent_summary_failed'))
    assert.ok(!evidence.blockers.includes('parent_summary_missing'))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
