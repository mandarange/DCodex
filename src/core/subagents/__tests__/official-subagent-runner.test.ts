import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  runOfficialSubagentWorkflow
} from '../official-subagent-runner.js'
import { readOfficialSubagentConfig } from '../official-subagent-config.js'
import { HARD_NARUTO_MAX_THREADS } from '../thread-budget.js'
import { prepareOfficialSubagentMission, writeNarutoGate } from '../official-subagent-preparation.js'
import { trustedHostCapabilityReceiptBindingBlockers } from '../subagent-evidence.js'
import { addMcpServer, editMcpServer } from '../../mcp-config/mutation.js'
import type { CodexCliMutationOperation, CodexMcpCliPort } from '../../mcp-config/codex-cli-adapter.js'
import { runProcess, sha256 } from '../../fsx.js'
import { missionDir } from '../../mission.js'
import {
  HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME,
  authorizeAndMergeHostCapabilityPreToolObservation,
  bindParentSummaryToHostCapabilityEvidence,
  createHostCapabilityEventCollector,
  createHostCapabilityHookRuntimeBinding,
  hostCapabilityCodexConfigArgs,
  inspectHostCapabilityRuntime,
  mergeHostCapabilityPostToolObservation,
  sanitizeHostCapabilityPostToolUse,
  sanitizeHostCapabilityPreToolUse,
  type HostCapabilityExecutionEvidence,
  requestHostCapabilities
} from '../../agent-bridge/host-capability-runtime.js'
import {
  assertStandaloneChildEnvironment,
  standaloneParentHostEnv
} from './official-subagent-env-fixture.js'
import { OAUTH_CALLBACK_RECOVERY_GUIDANCE } from '../../codex/oauth-callback-port-diagnostic.js'

class UnavailableMcpCli implements CodexMcpCliPort {
  async list() {
    return { available: false, ok: false, rows: [], public_error: 'codex_cli_not_found' }
  }

  async transform(_before: string, _operation: CodexCliMutationOperation) {
    return {
      available: false,
      ok: false,
      used: false,
      text: null,
      unsupported_reason: 'codex_cli_not_found',
      public_error: null
    }
  }

  async login() {
    return { available: false, ok: false, public_error: 'codex_cli_not_found' }
  }

  async logout() {
    return { available: false, ok: false, public_error: 'codex_cli_not_found' }
  }
}

function hostCapabilityDependencies(toolNames: string[]) {
  return {
    inventory: async () => ({
      schema: 'sks.mcp-inventory.v2',
      ok: true,
      scope: 'project',
      source: 'fixture_inventory',
      servers: [{
        name: 'acas-tools',
        enabled: true,
        enabled_tools: [...toolNames],
        disabled_tools: []
      }],
      server_count: 1,
      enabled_count: 1,
      failed_count: 0,
      blockers: [],
      warnings: []
    }) as any,
    health: async () => ({
      schema: 'sks.mcp-health.v1',
      ok: true,
      name: 'acas-tools',
      scope: 'project',
      status: 'healthy',
      tool_names: [...toolNames]
    }) as any
  }
}

function completedHostToolEvent(input: {
  tool: string
  path?: string
  sourcePath?: string
  artifact?: Record<string, unknown>
}) {
  return JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'acas-tools',
      tool: input.tool,
      status: 'completed',
      ...(input.sourcePath
        ? { arguments: { source_path: input.sourcePath, ...(input.path ? { output_path: input.path } : {}) } }
        : input.path
          ? { arguments: { path: input.path } }
          : {}),
      result: {
        structured_content: input.artifact
          ? { artifact: input.artifact }
          : input.tool === 'spreadsheet_inspect'
            ? {
                ok: true,
                ...(input.path ? { path: input.path } : {}),
                sheet_names: ['Summary'],
                row_counts: { Summary: 1 },
                formulas: [],
                error_cells: []
              }
            : { ok: true, ...(input.path ? { path: input.path } : {}) }
      }
    }
  })
}

function completedArtifactHostToolEvent(tool: string, toolUseId: string, artifactPath: string): string {
  return JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'acas-tools',
      tool,
      status: 'completed',
      id: toolUseId,
      arguments: { path: artifactPath },
      result: {
        structured_content: {
          artifact: {
            path: artifactPath,
            kind: 'text',
            media_type: 'text/plain',
            sha256: `sha256:${sha256(`contents:${artifactPath}`)}`,
            bytes: artifactPath.length,
            role: 'deliverable'
          }
        }
      }
    }
  })
}

async function artifactCollectorEvidence(count: number): Promise<HostCapabilityExecutionEvidence> {
  const request = requestHostCapabilities('Create and save files in the workspace.')
  const runtime = await inspectHostCapabilityRuntime({
    root: process.cwd(),
    request,
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(['write_file'])
  })
  assert.equal(runtime.ok, true)
  const collector = createHostCapabilityEventCollector(runtime)
  for (let index = count - 1; index >= 0; index -= 1) {
    const artifactPath = `reports/artifact-${String(index).padStart(2, '0')}.txt`
    collector.push(`${completedArtifactHostToolEvent('write_file', `tool-${index}`, artifactPath)}\n`)
  }
  return collector.finish()
}

function prePayload(toolUseId: string, tool: string, toolInput: Record<string, unknown> = {}) {
  return {
    tool_use_id: toolUseId,
    tool_name: `mcp__acas-tools__${tool}`,
    tool_input: toolInput
  }
}

function postPayload(
  toolUseId: string,
  tool: string,
  toolInput: Record<string, unknown>,
  toolResponse: Record<string, unknown>
) {
  return {
    ...prePayload(toolUseId, tool, toolInput),
    tool_response: toolResponse
  }
}

test('app sessions return delegation context without launching nested Codex', async () => {
  let launched = false
  const result = await runOfficialSubagentWorkflow({
    root: process.cwd(),
    goal: 'delegate and wait',
    prompt: 'delegate and wait',
    requestedSubagents: 8,
    maxThreads: 12,
    appSession: true,
    runProcessImpl: async () => {
      launched = true
      throw new Error('must not launch')
    }
  })
  assert.equal(launched, false)
  assert.equal(result.status, 'delegation_context_ready')
  assert.equal(result.ok, false)
  assert.equal(result.prepared, true)
  assert.equal(result.completion_evidence, false)
  assert.equal(result.parent_model, 'gpt-5.6-sol')
  assert.equal(result.parent_reasoning_effort, 'max')
})

test('App session identity alone does not grant project trust for host-capability requests', async () => {
  let projectCalls = 0
  let launched = false
  const result = await runOfficialSubagentWorkflow({
    root: process.cwd(),
    goal: 'Create and deliver an Excel workbook.',
    prompt: 'sealed app delegation prompt',
    requestedSubagents: 1,
    maxThreads: 1,
    appSession: true,
    sessionKey: 'app-session-without-project-trust',
    projectTrusted: false,
    hostCapabilityDependencies: {
      inventory: async () => {
        projectCalls += 1
        throw new Error('untrusted App inventory must not run')
      },
      health: async () => {
        projectCalls += 1
        throw new Error('untrusted App health must not run')
      }
    } as any,
    runProcessImpl: async () => {
      launched = true
      throw new Error('App sessions must not launch nested Codex')
    }
  })

  assert.equal(projectCalls, 0)
  assert.equal(launched, false)
  assert.equal(result.status, 'host_capability_blocked')
  assert.ok(result.blockers.includes('host_capability_project_trust_missing'))
})

test('explicit App project trust performs bounded host probes and returns delegation context without nested spawn', async () => {
  let inventoryCalls = 0
  let healthCalls = 0
  let launched = false
  const dependencies: any = hostCapabilityDependencies([
    'spreadsheet_create',
    'spreadsheet_inspect',
    'spreadsheet_update',
    'slack_send'
  ])
  const inventory = dependencies.inventory
  const health = dependencies.health
  dependencies.inventory = async (...args: any[]) => {
    inventoryCalls += 1
    return inventory(...args)
  }
  dependencies.health = async (...args: any[]) => {
    healthCalls += 1
    return health(...args)
  }
  const result = await runOfficialSubagentWorkflow({
    root: process.cwd(),
    goal: 'Create and deliver an Excel workbook.',
    prompt: 'sealed trusted app delegation prompt',
    requestedSubagents: 1,
    maxThreads: 1,
    appSession: true,
    sessionKey: 'trusted-app-session',
    projectTrusted: true,
    hostCapabilityDependencies: dependencies,
    runProcessImpl: async () => {
      launched = true
      throw new Error('App sessions must not launch nested Codex')
    }
  })

  assert.equal(inventoryCalls, 1)
  assert.equal(healthCalls, 1)
  assert.equal(launched, false)
  assert.equal(result.status, 'delegation_context_ready')
  assert.equal(result.prepared, true)
  assert.deepEqual(result.host_capability_runtime.allowed_tool_names, [
    'spreadsheet_create',
    'spreadsheet_inspect',
    'spreadsheet_update'
  ])
})

test('standalone host-capability requests fail closed before project inventory, health, or Codex spawn', async () => {
  let projectCalls = 0
  let launched = false
  const result = await runOfficialSubagentWorkflow({
    root: process.cwd(),
    goal: 'Create and deliver an Excel workbook.',
    prompt: 'delegation prompt',
    requestedSubagents: 1,
    maxThreads: 1,
    appSession: false,
    hostCapabilityDependencies: {
      inventory: async () => {
        projectCalls += 1
        throw new Error('standalone project inventory must not run')
      },
      health: async () => {
        projectCalls += 1
        throw new Error('standalone project health must not run')
      }
    } as any,
    runProcessImpl: async () => {
      launched = true
      throw new Error('must not launch')
    }
  })

  assert.equal(projectCalls, 0)
  assert.equal(launched, false)
  assert.equal(result.ok, false)
  assert.equal(result.status, 'host_capability_blocked')
  assert.ok(result.blockers.includes('host_capability_project_trust_missing'))
  assert.equal(result.host_capability_evidence.ok, false)
})

test('explicit standalone project trust reaches inventory, health, narrow host allowlist, and Codex spawn', async (t) => {
  const cases = [
    {
      label: 'xlsx',
      goal: 'Create and deliver an Excel workbook.',
      tools: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update', 'slack_send'],
      allowed: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update'],
      events: () => {
        const artifact = {
          path: 'reports/trusted.xlsx',
          kind: 'spreadsheet',
          media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          sha256: `sha256:${'a'.repeat(64)}`,
          bytes: 4096,
          role: 'deliverable'
        }
        return [
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call', server: 'acas-tools', tool: 'spreadsheet_create', status: 'completed',
              arguments: { path: artifact.path }, result: { structured_content: { ok: true, path: artifact.path, artifact } }
            }
          }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call', server: 'acas-tools', tool: 'spreadsheet_inspect', status: 'completed',
              arguments: { path: artifact.path },
              result: { structured_content: {
                ok: true, path: artifact.path, sheet_names: ['Summary'], row_counts: { Summary: 1 }, formulas: [], error_cells: []
              } }
            }
          })
        ]
      }
    },
    {
      label: 'database',
      goal: 'Get active customer records from the database.',
      tools: ['datasource_schema_context', 'datasource_query_readonly', 'slack_send'],
      allowed: ['datasource_query_readonly', 'datasource_schema_context'],
      events: () => {
        const datasource = 'mysql:customers'
        const schemaSnapshotId = 'schema-customers-v1'
        const query = 'SELECT customer_id FROM customers WHERE active = ?'
        return [
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call', server: 'acas-tools', tool: 'datasource_schema_context', status: 'completed',
              arguments: { datasource }, result: { structured_content: { datasource, schema_snapshot_id: schemaSnapshotId } }
            }
          }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call', server: 'acas-tools', tool: 'datasource_query_readonly', status: 'completed',
              arguments: { datasource, schema_snapshot_id: schemaSnapshotId, query, bindings: [true] },
              result: { structured_content: {
                datasource,
                schema_snapshot_id: schemaSnapshotId,
                query_sha256: `sha256:${sha256(query)}`,
                row_count: 1,
                column_count: 1,
                truncated: false,
                status: 'passed'
              } }
            }
          })
        ]
      }
    }
  ] as const

  for (const fixture of cases) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `sks-trusted-host-${fixture.label}-`))
    t.after(async () => fsp.rm(root, { recursive: true, force: true }))
    const missionId = `M-trusted-${fixture.label}`
    const workflowRunId = `run-trusted-${fixture.label}`
    const pendingPath = path.join(
      missionDir(root, missionId),
      HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME
    )
    let inventoryCalls = 0
    let healthCalls = 0
    let spawnCalls = 0
    const dependencies: any = hostCapabilityDependencies([...fixture.tools])
    const inventory = dependencies.inventory
    const health = dependencies.health
    dependencies.inventory = async (...args: any[]) => {
      inventoryCalls += 1
      return inventory(...args)
    }
    dependencies.health = async (...args: any[]) => {
      healthCalls += 1
      return health(...args)
    }
    let launchedArgs: readonly string[] = []
    let launchedEnv: NodeJS.ProcessEnv = {}
    const result = await runOfficialSubagentWorkflow({
      root,
      goal: fixture.goal,
      prompt: `trusted standalone ${fixture.label}`,
      requestedSubagents: 1,
      maxThreads: 1,
      appSession: false,
      projectTrusted: true,
      missionId,
      workflowRunId,
      hostCapabilityDependencies: dependencies,
      runProcessImpl: async (_command, args, options) => {
        spawnCalls += 1
        launchedArgs = args
        launchedEnv = options?.env || {}
        const pending = JSON.parse(await fsp.readFile(pendingPath, 'utf8'))
        assert.equal(pending.launch_nonce, undefined, fixture.label)
        assert.equal(
          pending.launch_nonce_sha256,
          `sha256:${sha256(String(launchedEnv.SKS_NARUTO_PARENT_HOST_CAPABILITY_NONCE || ''))}`,
          fixture.label
        )
        const outputIndex = args.indexOf('--output-last-message')
        await fsp.writeFile(args[outputIndex + 1]!, JSON.stringify({
          schema: 'sks.subagent-parent-summary.v1',
          status: 'completed',
          summary: `${fixture.label} completed`,
          thread_outcomes: [{ thread_id: `thread-${fixture.label}`, status: 'completed', summary: 'complete' }],
          changed_files: [],
          verification: [],
          blockers: []
        }))
        const events = fixture.events()
        for (const event of events) options?.onStdout?.(`${event}\n`)
        return {
          code: 0,
          stdout: `${events.join('\n')}\n`,
          stderr: '',
          stdoutBytes: Buffer.byteLength(events.join('\n')),
          stderrBytes: 0,
          truncated: false,
          timedOut: false
        }
      }
    })

    assert.equal(inventoryCalls, 1, fixture.label)
    assert.equal(healthCalls, 1, fixture.label)
    assert.equal(spawnCalls, 1, fixture.label)
    assert.equal(result.status, 'parent_completed', fixture.label)
    assert.equal(result.host_capability_evidence.ok, true, fixture.label)
    if (fixture.label === 'xlsx') {
      assert.deepEqual(result.host_capability_evidence.artifacts.map((artifact: any) => artifact.path), [
        'reports/trusted.xlsx'
      ])
      assert.deepEqual(result.host_capability_evidence.artifact_sources.map((artifact: any) => artifact.path), [
        'reports/trusted.xlsx'
      ])
    }
    assert.ok(launchedArgs.includes(
      `mcp_servers.acas-tools.enabled_tools=[${fixture.allowed.map((tool) => JSON.stringify(tool)).join(', ')}]`
    ), fixture.label)
    assert.ok(launchedArgs.includes('mcp_servers.acas-tools.disabled_tools=["slack_send"]'), fixture.label)
    assert.ok(launchedArgs.includes(`projects={${JSON.stringify(await fsp.realpath(root))}={trust_level="trusted"}}`), fixture.label)
    assert.ok(launchedArgs.includes('-C'), fixture.label)
    assert.ok(launchedArgs.includes(await fsp.realpath(root)), fixture.label)
    assert.equal(launchedEnv.SKS_NARUTO_PARENT_WORKFLOW_RUN_ID, workflowRunId)
    assert.match(String(launchedEnv.SKS_NARUTO_PARENT_HOST_CAPABILITY_NONCE || ''), /^[a-f0-9]{32}$/)
    await assert.rejects(fsp.access(pendingPath), fixture.label)
  }
})

test('trusted host runtime allowlists requested ACAS tools and projects only hashed JSONL evidence', async () => {
  const tools = ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update', 'slack_send']
  const artifact = {
    path: 'reports/monthly.xlsx',
    kind: 'spreadsheet',
    media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sha256: `sha256:${'a'.repeat(64)}`,
    bytes: 4,
    role: 'deliverable'
  }
  const runtime = await inspectHostCapabilityRuntime({
    root: process.cwd(),
    request: requestHostCapabilities('Create and deliver an Excel workbook.'),
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(tools)
  })
  const launchedArgs = hostCapabilityCodexConfigArgs(runtime)
  const collector = createHostCapabilityEventCollector(runtime)
  for (const line of [
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        server: 'acas-tools',
        tool: 'spreadsheet_create',
        status: 'completed',
        arguments: { path: artifact.path, api_key: 'raw-jsonl-secret-must-not-return' },
        result: { structured_content: { artifact } }
      }
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        server: 'acas-tools',
        tool: 'spreadsheet_inspect',
        status: 'completed',
        arguments: { path: artifact.path },
        result: {
          structured_content: {
            ok: true,
            path: artifact.path,
            sheet_names: ['Summary'],
            row_counts: { Summary: 1 },
            formulas: [],
            error_cells: []
          }
        }
      }
    })
  ]) collector.push(`${line}\n`)
  const evidence = collector.finish()

  assert.equal(runtime.ok, true)
  assert.ok(launchedArgs.includes('mcp_servers.acas-tools.enabled_tools=["spreadsheet_create", "spreadsheet_inspect", "spreadsheet_update"]'))
  assert.ok(launchedArgs.includes('mcp_servers.acas-tools.disabled_tools=["slack_send"]'))
  assert.deepEqual(evidence.artifacts, [artifact])
  assert.equal(evidence.capabilities_used.every((row: any) => row.status === 'passed'), true)

  const rebound = bindParentSummaryToHostCapabilityEvidence({
    schema: 'sks.subagent-parent-summary.v1',
    status: 'completed',
    summary: 'unobserved claim',
    thread_outcomes: [{ thread_id: 'thread-a', status: 'completed', summary: 'complete' }],
    artifacts: [{ ...artifact, bytes: 999 }],
    capabilities_used: [],
    blockers: []
  }, evidence)
  assert.equal((rebound.value as any).status, 'blocked')
  assert.deepEqual((rebound.value as any).artifacts, [artifact])
  assert.ok(rebound.blockers.includes('host_artifact_parent_receipts_mismatch'))
})

test('standalone host-capability launch confines a nonce reflected in structured host evidence', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-host-capability-nonce-redaction-'))
  t.after(async () => fsp.rm(root, { recursive: true, force: true }))
  let launchNonce = ''

  const result = await runOfficialSubagentWorkflow({
    root,
    goal: 'Create and save a file in the workspace.',
    prompt: 'echo launch nonce fixture',
    requestedSubagents: 1,
    maxThreads: 1,
    appSession: false,
    projectTrusted: true,
    missionId: 'M-host-capability-nonce-redaction',
    workflowRunId: 'run-host-capability-nonce-redaction',
    hostCapabilityDependencies: hostCapabilityDependencies(['write_file']),
    runProcessImpl: async (_command, args, options) => {
      launchNonce = String(options?.env?.SKS_NARUTO_PARENT_HOST_CAPABILITY_NONCE || '')
      assert.match(launchNonce, /^[a-f0-9]{32}$/)
      const outputIndex = args.indexOf('--output-last-message')
      await fsp.writeFile(args[outputIndex + 1]!, `summary nonce=${launchNonce}`)
      const event = completedArtifactHostToolEvent('write_file', 'nonce-redaction-tool', `reports/${launchNonce}.txt`)
      const stdout = `${event}\nnonce=${launchNonce}\n`
      const stderr = `stderr nonce=${launchNonce}`
      options?.onStdout?.(stdout)
      return {
        code: 0,
        stdout,
        stderr,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        truncated: false,
        timedOut: false
      }
    }
  })

  assert.doesNotMatch(JSON.stringify(result), new RegExp(launchNonce))
  assert.equal(result.ok, false)
  assert.equal(result.status, 'host_capability_blocked')
  assert.equal(result.host_capability_evidence.ok, false)
  assert.deepEqual(result.host_capability_evidence.tool_calls, [])
  assert.deepEqual(result.host_capability_evidence.artifacts, [])
  assert.deepEqual(result.host_capability_evidence.artifact_sources, [])
  assert.deepEqual(trustedHostCapabilityReceiptBindingBlockers(result.host_capability_evidence), [])
  assert.ok(result.blockers.includes('host_capability_evidence_secret_reflection'))
  assert.equal(result.parent_summary, 'summary nonce=<redacted>')
  assert.equal(result.process.stdout_tail, '')
  assert.equal(result.process.stderr_tail, 'stderr nonce=<redacted>')
})

test('standalone host-capability launch confines an inherited secret reflected in structured host evidence', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-host-capability-secret-confinement-'))
  t.after(async () => fsp.rm(root, { recursive: true, force: true }))
  const inheritedSecret = 'inherited-structured-host-secret'

  const result = await runOfficialSubagentWorkflow({
    root,
    goal: 'Create and save a file in the workspace.',
    prompt: 'echo inherited secret fixture',
    requestedSubagents: 1,
    maxThreads: 1,
    appSession: false,
    projectTrusted: true,
    missionId: 'M-host-capability-secret-confinement',
    workflowRunId: 'run-host-capability-secret-confinement',
    env: { CODEX_API_KEY: inheritedSecret },
    hostCapabilityDependencies: hostCapabilityDependencies(['write_file']),
    runProcessImpl: async (_command, args, options) => {
      const outputIndex = args.indexOf('--output-last-message')
      await fsp.writeFile(args[outputIndex + 1]!, 'summary completed')
      const event = completedArtifactHostToolEvent(
        'write_file',
        'inherited-secret-tool',
        `reports/${inheritedSecret}.txt`
      )
      options?.onStdout?.(`${event}\n`)
      return {
        code: 0,
        stdout: `${event}\n`,
        stderr: '',
        stdoutBytes: Buffer.byteLength(event),
        stderrBytes: 0,
        truncated: false,
        timedOut: false
      }
    }
  })

  assert.doesNotMatch(JSON.stringify(result), new RegExp(inheritedSecret))
  assert.equal(result.status, 'host_capability_blocked')
  assert.deepEqual(result.host_capability_evidence.tool_calls, [])
  assert.deepEqual(result.host_capability_evidence.artifacts, [])
  assert.deepEqual(result.host_capability_evidence.artifact_sources, [])
  assert.deepEqual(trustedHostCapabilityReceiptBindingBlockers(result.host_capability_evidence), [])
  assert.ok(result.blockers.includes('host_capability_evidence_secret_reflection'))
})

test('host capability requests select the minimum task tools and recognize workbook population', async () => {
  const workspaceTools = [
    'read_file',
    'write_file',
    'edit_file',
    'find_workspace_files',
    'list_workspace',
    'download_url_to_workspace'
  ]
  const readRequest = requestHostCapabilities('Read README.md from the workspace.')
  assert.deepEqual(readRequest.tool_names, ['read_file'])
  const readRuntime = await inspectHostCapabilityRuntime({
    root: process.cwd(),
    request: readRequest,
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(workspaceTools)
  })
  assert.equal(readRuntime.ok, true)
  assert.deepEqual(readRuntime.allowed_tool_names, ['read_file'])
  assert.ok(readRuntime.denied_tool_names.includes('write_file'))
  assert.ok(readRuntime.denied_tool_names.includes('download_url_to_workspace'))

  const editRequest = requestHostCapabilities('Populate quarterly numbers into reports/q3.xlsx.')
  assert.ok(editRequest.workflows.includes('spreadsheet_edit'))
  assert.deepEqual(editRequest.tool_names, ['spreadsheet_inspect', 'spreadsheet_update'])
  const editRuntime = await inspectHostCapabilityRuntime({
    root: process.cwd(),
    request: editRequest,
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update'])
  })
  assert.equal(editRuntime.ok, true)
  assert.deepEqual(editRuntime.allowed_tool_names, ['spreadsheet_inspect', 'spreadsheet_update'])

  for (const prompt of [
    'Analyze the database module data flow and report code-review findings.',
    'Update the spreadsheet parser unit tests.',
    'Create tests for the PDF renderer.',
    'Run the database query unit tests.',
    'Execute the read-only database query integration tests.',
    'Update the documentation explaining how to create an Excel workbook.',
    'Update the documentation explaining how to build an Excel workbook.',
    'Update the documentation explaining how to prepare an Excel report.',
    'Update the documentation explaining how to populate a new Excel workbook.',
    'Explain how to build an Excel workbook.',
    'Show me how to prepare an Excel report.',
    'How do I populate a new Excel workbook?',
    'Explain how to get active customer records from the database.',
    'Show me how to read the latest rows in the database.',
    'How do I pull Q2 sales from the database?',
    'Build the Excel workbook parser.',
    'Prepare Excel workbook tests.'
  ]) {
    assert.deepEqual(requestHostCapabilities(prompt), {
      capability_ids: [],
      workflows: [],
      tool_names: []
    }, prompt)
  }

  for (const prompt of [
    'Convert data.csv to XLSX',
    'Export these rows as XLSX'
  ]) {
    assert.deepEqual(requestHostCapabilities(prompt), {
      capability_ids: ['host.artifact.receipt.v1', 'host.spreadsheet.workbook.v1'],
      workflows: ['artifact_delivery', 'spreadsheet_create'],
      tool_names: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update']
    }, prompt)
  }

  for (const prompt of [
    'Show me sales data from the database',
    'List active customer records from the database',
    'Get active customer records from the database',
    'Please read the latest rows in the database'
  ]) {
    assert.deepEqual(requestHostCapabilities(prompt), {
      capability_ids: ['host.datasource.query.readonly.v1', 'host.datasource.schema.v1'],
      workflows: ['datasource_query'],
      tool_names: ['datasource_query_readonly', 'datasource_schema_context']
    }, prompt)
  }

  assert.deepEqual(
    requestHostCapabilities('Pull Q2 sales from the database and export them as XLSX.'),
    {
      capability_ids: [
        'host.artifact.receipt.v1',
        'host.datasource.query.readonly.v1',
        'host.datasource.schema.v1',
        'host.spreadsheet.workbook.v1'
      ],
      workflows: ['artifact_delivery', 'datasource_query', 'spreadsheet_create'],
      tool_names: [
        'datasource_query_readonly',
        'datasource_schema_context',
        'spreadsheet_create',
        'spreadsheet_inspect',
        'spreadsheet_update'
      ]
    }
  )

  for (const prompt of [
    'Build an Excel workbook.',
    'Prepare an Excel report.',
    'Populate a new Excel workbook.'
  ]) {
    assert.deepEqual(requestHostCapabilities(prompt), {
      capability_ids: ['host.artifact.receipt.v1', 'host.spreadsheet.workbook.v1'],
      workflows: ['artifact_delivery', 'spreadsheet_create'],
      tool_names: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update']
    }, prompt)
  }

  for (const prompt of [
    'Write SQL to fetch customer data; do not execute it.',
    'Write SQL to fetch customer data without running it.',
    'Write SQL to fetch customer data without running the query.',
    'Write SQL to fetch customer data without actually executing it.'
  ]) {
    assert.deepEqual(requestHostCapabilities(prompt), {
      capability_ids: ['host.datasource.schema.v1'],
      workflows: ['datasource_sql_generation'],
      tool_names: ['datasource_schema_context']
    }, prompt)
  }

  assert.deepEqual(
    requestHostCapabilities('Write SQL to fetch customer data and execute it.'),
    {
      capability_ids: ['host.datasource.query.readonly.v1', 'host.datasource.schema.v1'],
      workflows: ['datasource_query', 'datasource_sql_generation'],
      tool_names: ['datasource_query_readonly', 'datasource_schema_context']
    }
  )

  for (const prompt of [
    'Write SQL to fetch customer data; do not execute it. Then read the latest rows in the database.',
    'Write SQL to fetch customer data without running it. Then show current rows from the database.'
  ]) {
    assert.deepEqual(requestHostCapabilities(prompt), {
      capability_ids: ['host.datasource.query.readonly.v1', 'host.datasource.schema.v1'],
      workflows: ['datasource_query', 'datasource_sql_generation'],
      tool_names: ['datasource_query_readonly', 'datasource_schema_context']
    }, prompt)
  }

  assert.deepEqual(
    requestHostCapabilities('Update the workbook parser, then build an Excel workbook.'),
    {
      capability_ids: ['host.artifact.receipt.v1', 'host.spreadsheet.workbook.v1'],
      workflows: ['artifact_delivery', 'spreadsheet_create'],
      tool_names: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update']
    }
  )

  assert.deepEqual(
    requestHostCapabilities('Test the database and get active customer records from the database.'),
    {
      capability_ids: ['host.datasource.query.readonly.v1', 'host.datasource.schema.v1'],
      workflows: ['datasource_query'],
      tool_names: ['datasource_query_readonly', 'datasource_schema_context']
    }
  )

  assert.deepEqual(
    requestHostCapabilities('Create an Excel workbook and update it.'),
    {
      capability_ids: ['host.artifact.receipt.v1', 'host.spreadsheet.workbook.v1'],
      workflows: ['artifact_delivery', 'spreadsheet_create', 'spreadsheet_edit'],
      tool_names: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update']
    }
  )

  assert.deepEqual(
    requestHostCapabilities('Update the PDF renderer code, then create a PDF document.'),
    {
      capability_ids: ['host.artifact.receipt.v1', 'host.document.render.v1', 'host.workspace.files.v1'],
      workflows: ['artifact_delivery', 'document_render', 'workspace_files'],
      tool_names: ['html_to_pdf', 'write_file']
    }
  )

  for (const [prompt, capability] of [
    ['Test the database and fetch customer data.', 'host.datasource.query.readonly.v1'],
    ['In this test, analyze database data and report anomalies.', 'host.datasource.query.readonly.v1'],
    ['Test the PDF and export it.', 'host.document.render.v1'],
    ['Update the spreadsheet with the latest test results.', 'host.spreadsheet.workbook.v1'],
    ['Inspect reports/q3.xlsx and update it with integration test results.', 'host.spreadsheet.workbook.v1'],
    ['최신 테스트 결과로 스프레드시트를 업데이트해줘.', 'host.spreadsheet.workbook.v1'],
    ['매출 DB에서 월별 합계를 뽑아줘', 'host.datasource.query.readonly.v1'],
    ['실행하지 말고 SQL만 작성해줘', 'host.datasource.schema.v1'],
    ['이 데이터를 엑셀로 정리해줘', 'host.spreadsheet.workbook.v1'],
    ['기존 엑셀 수식 오류를 고쳐줘', 'host.spreadsheet.workbook.v1'],
    ['이 문서를 PDF 파일로 저장해줘', 'host.document.render.v1'],
    ['이 URL 페이지를 캡처해줘', 'host.web.capture.v1']
  ] as const) {
    assert.ok(requestHostCapabilities(prompt).capability_ids.includes(capability), prompt)
  }
  assert.deepEqual(requestHostCapabilities('실행하지 말고 SQL만 작성해줘').workflows, ['datasource_sql_generation'])
  assert.ok(requestHostCapabilities('매출 DB에서 월별 합계를 뽑아줘').workflows.includes('datasource_query'))
  assert.ok(requestHostCapabilities('이 데이터를 엑셀로 정리해줘').workflows.includes('spreadsheet_create'))
  assert.ok(requestHostCapabilities('기존 엑셀 수식 오류를 고쳐줘').workflows.includes('spreadsheet_edit'))
  assert.ok(requestHostCapabilities('이 문서를 PDF 파일로 저장해줘').workflows.includes('document_render'))
  assert.ok(requestHostCapabilities('이 URL 페이지를 캡처해줘').workflows.includes('web_capture'))

  for (const prompt of [
    '이 CSV에서 월별 합계 내줘',
    '이 문서의 상위 10건을 정리해줘',
    '이 JSON 데이터에서 통계 내줘',
    '매출 DB 현황 조회용 SQL 실행은 금지해줘'
  ]) {
    assert.equal(requestHostCapabilities(prompt).workflows.includes('datasource_query'), false, prompt)
  }

  for (const prompt of [
    'mysql에서 월별 합계를 뽑아줘',
    'warehouse:sales 데이터소스의 상위 5건을 보여줘'
  ]) {
    assert.equal(requestHostCapabilities(prompt).workflows.includes('datasource_query'), true, prompt)
  }

  const webPageImage = requestHostCapabilities('이 URL의 웹 페이지를 이미지로 캡처해줘')
  assert.equal(webPageImage.workflows.includes('web_capture'), true)
  assert.equal(webPageImage.workflows.includes('document_render'), false)

  const reportRender = requestHostCapabilities('이 HTML 보고서를 PNG로 렌더해줘')
  assert.equal(reportRender.workflows.includes('document_render'), true)
  assert.equal(reportRender.workflows.includes('web_capture'), false)
})

test('spreadsheet evidence allows up to three bounded mutations with inspect after each', async () => {
  const workbookPath = 'reports/q3.xlsx'
  const createArtifact = {
    path: workbookPath,
    kind: 'spreadsheet',
    media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sha256: `sha256:${'a'.repeat(64)}`,
    bytes: 10,
    role: 'deliverable'
  }
  const updateArtifact = { ...createArtifact, sha256: `sha256:${'b'.repeat(64)}`, bytes: 12 }
  const request = requestHostCapabilities('Create and deliver an Excel workbook.')
  const runtime = await inspectHostCapabilityRuntime({
    root: process.cwd(),
    request,
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update'])
  })
  assert.equal(runtime.ok, true)

  const missingFinalInspect = createHostCapabilityEventCollector(runtime)
  for (const event of [
    completedHostToolEvent({ tool: 'spreadsheet_create', path: workbookPath, artifact: createArtifact }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath }),
    completedHostToolEvent({ tool: 'spreadsheet_update', path: workbookPath, artifact: updateArtifact })
  ]) missingFinalInspect.push(`${event}\n`)
  const missingFinalEvidence = missingFinalInspect.finish()
  assert.equal(missingFinalEvidence.ok, false)
  assert.ok(missingFinalEvidence.blockers.includes('host_capability_spreadsheet_create_sequence_invalid'))

  const repeatedUpdate = createHostCapabilityEventCollector(runtime)
  for (const event of [
    completedHostToolEvent({ tool: 'spreadsheet_create', path: workbookPath, artifact: createArtifact }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath }),
    completedHostToolEvent({ tool: 'spreadsheet_update', path: workbookPath, artifact: updateArtifact }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath }),
    completedHostToolEvent({ tool: 'spreadsheet_update', path: workbookPath, artifact: { ...updateArtifact, sha256: `sha256:${'c'.repeat(64)}` } }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath })
  ]) repeatedUpdate.push(`${event}\n`)
  const repeatedUpdateEvidence = repeatedUpdate.finish()
  assert.equal(repeatedUpdateEvidence.ok, true, repeatedUpdateEvidence.blockers.join(', '))

  const tooManyUpdates = createHostCapabilityEventCollector(runtime)
  for (const event of [
    completedHostToolEvent({ tool: 'spreadsheet_create', path: workbookPath, artifact: createArtifact }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath }),
    completedHostToolEvent({ tool: 'spreadsheet_update', path: workbookPath, artifact: updateArtifact }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath }),
    completedHostToolEvent({ tool: 'spreadsheet_update', path: workbookPath, artifact: { ...updateArtifact, sha256: `sha256:${'c'.repeat(64)}` } }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath }),
    completedHostToolEvent({ tool: 'spreadsheet_update', path: workbookPath, artifact: { ...updateArtifact, sha256: `sha256:${'d'.repeat(64)}` } }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath }),
    completedHostToolEvent({ tool: 'spreadsheet_update', path: workbookPath, artifact: { ...updateArtifact, sha256: `sha256:${'e'.repeat(64)}` } }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath })
  ]) tooManyUpdates.push(`${event}\n`)
  const tooManyUpdatesEvidence = tooManyUpdates.finish()
  assert.equal(tooManyUpdatesEvidence.ok, false)
  assert.ok(tooManyUpdatesEvidence.blockers.includes('host_capability_spreadsheet_create_update_count_invalid'))

  const resourceMismatch = createHostCapabilityEventCollector(runtime)
  for (const event of [
    completedHostToolEvent({ tool: 'spreadsheet_create', path: workbookPath, artifact: createArtifact }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: 'reports/other.xlsx' })
  ]) resourceMismatch.push(`${event}\n`)
  const resourceMismatchEvidence = resourceMismatch.finish()
  assert.equal(resourceMismatchEvidence.ok, false)
  assert.ok(resourceMismatchEvidence.blockers.includes('host_capability_spreadsheet_resource_mismatch'))

  const receiptResourceMismatch = createHostCapabilityEventCollector(runtime)
  for (const event of [
    completedHostToolEvent({
      tool: 'spreadsheet_create',
      path: workbookPath,
      artifact: { ...createArtifact, path: 'reports/other.xlsx' }
    }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath })
  ]) receiptResourceMismatch.push(`${event}\n`)
  const receiptResourceMismatchEvidence = receiptResourceMismatch.finish()
  assert.equal(receiptResourceMismatchEvidence.ok, false)
  assert.ok(receiptResourceMismatchEvidence.blockers.includes('host_capability_spreadsheet_resource_mismatch'))
  assert.ok(receiptResourceMismatchEvidence.blockers.includes('host_capability_spreadsheet_final_artifact_missing'))

  const invalidReceipts = [
    ...(['scratch', 'temp', 'log'] as const).map((role) => ({ label: role, artifact: { ...createArtifact, role } })),
    { label: 'text kind', artifact: { ...createArtifact, kind: 'text' } },
    { label: 'text media', artifact: { ...createArtifact, media_type: 'text/plain' } },
    { label: 'text extension', artifact: { ...createArtifact, path: 'reports/q3.txt' } }
  ]
  for (const invalid of invalidReceipts) {
    const invalidReceipt = createHostCapabilityEventCollector(runtime)
    for (const event of [
      completedHostToolEvent({ tool: 'spreadsheet_create', path: workbookPath, artifact: invalid.artifact }),
      completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath })
    ]) invalidReceipt.push(`${event}\n`)
    const invalidReceiptEvidence = invalidReceipt.finish()
    assert.equal(invalidReceiptEvidence.ok, false, invalid.label)
    assert.ok(invalidReceiptEvidence.blockers.includes('host_capability_spreadsheet_final_artifact_missing'), invalid.label)
  }

  const detachedMutationReceipt = createHostCapabilityEventCollector(runtime)
  for (const event of [
    completedHostToolEvent({ tool: 'spreadsheet_create', path: workbookPath, artifact: createArtifact }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath }),
    completedHostToolEvent({ tool: 'spreadsheet_update', path: workbookPath }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath })
  ]) detachedMutationReceipt.push(`${event}\n`)
  const detachedMutationEvidence = detachedMutationReceipt.finish()
  assert.equal(detachedMutationEvidence.ok, false)
  assert.ok(detachedMutationEvidence.blockers.includes('host_capability_spreadsheet_final_artifact_missing'))

  for (const unsafePath of ['reports/./q3.xlsx', 'reports/archive/../q3.xlsx', '/reports/q3.xlsx', 'C:/reports/q3.xlsx', 'reports\\q3.xlsx']) {
    const unsafeReceipt = createHostCapabilityEventCollector(runtime)
    for (const event of [
      completedHostToolEvent({
        tool: 'spreadsheet_create',
        path: workbookPath,
        artifact: { ...createArtifact, path: unsafePath }
      }),
      completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath })
    ]) unsafeReceipt.push(`${event}\n`)
    const unsafeReceiptEvidence = unsafeReceipt.finish()
    assert.equal(unsafeReceiptEvidence.ok, false, unsafePath)
    assert.ok(unsafeReceiptEvidence.blockers.includes('host_capability_spreadsheet_final_artifact_missing'), unsafePath)
  }

  const valid = createHostCapabilityEventCollector(runtime)
  for (const event of [
    completedHostToolEvent({ tool: 'spreadsheet_create', path: workbookPath, artifact: createArtifact }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath }),
    completedHostToolEvent({ tool: 'spreadsheet_update', path: workbookPath, artifact: updateArtifact }),
    completedHostToolEvent({ tool: 'spreadsheet_inspect', path: workbookPath })
  ]) valid.push(`${event}\n`)
  const validEvidence = valid.finish()
  assert.equal(validEvidence.ok, true)
  assert.equal(validEvidence.artifacts.length, 1)
  assert.deepEqual(trustedHostCapabilityReceiptBindingBlockers(validEvidence), [])
})

test('document evidence requires an editable source before render and a render artifact receipt', async () => {
  const request = requestHostCapabilities('Create and deliver a PDF document.')
  assert.deepEqual(request.tool_names, ['html_to_pdf', 'write_file'])
  const runtime = await inspectHostCapabilityRuntime({
    root: process.cwd(),
    request,
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(['write_file', 'edit_file', 'html_to_pdf', 'html_to_screenshot'])
  })
  assert.equal(runtime.ok, true)
  assert.deepEqual(runtime.allowed_tool_names, ['html_to_pdf', 'write_file'])
  const pdfArtifact = {
    path: 'reports/brief.pdf',
    kind: 'pdf',
    media_type: 'application/pdf',
    sha256: `sha256:${'d'.repeat(64)}`,
    bytes: 20,
    role: 'deliverable'
  }
  const htmlArtifact = {
    path: 'reports/brief.html',
    kind: 'html',
    media_type: 'text/html',
    sha256: `sha256:${'e'.repeat(64)}`,
    bytes: 12,
    role: 'scratch'
  }

  const renderOnly = createHostCapabilityEventCollector(runtime)
  renderOnly.push(`${completedHostToolEvent({
    tool: 'html_to_pdf',
    path: 'reports/brief.pdf',
    sourcePath: htmlArtifact.path,
    artifact: pdfArtifact
  })}\n`)
  const renderOnlyEvidence = renderOnly.finish()
  assert.equal(renderOnlyEvidence.ok, false)
  assert.ok(renderOnlyEvidence.blockers.includes('host_capability_document_source_sequence_invalid'))

  const invalidRenderReceipts = [
    ...(['scratch', 'temp', 'log'] as const).map((role) => ({ label: role, artifact: { ...pdfArtifact, role } })),
    { label: 'png kind', artifact: { ...pdfArtifact, kind: 'png' } },
    { label: 'png media', artifact: { ...pdfArtifact, media_type: 'image/png' } },
    { label: 'png extension', artifact: { ...pdfArtifact, path: 'reports/brief.png' } }
  ]
  for (const invalid of invalidRenderReceipts) {
    const invalidRenderReceipt = createHostCapabilityEventCollector(runtime)
    invalidRenderReceipt.push(`${completedHostToolEvent({
      tool: 'write_file',
      path: htmlArtifact.path,
      artifact: htmlArtifact
    })}\n`)
    invalidRenderReceipt.push(`${completedHostToolEvent({
      tool: 'html_to_pdf',
      path: 'reports/brief.pdf',
      sourcePath: htmlArtifact.path,
      artifact: invalid.artifact
    })}\n`)
    const invalidRenderReceiptEvidence = invalidRenderReceipt.finish()
    assert.equal(invalidRenderReceiptEvidence.ok, false, invalid.label)
    assert.ok(invalidRenderReceiptEvidence.blockers.includes('host_capability_document_render_artifact_missing'), invalid.label)
  }

  const detachedRenderReceipt = createHostCapabilityEventCollector(runtime)
  detachedRenderReceipt.push(`${completedHostToolEvent({
    tool: 'write_file',
    path: htmlArtifact.path,
    artifact: htmlArtifact
  })}\n`)
  detachedRenderReceipt.push(`${completedHostToolEvent({
    tool: 'html_to_pdf',
    path: 'reports/brief.pdf',
    sourcePath: htmlArtifact.path,
    artifact: pdfArtifact
  })}\n`)
  detachedRenderReceipt.push(`${completedHostToolEvent({
    tool: 'html_to_pdf',
    path: 'reports/final.pdf',
    sourcePath: htmlArtifact.path
  })}\n`)
  const detachedRenderReceiptEvidence = detachedRenderReceipt.finish()
  assert.equal(detachedRenderReceiptEvidence.ok, false)
  assert.ok(detachedRenderReceiptEvidence.blockers.includes('host_capability_document_render_artifact_missing'))

  const valid = createHostCapabilityEventCollector(runtime)
  valid.push(`${completedHostToolEvent({
    tool: 'write_file',
    path: htmlArtifact.path,
    artifact: htmlArtifact
  })}\n`)
  valid.push(`${completedHostToolEvent({
    tool: 'html_to_pdf',
    path: 'reports/brief.pdf',
    sourcePath: htmlArtifact.path,
    artifact: pdfArtifact
  })}\n`)
  const validEvidence = valid.finish()
  assert.equal(validEvidence.ok, true)
  assert.deepEqual(trustedHostCapabilityReceiptBindingBlockers(validEvidence), [])

  const pngRequest = requestHostCapabilities('Create and deliver a PNG document screenshot.')
  const pngRuntime = await inspectHostCapabilityRuntime({
    root: process.cwd(),
    request: pngRequest,
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(['write_file', 'html_to_screenshot'])
  })
  const validPng = createHostCapabilityEventCollector(pngRuntime)
  validPng.push(`${completedHostToolEvent({
    tool: 'write_file',
    path: htmlArtifact.path,
    artifact: htmlArtifact
  })}\n`)
  validPng.push(`${completedHostToolEvent({
    tool: 'html_to_screenshot',
    path: 'reports/brief.png',
    sourcePath: htmlArtifact.path,
    artifact: {
      path: 'reports/brief.png',
      kind: 'png',
      media_type: 'image/png',
      sha256: `sha256:${'f'.repeat(64)}`,
      bytes: 24,
      role: 'deliverable'
    }
  })}\n`)
  const validPngEvidence = validPng.finish()
  assert.equal(validPngEvidence.ok, true)
  assert.deepEqual(trustedHostCapabilityReceiptBindingBlockers(validPngEvidence), [])
})

test('artifact capability requires a receipt bound to every passed artifact-producing call', async () => {
  const request = requestHostCapabilities('Create and save files in the workspace.')
  const runtime = await inspectHostCapabilityRuntime({
    root: process.cwd(),
    request,
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(['write_file'])
  })
  assert.equal(runtime.ok, true)
  const artifacts = [
    {
      path: 'reports/a.txt',
      kind: 'text',
      media_type: 'text/plain',
      sha256: `sha256:${'a'.repeat(64)}`,
      bytes: 1,
      role: 'deliverable'
    },
    {
      path: 'reports/b.txt',
      kind: 'text',
      media_type: 'text/plain',
      sha256: `sha256:${'b'.repeat(64)}`,
      bytes: 1,
      role: 'deliverable'
    }
  ]
  for (const missingArtifactIndex of [0, 1]) {
    const collector = createHostCapabilityEventCollector(runtime)
    for (let index = 0; index < artifacts.length; index += 1) {
      collector.push(`${completedHostToolEvent({
        tool: 'write_file',
        path: artifacts[index]!.path,
        ...(index === missingArtifactIndex ? {} : { artifact: artifacts[index] })
      })}\n`)
    }
    const evidence = collector.finish()
    assert.equal(evidence.ok, false, `missing artifact for call ${missingArtifactIndex}`)
    assert.ok(
      evidence.blockers.includes('host_capability_artifact_receipt_missing'),
      `missing artifact for call ${missingArtifactIndex}`
    )
  }
})

test('collector binds 8, 10, 12, and 64 artifacts to exact canonical source events without reconstruction', async () => {
  for (const count of [8, 10, 12, 64]) {
    const evidence = await artifactCollectorEvidence(count)
    assert.equal(evidence.ok, true, `${count} artifacts`)
    assert.equal(evidence.artifacts.length, count)
    assert.equal(evidence.artifact_sources.length, count)
    assert.deepEqual(
      evidence.artifact_sources.map((source) => source.path),
      evidence.artifacts.map((artifact) => artifact.path),
      `${count} artifacts use the public canonical artifact order`
    )
    assert.deepEqual(trustedHostCapabilityReceiptBindingBlockers(evidence), [], `${count} artifacts`)
  }
})

test('trusted receipt binding rejects forged, missing, and duplicate artifact source mappings', async () => {
  const trusted = await artifactCollectorEvidence(8)
  const forged = {
    ...trusted,
    artifact_sources: trusted.artifact_sources.map((source, index) => index === 0
      ? { ...source, source_event_sha256: `sha256:${'f'.repeat(64)}` }
      : source)
  }
  assert.ok(trustedHostCapabilityReceiptBindingBlockers(forged).includes('host_artifact_source_mapping_forged'))

  const missing = { ...trusted, artifact_sources: trusted.artifact_sources.slice(1) }
  assert.ok(trustedHostCapabilityReceiptBindingBlockers(missing).includes('host_artifact_source_mapping_missing'))

  const duplicate = {
    ...trusted,
    artifact_sources: [trusted.artifact_sources[0]!, ...trusted.artifact_sources.slice(0, -1)]
  }
  assert.ok(trustedHostCapabilityReceiptBindingBlockers(duplicate).includes('host_artifact_source_mapping_duplicate'))
})

test('atomic reservations deny query races until one completed schema call and remain idempotent by tool_use_id', async () => {
  const request = requestHostCapabilities('Get customer records from the database.')
  const runtime = await inspectHostCapabilityRuntime({
    root: process.cwd(),
    request,
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(['datasource_schema_context', 'datasource_query_readonly'])
  })
  const binding = createHostCapabilityHookRuntimeBinding({
    missionId: 'mission', workflowRunId: 'run', sessionScope: 'session', runtime
  })
  const query = sanitizeHostCapabilityPreToolUse(runtime, prePayload('query-1', 'datasource_query_readonly', {
    datasource: 'main', schema_snapshot_id: 'snapshot', query: 'select 1'
  }))!
  const deniedBeforeSchema = authorizeAndMergeHostCapabilityPreToolObservation({ binding, observation: query })
  assert.equal(deniedBeforeSchema.decision, 'denied')
  assert.equal(deniedBeforeSchema.blocker, 'host_capability_readonly_query_schema_not_completed')
  const deniedReplay = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: deniedBeforeSchema.observations, observation: query
  })
  assert.equal(deniedReplay.decision, 'denied')
  assert.equal(deniedReplay.blocker, 'host_tool_reservation_replay_denied')

  const schema = sanitizeHostCapabilityPreToolUse(runtime, prePayload('schema-1', 'datasource_schema_context', {
    datasource: 'main'
  }))!
  const schemaReserved = authorizeAndMergeHostCapabilityPreToolObservation({ binding, observation: schema })
  const deniedWhilePending = authorizeAndMergeHostCapabilityPreToolObservation({
    binding,
    current: schemaReserved.observations,
    observation: { ...query, tool_use_id_sha256: `sha256:${sha256('query-2')}` }
  })
  assert.equal(deniedWhilePending.blocker, 'host_capability_readonly_query_schema_not_completed')

  const schemaPost = sanitizeHostCapabilityPostToolUse(postPayload(
    'schema-1',
    'datasource_schema_context',
    { datasource: 'main' },
    { structured_content: { datasource: 'main', schema_snapshot_id: 'snapshot' } }
  ))!
  const afterSchema = mergeHostCapabilityPostToolObservation({
    binding, current: schemaReserved.observations, observation: schemaPost
  })
  const wrongDatasource = sanitizeHostCapabilityPreToolUse(runtime, prePayload('query-wrong-datasource', 'datasource_query_readonly', {
    datasource: 'other', schema_snapshot_id: 'snapshot', query: 'select 1'
  }))!
  const deniedWrongDatasource = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: afterSchema, observation: wrongDatasource
  })
  assert.equal(deniedWrongDatasource.blocker, 'host_capability_readonly_query_datasource_mismatch')
  const wrongSnapshot = sanitizeHostCapabilityPreToolUse(runtime, prePayload('query-wrong-snapshot', 'datasource_query_readonly', {
    datasource: 'main', schema_snapshot_id: 'other-snapshot', query: 'select 1'
  }))!
  const deniedWrongSnapshot = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: afterSchema, observation: wrongSnapshot
  })
  assert.equal(deniedWrongSnapshot.blocker, 'host_capability_readonly_query_schema_mismatch')
  const queryReserved = authorizeAndMergeHostCapabilityPreToolObservation({
    binding,
    current: afterSchema,
    observation: query
  })
  assert.equal(queryReserved.decision, 'allowed')
  assert.equal(queryReserved.observation.reservation_status, 'pending')

  const repeated = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: queryReserved.observations, observation: query
  })
  assert.deepEqual(repeated.observations, queryReserved.observations)
  assert.deepEqual(repeated.observation, queryReserved.observation)

  const secondQuery = sanitizeHostCapabilityPreToolUse(runtime, prePayload('query-3', 'datasource_query_readonly', {
    datasource: 'main', schema_snapshot_id: 'snapshot', query: 'select 2'
  }))!
  const deniedSecondWhilePending = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: queryReserved.observations, observation: secondQuery
  })
  assert.equal(deniedSecondWhilePending.blocker, 'host_capability_readonly_query_already_reserved')

  const queryPost = sanitizeHostCapabilityPostToolUse(postPayload(
    'query-1',
    'datasource_query_readonly',
    { datasource: 'main', schema_snapshot_id: 'snapshot', query: 'select 1' },
    {
      structured_content: {
        datasource: 'main',
        schema_snapshot_id: 'snapshot',
        query_sha256: `sha256:${sha256('select 1')}`,
        row_count: 1,
        column_count: 1,
        truncated: false,
        status: 'passed'
      }
    }
  ))!
  const afterQuery = mergeHostCapabilityPostToolObservation({
    binding, current: queryReserved.observations, observation: queryPost
  })
  const completedReplay = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: afterQuery, observation: query
  })
  assert.equal(completedReplay.decision, 'denied')
  assert.equal(completedReplay.blocker, 'host_tool_reservation_replay_completed')
  const duplicatePost = mergeHostCapabilityPostToolObservation({
    binding, current: afterQuery, observation: queryPost
  })
  assert.ok(duplicatePost.blockers.includes('host_tool_call_post_replay:datasource_query_readonly'))

  const secondQueryAllowed = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: afterQuery, observation: secondQuery
  })
  assert.equal(secondQueryAllowed.decision, 'allowed')
  assert.equal(secondQueryAllowed.observation.reservation_status, 'pending')
  const secondQueryPost = sanitizeHostCapabilityPostToolUse(postPayload(
    'query-3',
    'datasource_query_readonly',
    { datasource: 'main', schema_snapshot_id: 'snapshot', query: 'select 2' },
    {
      structured_content: {
        datasource: 'main',
        schema_snapshot_id: 'snapshot',
        query_sha256: `sha256:${sha256('select 2')}`,
        row_count: 1,
        column_count: 1,
        truncated: false,
        status: 'passed'
      }
    }
  ))!
  const afterSecondQuery = mergeHostCapabilityPostToolObservation({
    binding, current: secondQueryAllowed.observations, observation: secondQueryPost
  })

  const failedSchema = sanitizeHostCapabilityPreToolUse(runtime, prePayload('schema-failed', 'datasource_schema_context', {
    datasource: 'main'
  }))!
  const failedSchemaReserved = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: afterQuery, observation: failedSchema
  })
  const failedSchemaPost = sanitizeHostCapabilityPostToolUse(postPayload(
    'schema-failed',
    'datasource_schema_context',
    { datasource: 'main' },
    { isError: true, structured_content: { datasource: 'main', schema_snapshot_id: 'snapshot-failed' } }
  ))!
  const afterFailedSchema = mergeHostCapabilityPostToolObservation({
    binding, current: failedSchemaReserved.observations, observation: failedSchemaPost
  })
  const failedReplay = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: afterFailedSchema, observation: failedSchema
  })
  assert.equal(failedReplay.decision, 'denied')
  assert.equal(failedReplay.blocker, 'host_tool_reservation_replay_failed')
  const afterBoundedPreObservationEviction = {
    ...afterQuery,
    pre_tool_uses: afterQuery.pre_tool_uses.filter((row) => row.tool !== 'datasource_query_readonly')
  }
  const allowedAfterEviction = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: afterBoundedPreObservationEviction, observation: secondQuery
  })
  assert.equal(allowedAfterEviction.decision, 'allowed')

  let afterQueries = afterSecondQuery
  for (const index of [3, 4]) {
    const nextQuery = sanitizeHostCapabilityPreToolUse(runtime, prePayload(`query-extra-${index}`, 'datasource_query_readonly', {
      datasource: 'main', schema_snapshot_id: 'snapshot', query: `select ${index}`
    }))!
    const reserved = authorizeAndMergeHostCapabilityPreToolObservation({
      binding, current: afterQueries, observation: nextQuery
    })
    assert.equal(reserved.decision, 'allowed', `query ${index}`)
    const post = sanitizeHostCapabilityPostToolUse(postPayload(
      `query-extra-${index}`,
      'datasource_query_readonly',
      { datasource: 'main', schema_snapshot_id: 'snapshot', query: `select ${index}` },
      {
        structured_content: {
          datasource: 'main',
          schema_snapshot_id: 'snapshot',
          query_sha256: `sha256:${sha256(`select ${index}`)}`,
          row_count: 1,
          column_count: 1,
          truncated: false,
          status: 'passed'
        }
      }
    ))!
    afterQueries = mergeHostCapabilityPostToolObservation({
      binding, current: reserved.observations, observation: post
    })
  }
  const fifthQuery = sanitizeHostCapabilityPreToolUse(runtime, prePayload('query-extra-5', 'datasource_query_readonly', {
    datasource: 'main', schema_snapshot_id: 'snapshot', query: 'select 5'
  }))!
  const deniedFifth = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: afterQueries, observation: fifthQuery
  })
  assert.equal(deniedFifth.blocker, 'host_capability_readonly_query_limit_exceeded')
})

test('atomic spreadsheet create reservations allow one pending ID and deny distinct or terminal replays', async () => {
  const request = requestHostCapabilities('Create and deliver an Excel workbook.')
  const runtime = await inspectHostCapabilityRuntime({
    root: process.cwd(),
    request,
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update'])
  })
  const binding = createHostCapabilityHookRuntimeBinding({
    missionId: 'mission', workflowRunId: 'run', sessionScope: 'session', runtime
  })
  const first = sanitizeHostCapabilityPreToolUse(runtime, prePayload('create-1', 'spreadsheet_create', {
    path: 'reports/book.xlsx'
  }))!
  const second = sanitizeHostCapabilityPreToolUse(runtime, prePayload('create-2', 'spreadsheet_create', {
    path: 'reports/book.xlsx'
  }))!
  const reserved = authorizeAndMergeHostCapabilityPreToolObservation({ binding, observation: first })
  assert.equal(reserved.decision, 'allowed')
  const pendingReplay = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: reserved.observations, observation: first
  })
  assert.equal(pendingReplay.decision, 'allowed')
  assert.deepEqual(pendingReplay.observations, reserved.observations)
  const distinctDenied = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: reserved.observations, observation: second
  })
  assert.equal(distinctDenied.decision, 'denied')
  assert.equal(distinctDenied.blocker, 'host_capability_spreadsheet_create_already_reserved')

  const post = sanitizeHostCapabilityPostToolUse(postPayload(
    'create-1',
    'spreadsheet_create',
    { path: 'reports/book.xlsx' },
    { structured_content: { ok: true, path: 'reports/book.xlsx' } }
  ))!
  const completed = mergeHostCapabilityPostToolObservation({
    binding, current: reserved.observations, observation: post
  })
  const completedReplay = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: completed, observation: first
  })
  assert.equal(completedReplay.decision, 'denied')
  assert.equal(completedReplay.blocker, 'host_tool_reservation_replay_completed')
  const afterCompletionDenied = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: completed, observation: second
  })
  assert.equal(afterCompletionDenied.blocker, 'host_capability_spreadsheet_create_already_reserved')
})

test('atomic spreadsheet update reservations require inspect between up to three mutations', async () => {
  const request = requestHostCapabilities('Update the spreadsheet with the latest results.')
  const runtime = await inspectHostCapabilityRuntime({
    root: process.cwd(),
    request,
    projectTrusted: true,
    dependencies: hostCapabilityDependencies(['spreadsheet_inspect', 'spreadsheet_update'])
  })
  const binding = createHostCapabilityHookRuntimeBinding({
    missionId: 'mission', workflowRunId: 'run', sessionScope: 'session', runtime
  })
  const update = sanitizeHostCapabilityPreToolUse(runtime, prePayload('update-1', 'spreadsheet_update', {
    path: 'reports/book.xlsx'
  }))!
  const deniedBeforeInspect = authorizeAndMergeHostCapabilityPreToolObservation({ binding, observation: update })
  assert.equal(deniedBeforeInspect.blocker, 'host_capability_spreadsheet_update_inspection_not_completed')

  const inspect = sanitizeHostCapabilityPreToolUse(runtime, prePayload('inspect-1', 'spreadsheet_inspect', {
    path: 'reports/book.xlsx'
  }))!
  const inspectReserved = authorizeAndMergeHostCapabilityPreToolObservation({ binding, observation: inspect })
  const inspectPost = sanitizeHostCapabilityPostToolUse(postPayload(
    'inspect-1',
    'spreadsheet_inspect',
    { path: 'reports/book.xlsx' },
    {
      structured_content: {
        ok: true,
        path: 'reports/book.xlsx',
        sheet_names: ['Summary'],
        row_counts: { Summary: 1 },
        formulas: [],
        error_cells: []
      }
    }
  ))!
  const afterInspect = mergeHostCapabilityPostToolObservation({
    binding, current: inspectReserved.observations, observation: inspectPost
  })

  const wrongResource = sanitizeHostCapabilityPreToolUse(runtime, prePayload('update-wrong', 'spreadsheet_update', {
    path: 'reports/other.xlsx'
  }))!
  const deniedWrongResource = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: afterInspect, observation: wrongResource
  })
  assert.equal(deniedWrongResource.blocker, 'host_capability_spreadsheet_update_resource_mismatch')

  const reserved = authorizeAndMergeHostCapabilityPreToolObservation({ binding, current: afterInspect, observation: update })
  assert.equal(reserved.decision, 'allowed')
  const secondUpdate = sanitizeHostCapabilityPreToolUse(runtime, prePayload('update-2', 'spreadsheet_update', {
    path: 'reports/book.xlsx'
  }))!
  const deniedSecond = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: reserved.observations, observation: secondUpdate
  })
  assert.equal(deniedSecond.blocker, 'host_capability_spreadsheet_update_already_reserved')

  const updatePost = sanitizeHostCapabilityPostToolUse(postPayload(
    'update-1', 'spreadsheet_update', { path: 'reports/book.xlsx' }, { structured_content: { ok: true, path: 'reports/book.xlsx' } }
  ))!
  const completed = mergeHostCapabilityPostToolObservation({
    binding, current: reserved.observations, observation: updatePost
  })
  assert.equal(
    completed.pre_tool_uses.find((row) => row.tool_use_id_sha256 === update.tool_use_id_sha256)?.reservation_status,
    'completed'
  )
  const deniedSecondWithoutInspect = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: completed, observation: secondUpdate
  })
  assert.equal(deniedSecondWithoutInspect.blocker, 'host_capability_spreadsheet_update_inspection_not_completed')

  const inspect2 = sanitizeHostCapabilityPreToolUse(runtime, prePayload('inspect-2', 'spreadsheet_inspect', {
    path: 'reports/book.xlsx'
  }))!
  const inspect2Reserved = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: completed, observation: inspect2
  })
  const afterInspect2 = mergeHostCapabilityPostToolObservation({
    binding,
    current: inspect2Reserved.observations,
    observation: sanitizeHostCapabilityPostToolUse(postPayload(
      'inspect-2',
      'spreadsheet_inspect',
      { path: 'reports/book.xlsx' },
      {
        structured_content: {
          ok: true,
          path: 'reports/book.xlsx',
          sheet_names: ['Summary'],
          row_counts: { Summary: 1 },
          formulas: [],
          error_cells: []
        }
      }
    ))!
  })
  const secondAllowed = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: afterInspect2, observation: secondUpdate
  })
  assert.equal(secondAllowed.decision, 'allowed')
  const secondCompleted = mergeHostCapabilityPostToolObservation({
    binding,
    current: secondAllowed.observations,
    observation: sanitizeHostCapabilityPostToolUse(postPayload(
      'update-2',
      'spreadsheet_update',
      { path: 'reports/book.xlsx' },
      { structured_content: { ok: true, path: 'reports/book.xlsx' } }
    ))!
  })
  const inspect3 = sanitizeHostCapabilityPreToolUse(runtime, prePayload('inspect-3', 'spreadsheet_inspect', {
    path: 'reports/book.xlsx'
  }))!
  const inspect3Reserved = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: secondCompleted, observation: inspect3
  })
  const afterInspect3 = mergeHostCapabilityPostToolObservation({
    binding,
    current: inspect3Reserved.observations,
    observation: sanitizeHostCapabilityPostToolUse(postPayload(
      'inspect-3',
      'spreadsheet_inspect',
      { path: 'reports/book.xlsx' },
      {
        structured_content: {
          ok: true,
          path: 'reports/book.xlsx',
          sheet_names: ['Summary'],
          row_counts: { Summary: 1 },
          formulas: [],
          error_cells: []
        }
      }
    ))!
  })
  const thirdUpdate = sanitizeHostCapabilityPreToolUse(runtime, prePayload('update-3', 'spreadsheet_update', {
    path: 'reports/book.xlsx'
  }))!
  const thirdAllowed = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: afterInspect3, observation: thirdUpdate
  })
  assert.equal(thirdAllowed.decision, 'allowed')
  const thirdCompleted = mergeHostCapabilityPostToolObservation({
    binding,
    current: thirdAllowed.observations,
    observation: sanitizeHostCapabilityPostToolUse(postPayload(
      'update-3',
      'spreadsheet_update',
      { path: 'reports/book.xlsx' },
      { structured_content: { ok: true, path: 'reports/book.xlsx' } }
    ))!
  })
  const inspect4 = sanitizeHostCapabilityPreToolUse(runtime, prePayload('inspect-4', 'spreadsheet_inspect', {
    path: 'reports/book.xlsx'
  }))!
  const inspect4Reserved = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: thirdCompleted, observation: inspect4
  })
  const afterInspect4 = mergeHostCapabilityPostToolObservation({
    binding,
    current: inspect4Reserved.observations,
    observation: sanitizeHostCapabilityPostToolUse(postPayload(
      'inspect-4',
      'spreadsheet_inspect',
      { path: 'reports/book.xlsx' },
      {
        structured_content: {
          ok: true,
          path: 'reports/book.xlsx',
          sheet_names: ['Summary'],
          row_counts: { Summary: 1 },
          formulas: [],
          error_cells: []
        }
      }
    ))!
  })
  const fourthUpdate = sanitizeHostCapabilityPreToolUse(runtime, prePayload('update-4', 'spreadsheet_update', {
    path: 'reports/book.xlsx'
  }))!
  const deniedFourth = authorizeAndMergeHostCapabilityPreToolObservation({
    binding, current: afterInspect4, observation: fourthUpdate
  })
  assert.equal(deniedFourth.blocker, 'host_capability_spreadsheet_update_limit_exceeded')
})

test('standalone parent replaces the real child environment and redacts inherited secret values from output', { timeout: 20_000 }, async (t) => {
  if (process.platform === 'win32') return t.skip('executable fixture uses a POSIX shebang')
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-official-subagent-env-isolation-'))
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  const fakeCodex = path.join(root, 'codex-env-fixture.mjs')
  const envReceipt = path.join(root, 'child-env.json')
  const inheritedAuthSecret = 'sk-official-child-auth-secret'
  const blockedSecret = 'blocked-host-secret-value'
  const previousHostSecret = process.env.HOST_INHERITED_SECRET
  process.env.HOST_INHERITED_SECRET = blockedSecret
  t.after(async () => {
    if (previousHostSecret === undefined) delete process.env.HOST_INHERITED_SECRET
    else process.env.HOST_INHERITED_SECRET = previousHostSecret
    await fsp.rm(root, { recursive: true, force: true })
  })
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(fakeCodex, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs'",
    `fs.writeFileSync(${JSON.stringify(envReceipt)}, JSON.stringify(process.env))`,
    "const args = process.argv.slice(2)",
    "const outputIndex = args.indexOf('--output-last-message')",
    "const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : ''",
    `console.log('stdout auth=${inheritedAuthSecret} blocked=${blockedSecret} short=ok')`,
    `console.error('stderr auth=${inheritedAuthSecret} blocked=${blockedSecret} short=ok')`,
    `fs.writeFileSync(outputFile, 'summary auth=${inheritedAuthSecret} blocked=${blockedSecret} short=ok')`
  ].join('\n'), { mode: 0o700 })

  const result = await runOfficialSubagentWorkflow({
    root,
    goal: 'inspect isolated environment',
    prompt: 'inspect isolated environment',
    requestedSubagents: 1,
    maxThreads: 1,
    appSession: false,
    missionId: 'M-real-env-isolation',
    workflowRunId: 'run-real-env-isolation',
    codexBin: fakeCodex,
    runProcessImpl: async (_command, args, options) => runProcess(fakeCodex, args, options),
    env: {
      HOME: home,
      CODEX_HOME: codexHome,
      PATH: process.env.PATH,
      ...standaloneParentHostEnv(root, inheritedAuthSecret)
    }
  })

  const actualChildEnv = JSON.parse(await fsp.readFile(envReceipt, 'utf8'))
  assertStandaloneChildEnvironment({ actual: actualChildEnv, result, home, codexHome, inheritedAuthSecret, blockedSecret })
})

test('production standalone launch rejects arbitrary executable overrides outside the explicit process seam', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-official-subagent-executable-override-'))
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  await fsp.mkdir(codexHome, { recursive: true })
  try {
    const result = await runOfficialSubagentWorkflow({
      root,
      goal: 'must use official package runtime',
      prompt: 'must use official package runtime',
      requestedSubagents: 1,
      maxThreads: 1,
      appSession: false,
      codexBin: path.join(root, 'untrusted-codex'),
      env: {
        HOME: home,
        CODEX_HOME: codexHome,
        PATH: root
      }
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 'trusted_runtime_blocked')
    assert.deepEqual(result.blockers, ['codex_parent_executable_override_forbidden'])
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('Naruto gate cannot pass when the required SSOT guard artifact is missing', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-gate-ssot-'))
  try {
    await writeNarutoGate(dir, {
      missionId: 'M-ssot-missing',
      workflowRunId: 'run-ssot-missing',
      evidence: {
        ok: true,
        run_id: 'run-ssot-missing',
        requested_subagents: 1,
        started_threads: 1,
        completed_threads: 1,
        failed_threads: 0,
        parent_summary_present: true,
        event_sources: ['SubagentStart', 'SubagentStop']
      },
      passed: true,
      blockers: []
    })
    const gate = JSON.parse(await fsp.readFile(path.join(dir, 'naruto-gate.json'), 'utf8'))
    assert.equal(gate.passed, false)
    assert.equal(gate.ssot_guard, false)
    assert.ok(gate.blockers.some((item: string) => item.startsWith('ssot-guard.json:')))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('standalone parent launch exports the owning mission id to child hooks', async () => {
  let childEnv: NodeJS.ProcessEnv | undefined
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-official-subagent-oauth-'))
  try {
    await runOfficialSubagentWorkflow({
      root: process.cwd(),
      goal: 'delegate and wait',
      prompt: 'delegate and wait',
      requestedSubagents: 2,
      maxThreads: 2,
      appSession: false,
      missionId: 'M-parent-owner',
      env: {
        HOME: home,
        CODEX_HOME: path.join(home, '.codex'),
        SKS_PROVIDER: '',
        SKS_USE_CODEX_LB: '',
        SKS_MODEL_PROVIDER: '',
        CODEX_MODEL_PROVIDER: '',
        OPENAI_MODEL_PROVIDER: ''
      },
      runProcessImpl: async (_command, _args, opts: any) => {
        childEnv = opts.env
        assert.equal(opts.envMode, 'replace')
        return { code: 1, stdout: '', stderr: 'fixture stop', stdoutBytes: 0, stderrBytes: 12, truncated: false, timedOut: false }
      }
    })
    assert.equal(childEnv?.SKS_NARUTO_PARENT_LAUNCH, '1')
    assert.equal(childEnv?.SKS_NARUTO_PARENT_MISSION_ID, 'M-parent-owner')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('standalone parent passes a large fan-out frame budget through to the Codex exec args', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-official-subagent-large-fanout-'))
  let launchedArgs: readonly string[] = []
  try {
    const result = await runOfficialSubagentWorkflow({
      root: process.cwd(),
      goal: 'delegate and wait',
      prompt: 'delegate and wait',
      requestedSubagents: 100,
      maxThreads: 128,
      appSession: false,
      env: {
        HOME: home,
        CODEX_HOME: path.join(home, '.codex'),
        SKS_PROVIDER: '',
        SKS_USE_CODEX_LB: '',
        SKS_MODEL_PROVIDER: '',
        CODEX_MODEL_PROVIDER: '',
        OPENAI_MODEL_PROVIDER: ''
      },
      runProcessImpl: async (_command, args) => {
        launchedArgs = args
        return { code: 1, stdout: '', stderr: 'fixture stop', stdoutBytes: 0, stderrBytes: 12, truncated: false, timedOut: false }
      }
    })
    assert.ok(launchedArgs.includes(
      'features.multi_agent_v2={enabled=true,max_concurrent_threads_per_session=129,expose_spawn_agent_model_overrides=true}'
    ))
    assert.ok(launchedArgs.includes('agents.max_concurrent_threads_per_session=128'))
    assert.ok(launchedArgs.includes('agents.max_depth=1'))
    assert.equal(result.max_threads, 128)
    assert.equal(result.requested_subagents, 100)
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('official subagent preparation admits an eight-child request after normalizing over-cap project preferences', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-official-config-hard-cap-'))
  t.after(async () => fsp.rm(root, { recursive: true, force: true }))
  const codexHome = path.join(root, 'home', '.codex')
  const missionDir = path.join(root, '.sneakoscope', 'missions', 'M-over-cap-config')
  await fsp.mkdir(path.join(root, '.codex'), { recursive: true })
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.mkdir(missionDir, { recursive: true })
  const projectConfigPath = path.join(root, '.codex', 'config.toml')

  const beyondHardCap = 1000
  const source = [
    '[agents]',
    `max_concurrent_threads_per_session = ${beyondHardCap}`,
    '',
    '[features.multi_agent_v2]',
    `max_concurrent_threads_per_session = ${beyondHardCap}`,
    ''
  ].join('\n')
  await fsp.writeFile(projectConfigPath, source)
  const coerced = await readOfficialSubagentConfig(root, { codexHome })
  assert.equal(coerced.maxThreads, HARD_NARUTO_MAX_THREADS)
  assert.equal(coerced.sources.maxThreads, 'project')
  assert.deepEqual(coerced.blockers, [])
  assert.deepEqual(coerced.warnings, [
    `official_subagent_max_threads_normalized:configured=${beyondHardCap}:effective=${HARD_NARUTO_MAX_THREADS}:source=project`,
    `official_subagent_multi_agent_v2_max_threads_normalized:configured=${beyondHardCap}:effective=${HARD_NARUTO_MAX_THREADS + 1}:source=project`
  ])
  assert.equal(coerced.multiAgentV2.maxConcurrentThreadsPerSession, HARD_NARUTO_MAX_THREADS + 1)
  assert.equal(await fsp.readFile(projectConfigPath, 'utf8'), source)

  const prepared = await prepareOfficialSubagentMission({
    root,
    dir: missionDir,
    missionId: 'M-over-cap-config',
    goal: 'implement eight independent bounded slices',
    route: '$Naruto',
    requestedSubagents: 8,
    requestedSubagentsExplicit: true,
    mode: 'naruto',
    preparationOnly: true,
    capacity: { activeThreadCount: 0 }
  })
  assert.equal(prepared.budget.maxThreads, HARD_NARUTO_MAX_THREADS)
  assert.equal(prepared.budget.requestedSubagents, 8)
  assert.equal(prepared.budget.firstWave, 8)
  assert.equal(prepared.budget.capacity.reservations.active_threads, 0)
  assert.equal(prepared.plan.config_source, 'project')
  assert.equal(prepared.plan.config_blockers.some((blocker: string) => (
    blocker.includes('official_subagent_max_threads')
    || blocker.includes('official_subagent_multi_agent_v2_max_threads')
  )), false)
  assert.equal(await fsp.readFile(projectConfigPath, 'utf8'), source)
})

test('standalone parent registers the child PID before waiting and exposes a bounded registration blocker', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-official-subagent-spawn-registration-'))
  let registeredPid: number | null = null
  try {
    const result = await runOfficialSubagentWorkflow({
      root: process.cwd(),
      goal: 'delegate and wait',
      prompt: 'delegate and wait',
      requestedSubagents: 1,
      maxThreads: 1,
      appSession: false,
      env: {
        HOME: home,
        CODEX_HOME: path.join(home, '.codex'),
        SKS_PROVIDER: '',
        SKS_USE_CODEX_LB: '',
        SKS_MODEL_PROVIDER: '',
        CODEX_MODEL_PROVIDER: '',
        OPENAI_MODEL_PROVIDER: ''
      },
      onChildSpawn: async (pid) => {
        registeredPid = pid
      },
      runProcessImpl: async (_command, _args, opts: any) => {
        await opts.onSpawn?.(43210)
        return {
          code: -1,
          pid: 43210,
          stdout: '',
          stderr: '',
          stdoutBytes: 0,
          stderrBytes: 0,
          truncated: false,
          timedOut: false,
          spawnRegistrationFailed: true
        }
      }
    })
    assert.equal(registeredPid, 43210)
    assert.deepEqual(result.blockers, ['codex_parent_spawn_registration_failed'])
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('standalone parent converts timeout and non-zero exits into bounded blocker codes', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-official-subagent-bounded-failure-'))
  try {
    const cases = [
      {
        process: {
          code: null,
          stdout: '',
          stderr: 'raw timeout detail must not become a blocker',
          stdoutBytes: 0,
          stderrBytes: 44,
          truncated: false,
          timedOut: true
        },
        blocker: 'codex_parent_timeout'
      },
      {
        process: {
          code: 70,
          stdout: '',
          stderr: 'raw MCP protocol failure detail must not become a blocker',
          stdoutBytes: 0,
          stderrBytes: 55,
          truncated: false,
          timedOut: false
        },
        blocker: 'codex_parent_exit:70'
      }
    ]
    for (const fixture of cases) {
      const result = await runOfficialSubagentWorkflow({
        root: process.cwd(),
        goal: 'delegate and wait',
        prompt: 'delegate and wait',
        requestedSubagents: 1,
        maxThreads: 1,
        appSession: false,
        env: {
          HOME: home,
          CODEX_HOME: path.join(home, '.codex'),
          SKS_PROVIDER: '',
          SKS_USE_CODEX_LB: '',
          SKS_MODEL_PROVIDER: '',
          CODEX_MODEL_PROVIDER: '',
          OPENAI_MODEL_PROVIDER: ''
        },
        runProcessImpl: async () => fixture.process
      })
      assert.deepEqual(result.blockers, [fixture.blocker])
      assert.equal(JSON.stringify(result.blockers).includes('raw MCP'), false)
      assert.equal(JSON.stringify(result.blockers).includes('raw timeout'), false)
    }
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('standalone parent appends the bounded OAuth callback recovery hint only for an auth failure with a port conflict', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-official-subagent-oauth-conflict-'))
  let diagnosticCalls = 0
  try {
    const result = await runOfficialSubagentWorkflow({
      root: process.cwd(),
      goal: 'delegate and wait',
      prompt: 'delegate and wait',
      requestedSubagents: 1,
      maxThreads: 1,
      appSession: false,
      env: {
        HOME: home,
        CODEX_HOME: path.join(home, '.codex')
      },
      runProcessImpl: async () => ({
        code: 1,
        stdout: '',
        stderr: 'Not logged in. Run codex login.',
        stdoutBytes: 0,
        stderrBytes: 31,
        truncated: false,
        timedOut: false
      }),
      oauthCallbackDiagnosticRunner: async () => {
        diagnosticCalls += 1
        const stdout = [
          'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
          'codex 410 user 17u IPv4 0x1 0t0 TCP 127.0.0.1:1455 (LISTEN)',
          'com.docker 922 user 18u IPv6 0x2 0t0 TCP :::1455 (LISTEN)'
        ].join('\n')
        return {
          code: 0,
          stdout,
          stderr: 'internal command line --api-key=sk-sensitive-fixture',
          stdoutBytes: Buffer.byteLength(stdout),
          stderrBytes: 53,
          truncated: false,
          timedOut: false
        }
      }
    })

    assert.equal(diagnosticCalls, 1)
    assert.deepEqual(result.operator_actions, [OAUTH_CALLBACK_RECOVERY_GUIDANCE])
    assert.equal(result.oauth_callback_port_diagnostic.conflict, true)
    assert.doesNotMatch(JSON.stringify(result.oauth_callback_port_diagnostic), /api-key|sk-sensitive-fixture/)
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('trusted host pending runtime is removed after child failure or launch exception', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-official-subagent-pending-cleanup-'))
  t.after(async () => fsp.rm(root, { recursive: true, force: true }))
  const cases = [
    {
      label: 'nonzero',
      execute: async () => ({
        code: 70,
        stdout: '',
        stderr: 'fixture failure',
        stdoutBytes: 0,
        stderrBytes: 15,
        truncated: false,
        timedOut: false
      })
    },
    {
      label: 'throw',
      execute: async () => {
        throw new Error('fixture launch exception')
      }
    }
  ]
  for (const fixture of cases) {
    const missionId = `M-pending-cleanup-${fixture.label}`
    const pendingPath = path.join(
      missionDir(root, missionId),
      HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME
    )
    const result = await runOfficialSubagentWorkflow({
      root,
      goal: 'Create and deliver an Excel workbook.',
      prompt: `pending cleanup ${fixture.label}`,
      requestedSubagents: 1,
      maxThreads: 1,
      appSession: false,
      projectTrusted: true,
      missionId,
      workflowRunId: `run-pending-cleanup-${fixture.label}`,
      hostCapabilityDependencies: hostCapabilityDependencies([
        'spreadsheet_create',
        'spreadsheet_inspect',
        'spreadsheet_update'
      ]),
      runProcessImpl: async () => {
        await fsp.access(pendingPath)
        return fixture.execute()
      }
    })
    assert.equal(result.status, 'parent_failed', fixture.label)
    await assert.rejects(fsp.access(pendingPath), fixture.label)
  }
})

test('standalone official subagent launch honors selected codex-lb and injects the canonical key', async () => {
  const baseUrl = 'https://lb.official-subagent.example.test/backend-api/codex'
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-official-subagent-codex-lb-'))
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "codex-lb"',
    '',
    '[model_providers.codex-lb]',
    `base_url = "${baseUrl}"`,
    ''
  ].join('\n'))
  const env = {
    HOME: home,
    CODEX_HOME: codexHome,
    CODEX_LB_BASE_URL: 'https://stale.example.test/backend-api/codex',
    CODEX_LB_API_KEY: 'stale-synthetic-key'
  }
  let launches = 0
  let launchedArgs: string[] = []
  let launchedKey = ''
  const runProcessImpl = async (_command: string, args: readonly string[], options: any) => {
    launches += 1
    launchedArgs = [...args]
    launchedKey = String(options.env?.CODEX_LB_API_KEY || '')
    return { code: 1, stdout: '', stderr: 'fixture stop', stdoutBytes: 0, stderrBytes: 12, truncated: false, timedOut: false }
  }
  try {
    const result = await runOfficialSubagentWorkflow({
      root,
      goal: 'delegate and wait',
      prompt: 'delegate and wait',
      requestedSubagents: 2,
      maxThreads: 2,
      appSession: false,
      env,
      prepareCodexRuntimeEnvImpl: async (input = {}) => ({
        ...(input.env || {}),
        CODEX_LB_BASE_URL: baseUrl,
        CODEX_LB_API_KEY: 'validated-synthetic-key'
      }),
      recoveryFetch: async () => new Response('{}', {
        status: 200,
        headers: { 'x-app-version': '1.21.0-beta.3' }
      }),
      runProcessImpl
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 'parent_failed')
    assert.equal(result.tool_output_recovery.status, 'compatible')
    assert.equal(launches, 1)
    assert.ok(launchedArgs.includes('model_provider="codex-lb"'))
    assert.equal(launchedArgs.includes('forced_login_method="chatgpt"'), false)
    assert.equal(launchedKey, 'validated-synthetic-key')
    assert.doesNotMatch(JSON.stringify(result), /validated-synthetic-key|stale-synthetic-key/)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('standalone Naruto parent consumes the existing project MCP config and calls its read-only stdio tool', { timeout: 20_000 }, async (t) => {
  if (process.platform === 'win32') return t.skip('executable fixture uses a POSIX shebang')
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-official-subagent-project-mcp-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const codexHome = path.join(home, '.codex')
  const serverFile = path.join(project, 'project-read-tool.mjs')
  const fakeCodex = path.join(root, 'codex-fixture.mjs')
  const callReceipt = path.join(project, 'project-mcp-call.json')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.mkdir(path.join(project, '.codex'), { recursive: true })
  t.after(async () => fsp.rm(root, { recursive: true, force: true }))

  await fsp.writeFile(serverFile, [
    "import readline from 'node:readline'",
    "const tools = ['read_project_marker', 'datasource_schema_context', 'datasource_query_readonly', 'spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update'].map((name) => ({ name, description: `Fixture tool ${name}`, inputSchema: { type: 'object', additionalProperties: false } }))",
    "const rl = readline.createInterface({ input: process.stdin })",
    "rl.on('line', (line) => {",
    "  const message = JSON.parse(line)",
    "  if (message.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } }))",
    "  if (message.method === 'tools/list') console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } }))",
    "  if (message.method === 'tools/call') console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'project-mcp-ok' }], isError: false } }))",
    "})"
  ].join('\n'), { mode: 0o600 })

  await fsp.writeFile(fakeCodex, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    "import readline from 'node:readline'",
    "import { spawn } from 'node:child_process'",
    "const args = process.argv.slice(2)",
    "const outputIndex = args.indexOf('--output-last-message')",
    "const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : ''",
    "const configFile = path.join(process.cwd(), '.codex', 'config.toml')",
    "const config = fs.readFileSync(configFile, 'utf8')",
    "const match = config.match(/\\[mcp_servers\\.(?:project_probe|\"project_probe\")\\]([\\s\\S]*?)(?=\\n\\[|$)/)",
    "if (!match) throw new Error('project_mcp_block_missing')",
    "const block = match[1]",
    "const commandLine = block.split(/\\r?\\n/).find((line) => /^command\\s*=/.test(line))",
    "const argsLine = block.split(/\\r?\\n/).find((line) => /^args\\s*=/.test(line))",
    "const command = JSON.parse(String(commandLine || '').replace(/^command\\s*=\\s*/, ''))",
    "const childArgs = argsLine ? JSON.parse(argsLine.replace(/^args\\s*=\\s*/, '')) : []",
    "const child = spawn(command, childArgs, { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })",
    "const lines = readline.createInterface({ input: child.stdout })",
    "const pending = new Map()",
    "lines.on('line', (line) => { const message = JSON.parse(line); const resolve = pending.get(message.id); if (resolve) { pending.delete(message.id); resolve(message) } })",
    "const request = (id, method, params = {}) => new Promise((resolve, reject) => { pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n'); setTimeout(() => reject(new Error('fixture_mcp_timeout')), 3000).unref() })",
    "await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })",
    "child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\\n')",
    "const listed = await request(2, 'tools/list')",
    "if (!listed.result.tools.some((tool) => tool.name === 'read_project_marker')) throw new Error('project_mcp_tool_missing')",
    "for (const name of ['datasource_schema_context', 'datasource_query_readonly', 'spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update']) if (!listed.result.tools.some((tool) => tool.name === name)) throw new Error(`project_mcp_capability_tool_missing:${name}`)",
    "const called = await request(3, 'tools/call', { name: 'read_project_marker', arguments: {} })",
    "const text = called.result.content?.[0]?.text",
    "fs.writeFileSync(path.join(process.cwd(), 'project-mcp-call.json'), JSON.stringify({ tool: 'read_project_marker', text }))",
    "if (text !== 'project-mcp-ok') throw new Error('project_mcp_tool_result_invalid')",
    "child.stdin.end()",
    "child.kill('SIGTERM')",
    "if (!outputFile) throw new Error('parent_summary_output_missing')",
    "fs.writeFileSync(outputFile, 'project MCP fixture complete')"
  ].join('\n'), { mode: 0o700 })

  const cli = new UnavailableMcpCli()
  const previousAllowed = process.env.PROJECT_MCP_ALLOWED
  process.env.PROJECT_MCP_ALLOWED = 'runtime-value-must-not-be-written'
  t.after(() => {
    if (previousAllowed === undefined) delete process.env.PROJECT_MCP_ALLOWED
    else process.env.PROJECT_MCP_ALLOWED = previousAllowed
  })
  const registration = {
    schema: 'sks.mcp-server-config.v2',
    name: 'project_probe',
    transport: 'stdio',
    command: process.execPath,
    args: [serverFile],
    env_vars: ['PROJECT_MCP_ALLOWED'],
    cwd: project,
    enabled_tools: [
      'read_project_marker',
      'datasource_schema_context',
      'datasource_query_readonly',
      'spreadsheet_create',
      'spreadsheet_inspect',
      'spreadsheet_update'
    ],
    default_tools_approval_mode: 'auto',
    required: true
  }
  const added = await addMcpServer(registration, 'project', {
    projectRoot: project,
    projectTrusted: true,
    confirmProjectMutation: true,
    cli
  })
  assert.equal(added.ok, true)
  const reapplied = await editMcpServer('project_probe', registration, 'project', {
    projectRoot: project,
    projectTrusted: true,
    confirmProjectMutation: true,
    cli
  })
  assert.equal(reapplied.ok, true)
  const config = await fsp.readFile(path.join(project, '.codex', 'config.toml'), 'utf8')
  assert.equal((config.match(/\[mcp_servers\."project_probe"\]/g) || []).length, 1)
  assert.match(config, /env_vars = \["PROJECT_MCP_ALLOWED"\]/)
  assert.doesNotMatch(config, /runtime-value-must-not-be-written/)

  const result = await runOfficialSubagentWorkflow({
    root: project,
    goal: 'Use the registered read-only project tool and report its marker.',
    prompt: 'Use the registered read-only project tool and report its marker.',
    requestedSubagents: 1,
    maxThreads: 1,
    appSession: false,
    missionId: 'M-project-mcp-fixture',
    codexBin: fakeCodex,
    runProcessImpl: async (_command, args, options) => runProcess(fakeCodex, args, options),
    env: {
      HOME: home,
      CODEX_HOME: codexHome,
      SKS_PROVIDER: '',
      SKS_USE_CODEX_LB: '',
      SKS_MODEL_PROVIDER: '',
      CODEX_MODEL_PROVIDER: '',
      OPENAI_MODEL_PROVIDER: ''
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'parent_completed')
  assert.equal(result.parent_summary, 'project MCP fixture complete')
  assert.deepEqual(JSON.parse(await fsp.readFile(callReceipt, 'utf8')), {
    tool: 'read_project_marker',
    text: 'project-mcp-ok'
  })
})
