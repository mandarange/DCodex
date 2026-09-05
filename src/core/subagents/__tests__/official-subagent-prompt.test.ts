import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOfficialSubagentPrompt,
  validateOfficialSubagentSlices
} from '../official-subagent-prompt.js'
import { resolveSubagentThreadBudget } from '../thread-budget.js'
import { extractBoundedTriwikiAttention } from '../triwiki-attention.js'

test('official prompt seals model, ownership, wait, and no-nesting rules', () => {
  const prompt = buildOfficialSubagentPrompt({
    goal: 'Implement two disjoint slices',
    maxThreads: 12,
    slices: [
      {
        id: 'A',
        title: 'Mechanical edit',
        description: 'Apply the exact one-line single-file rename',
        kind: 'worker',
        paths: ['src/a.ts']
      },
      {
        id: 'B',
        title: 'Architecture review',
        description: 'Review integration risk',
        kind: 'expert',
        paths: ['src/b.ts'],
        readOnly: true
      }
    ]
  })

  assert.match(prompt, /gpt-6-astra with max reasoning/)
  assert.match(prompt, /worker.*gpt-5\.6-luna.*max reasoning.*tiny short-context mechanical/)
  assert.match(prompt, /gpt-6-astra with high reasoning for ordinary UI, logic, backend, and native implementation/)
  assert.match(prompt, /gpt-6-astra with max reasoning only for focused unresolved, high-risk, final-review, architecture, security/)
  assert.match(prompt, /gpt-6-astra with medium reasoning for long context\/memory, large docs\/repository reads or exploration, large-scale first-draft code processing/)
  assert.match(prompt, /preserve each sealed role model and effort instead of applying the parent profile to every child/)
  assert.match(prompt, /explicit task class and phase win over incidental keywords/)
  assert.match(prompt, /requested subagents: 2/)
  assert.match(prompt, /max concurrently open child agent threads: 12/)
  assert.match(prompt, /hard child-slot cap, never a utilization target; the root is outside this count/)
  assert.match(prompt, /C_t = min\(ready DAG width, disjoint ownership, verifier capacity/)
  assert.match(prompt, /max depth: 1/)
  assert.match(prompt, /custom `agent_type` selection.*must use `fork_turns="none"`/)
  assert.match(prompt, /never combine `fork_turns="all"`.*with `agent_type`, `model`, or `reasoning_effort`/)
  assert.match(prompt, /context contract: pass fork_turns="none"/)
  assert.match(prompt, /parallel writes require disjoint paths/)
  assert.match(prompt, /wait for every final planned subagent/)
  assert.match(prompt, /"run_id": "workflow_run_id from subagent-plan\.json"/)
  assert.match(prompt, /copy workflow_run_id from subagent-plan\.json into run_id/)
  assert.match(prompt, /\[A\].*`worker`/)
  assert.match(prompt, /\[B\].*`architecture_reviewer`/)
  assert.match(prompt, /model policy: luna_max_mechanical \(gpt-5\.6-luna\/max\)/)
  assert.match(prompt, /model policy: sol_max_judgment \(gpt-6-astra\/max\)/)
  assert.match(prompt, /mode: read-only/)
  assert.match(prompt, /metadata mode: on-demand \(2\/25 roles included; full catalog is not injected\)/)
  assert.equal(prompt.match(/Core Engineering Directive/g)?.length, 1)
  assert.match(prompt, /from AGENTS\.md exactly/)
  assert.ok(
    Buffer.byteLength(prompt, 'utf8') <= 9_300,
    `two-slice official prompt exceeded 9,300 bytes: ${Buffer.byteLength(prompt, 'utf8')}`
  )
})

test('official prompt teaches capacity-derived automatic fan-out and the hard ceiling', () => {
  const prompt = buildOfficialSubagentPrompt({
    goal: 'Parent must decompose a repository-wide bulk search',
    maxThreads: 16,
    requestedSubagents: 16,
    decompositionStatus: 'parent_required',
    slices: []
  })

  assert.match(prompt, /automatic fan-out is capacity-derived up to 256/)
  assert.match(prompt, /historical 4\/6\/8\/16 task-class values are fallback hints, not clamps/)
  assert.match(prompt, /in mass fan-out, use worker\/Luna Max for tiny mechanical shards and explorer\/Astra Medium for broad exploration; use Astra High for implementation and Astra Max for judgment/)
  assert.match(prompt, /bounded only by the 256 hard safety ceiling; C_t bounds each wave, not the reusable multi-wave total/)
})

test('Codex App Naruto prompt separates internal parent evidence from the visible Markdown final', () => {
  const prompt = buildOfficialSubagentPrompt({
    goal: 'Integrate the completed slices without exposing machine evidence',
    maxThreads: 4,
    requestedSubagents: 1,
    decompositionStatus: 'ready',
    parentOutputMode: 'app_naruto_stdin',
    missionId: 'M-app-parent-summary',
    workflowRunId: 'naruto-app-run-1',
    slices: [
      {
        id: 'review',
        title: 'Review final UX',
        description: 'Verify the user-visible completion response',
        kind: 'expert',
        readOnly: true
      }
    ]
  })

  assert.match(prompt, /"schema": "sks\.subagent-parent-summary\.v1"/)
  assert.match(prompt, /"run_id": "workflow_run_id from subagent-plan\.json"/)
  assert.match(prompt, /"thread_outcomes": \[/)
  assert.match(prompt, /"verification": \[/)
  assert.match(prompt, /"blockers": \[\]/)
  assert.match(prompt, /run_id="naruto-app-run-1"/)
  assert.match(prompt, /sks naruto parent-summary --mission M-app-parent-summary --stdin --json/)
  assert.match(prompt, /return concise Markdown in the user's language/)
  assert.match(prompt, /do not expose, paste, quote, embed, or fence the JSON/)
  assert.doesNotMatch(prompt, /return one JSON object as the final message/)
  assert.doesNotMatch(prompt, /prose outside that object is not completion evidence/)
  assert.doesNotMatch(prompt, /keep completion summary and Honest Mode wording inside the JSON fields/)
})

test('preparation prompt preserves requested count without inventing write slices', () => {
  const prompt = buildOfficialSubagentPrompt({
    goal: 'Parent must decompose this goal',
    maxThreads: 12,
    requestedSubagents: 6,
    decompositionStatus: 'parent_required',
    slices: []
  })

  assert.match(prompt, /requested subagents: 6/)
  assert.match(prompt, /decomposition status: parent_required/)
  assert.match(prompt, /do not invent write scopes/)
  assert.match(prompt, /parent decomposition required before any subagent is spawned/)
})

test('parent-required prompt preserves third-party active main models for children', () => {
  const prompt = buildOfficialSubagentPrompt({
    goal: 'Parent must decompose provider work',
    maxThreads: 4,
    requestedSubagents: 2,
    decompositionStatus: 'parent_required',
    slices: [],
    activeMainModel: {
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3'
    }
  })

  assert.match(prompt, /model routing precedence applies to every child, including slices created after parent decomposition/)
  assert.match(prompt, /for every role without a user override, including slices created after parent decomposition, pass model="moonshotai\/kimi-k3"/)
  assert.match(prompt, /do not substitute a managed GPT model for the active main model openrouter:moonshotai\/kimi-k3/)
})

test('GPT-5.6 Sol active main keeps sealed Luna and Astra child profiles', () => {
  const prompt = buildOfficialSubagentPrompt({
    goal: 'Search the repository and apply a tiny rename',
    maxThreads: 4,
    requestedSubagents: 2,
    decompositionStatus: 'ready',
    activeMainModel: {
      provider: 'openai',
      model: 'gpt-5.6-sol'
    },
    slices: [
      {
        id: 'search',
        title: 'Repository search',
        description: 'Large repository-wide search for callers',
        kind: 'worker',
        agent: 'explorer',
        paths: ['src'],
        readOnly: true
      },
      {
        id: 'rename',
        title: 'Tiny rename',
        description: 'Exact one-line single-file rename',
        kind: 'worker',
        agent: 'worker',
        paths: ['src/a.ts']
      }
    ]
  })

  assert.match(prompt, /children must keep sealed Luna Max\/Astra Medium\/Astra High\/Astra Max role profiles/)
  assert.match(prompt, /never replace a sealed role profile with the parent profile/)
  assert.match(prompt, /pass model="gpt-6-astra" and reasoning_effort="medium" from the sealed role policy/)
  assert.match(prompt, /pass model="gpt-5\.6-luna" and reasoning_effort="max" from the sealed role policy/)
  assert.doesNotMatch(prompt, /pass the exact active main model="gpt-5\.6-sol"/)
})

test('official prompt carries deterministic host capability workflows', () => {
  const prompt = buildOfficialSubagentPrompt({
    goal: 'Prepare SQL, retrieve data, and deliver spreadsheet and PDF artifacts',
    maxThreads: 4,
    requestedSubagents: 1,
    decompositionStatus: 'parent_required',
    slices: []
  })
  const hostPolicy = prompt.slice(
    prompt.indexOf('Host capability policy:'),
    prompt.indexOf('\n\nSubagent rules:')
  )

  assert.ok(Buffer.byteLength(hostPolicy, 'utf8') <= Math.floor(1037 * 0.75))
  assert.match(hostPolicy, /confirm requested tools in the project MCP inventory/)
  assert.match(hostPolicy, /if unavailable or unhealthy, return blocked proof and never fabricate a fallback/)
  assert.match(hostPolicy, /DB: schema first/)
  assert.match(hostPolicy, /retrieval defaults to one bounded query and allows at most four total/)
  assert.match(hostPolicy, /Every query needs a prior schema receipt for the same datasource and matching snapshot/)
  assert.match(hostPolicy, /spreadsheet: prefer the smallest create\/edit mutation; allow at most three updates/)
  assert.match(hostPolicy, /inspect after create and every update/)
  assert.match(hostPolicy, /require the final mutation artifact receipt/)
  assert.match(hostPolicy, /document: write_file\/edit_file then html_to_pdf\|html_to_screenshot\(source_path=\.\.\.\)/)
  assert.match(hostPolicy, /Slack delivery is ACAS-runtime-only, never a model tool/)
  assert.match(prompt, /"artifacts": \[/)
  assert.match(prompt, /"capabilities_used": \[/)
  assert.match(prompt, /"status": "passed\|failed"/)
  assert.match(prompt, /SKS overwrites these fields with observed Codex JSONL evidence before persistence/)
})

test('official prompt carries only bounded TriWiki attention anchors', () => {
  const triwikiAttention = extractBoundedTriwikiAttention({
    attention: {
      mode: 'aggressive_triwiki_active_recall',
      use_first: [
        ['claim-a', 'hash-a', 'source-a'],
        ['claim-b', 'hash-b', 'source-b'],
        ['claim-c', 'hash-c', 'source-c']
      ],
      hydrate_first: [
        ['claim-a', 'code_citations:src/a.ts'],
        ['claim-b', 'code_citations:src/b.ts']
      ]
    }
  }, 2)
  const prompt = buildOfficialSubagentPrompt({
    goal: 'Review the bounded source scope',
    maxThreads: 12,
    requestedSubagents: 1,
    requestedSubagentsExplicit: false,
    decompositionStatus: 'parent_required',
    slices: [],
    triwikiAttention
  })

  assert.match(prompt, /dynamic automatic target/)
  assert.match(prompt, /attention\.use_first anchors/)
  assert.match(prompt, /claim-a/)
  assert.match(prompt, /claim-b/)
  assert.doesNotMatch(prompt, /claim-c/)
  assert.match(prompt, /do not inject the full context pack/)
  assert.match(prompt, /do not launch shell workers, a custom scheduler, a worker pool, or model fanout/)
})

test('TriWiki attention takes the pack trust order and attaches hydrate hints, without ranking by token overlap', () => {
  // Query relevance is the Context Graph's job now. The pack-only path is a
  // deterministic projection of `use_first`: it must not re-introduce the
  // lexical scorer that used to promote hydrate-only rows whose text happened
  // to share words with the goal.
  const triwikiAttention = extractBoundedTriwikiAttention({
    attention: {
      mode: 'aggressive_triwiki_active_recall',
      use_first: [
        ['wiki-policy', 'hash-policy', 'source-policy'],
        ['wrongness-policy', 'hash-wrongness', 'source-wrongness'],
        ['docs-policy', 'hash-docs', 'source-docs'],
        ['unrelated-ppt', 'hash-ppt', 'source-ppt'],
        ['unrelated-search', 'hash-search', 'source-search']
      ],
      hydrate_first: [
        ['wiki-policy', 'code_citations:src/core/hooks-runtime.ts'],
        ['code:core-mcp-manager', 'code_citations:src/core/codex-app/mcp-manager.ts']
      ]
    }
  }, 5, 'Improve every hook gate and the MCP manager')

  assert.deepEqual(triwikiAttention.anchors.map((anchor) => anchor.id), [
    'wiki-policy',
    'wrongness-policy',
    'docs-policy',
    'unrelated-ppt',
    'unrelated-search'
  ])
  assert.equal(triwikiAttention.anchors[0]?.hydrate_hint, 'code_citations:src/core/hooks-runtime.ts')
  assert.equal(triwikiAttention.anchors.length, 5)
  assert.equal(triwikiAttention.full_pack_injected, false)
  assert.equal(triwikiAttention.hydration_policy, 'on_demand_only')
})

test('official prompt injects only the bounded relevant role catalog instead of the full catalog', () => {
  const prompt = buildOfficialSubagentPrompt({
    goal: 'Review native MCP runtime and TriWiki evidence boundaries',
    maxThreads: 12,
    requestedSubagents: 2,
    decompositionStatus: 'parent_required',
    slices: [],
    recommendedAgents: [
      'native_app_specialist',
      'protocol_reviewer',
      'runtime_reliability_reviewer',
      'triwiki_evidence_reviewer',
      'toolchain_specialist'
    ]
  })

  assert.match(prompt, /metadata mode: on-demand \(5\/25 roles included; full catalog is not injected\)/)
  assert.match(prompt, /`native_app_specialist`/)
  assert.match(prompt, /`protocol_reviewer`/)
  assert.match(prompt, /`runtime_reliability_reviewer`/)
  assert.match(prompt, /`triwiki_evidence_reviewer`/)
  assert.match(prompt, /`toolchain_specialist`/)
})

test('prompt carries the dynamic capacity snapshot and selected first wave', () => {
  const budget = resolveSubagentThreadBudget({
    requested: 8,
    configuredMaxThreads: 12,
    readyDagWidth: 7,
    disjointOwnershipCount: 6,
    verifierCapacity: 3,
    toolConcurrency: 5,
    marginalUsefulWorkers: 4
  })
  const prompt = buildOfficialSubagentPrompt({
    goal: 'Implement independent shards',
    maxThreads: budget.maxThreads,
    requestedSubagents: budget.requestedSubagents,
    firstWave: budget.firstWave,
    waveCount: budget.waveCount,
    capacity: budget.capacity,
    decompositionStatus: 'parent_required',
    slices: []
  })

  assert.match(prompt, /selected first-wave concurrency: 3/)
  assert.match(prompt, /"limiting_factors":\["verifier_capacity"\]/)
  assert.match(prompt, /marginal useful throughput stays positive/)
})

test('prompt makes later root waves and between-wave count authority explicit', () => {
  const automatic = buildOfficialSubagentPrompt({
    goal: 'Implement independent shards discovered over multiple waves',
    maxThreads: 4,
    requestedSubagents: 4,
    requestedSubagentsSource: 'automatic',
    firstWave: 2,
    waveCount: 2,
    decompositionStatus: 'parent_required',
    slices: []
  })

  assert.match(automatic, /max depth: 1 applies only to child nesting.*root parent.*later direct-child waves/i)
  assert.match(automatic, /close completed threads.*refresh evidence.*rescan the ready DAG.*next defensible direct-child wave when `remaining_to_start > 0`/is)
  assert.match(automatic, /spawn_next_direct_child_wave_upto:N/)
  assert.match(automatic, /automatic targets may resize between waves/i)
  assert.match(automatic, /C_t bounds each wave, not the reusable multi-wave total/)
  assert.doesNotMatch(automatic, /bounded by C_t and 12/)

  for (const requestedSubagentsSource of ['operator', 'route_contract'] as const) {
    const exact = buildOfficialSubagentPrompt({
      goal: 'Run the exact contracted review waves',
      maxThreads: 4,
      requestedSubagents: 4,
      requestedSubagentsSource,
      firstWave: 2,
      waveCount: 2,
      decompositionStatus: 'parent_required',
      slices: []
    })
    assert.match(exact, /explicit operator and route-owned counts remain exact/i)
  }
})

test('slice validator rejects duplicate work, overlapping writes, and unassigned parallel ownership', () => {
  const result = validateOfficialSubagentSlices([
    {
      id: 'A',
      title: 'Parser fix',
      description: 'Implement parser fix',
      kind: 'worker',
      agent: 'implementation_specialist',
      paths: ['src/parser']
    },
    {
      id: 'B',
      title: 'Parser test',
      description: 'Add parser tests',
      kind: 'worker',
      agent: 'test_engineer',
      paths: ['src/parser/parser.test.ts']
    },
    {
      id: 'C',
      title: 'Parser fix',
      description: 'Implement parser fix',
      kind: 'worker',
      agent: 'implementation_specialist',
      paths: ['src/parser']
    },
    {
      id: 'D',
      title: 'Unowned write',
      description: 'Change another file',
      kind: 'worker'
    }
  ])

  assert.equal(result.safe, false)
  assert.deepEqual(result.duplicate_slice_ids, [['A', 'C']])
  assert.ok(result.overlapping_write_scopes.some((row) => row.left === 'A' && row.right === 'B'))
  assert.deepEqual(result.unassigned_write_scopes, ['D'])
  assert.ok(result.blockers.some((blocker) => blocker.startsWith('duplicate_slice_fingerprint:')))
  assert.ok(result.blockers.some((blocker) => blocker.startsWith('overlapping_write_scope:')))
  assert.ok(result.blockers.includes('unassigned_parallel_write_scope:D'))
})
