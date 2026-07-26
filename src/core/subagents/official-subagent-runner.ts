import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomId, runProcess, writeJsonAtomic, type RunProcessResult } from '../fsx.js'
import {
  DEFAULT_SUBAGENT_EFFORT,
  DEFAULT_SUBAGENT_MODEL,
  NARUTO_PARENT_EFFORT,
  NARUTO_PARENT_MODEL
} from './model-policy.js'
import { inspectCodexLbCliLaunchRecovery } from '../codex-control/codex-lb-launch-recovery.js'
import { probeNarutoCodexCapability } from '../codex-compat/codex-capability-matrix.js'
import { resolveOfficialCodexPackageRuntime } from '../codex-runtime/resolve-codex-runtime.js'
import { withFileLock } from '../locks/file-lock.js'
import {
  HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME,
  HOST_CAPABILITY_MCP_SERVER,
  createHostCapabilityHookPendingRuntime,
  createHostCapabilityEventCollector,
  hostCapabilityCodexConfigArgs,
  inspectHostCapabilityRuntime,
  requestHostCapabilities,
  type HostCapabilityExecutionEvidence,
  type HostCapabilityRuntimeDependencies
} from '../agent-bridge/host-capability-runtime.js'
import { uniqueStringsSorted as uniqueStrings } from '../text/strings.js'
import {
  narutoCredentialConfigArgs,
  resolveNarutoCredentialPolicy,
  type NarutoCredentialPolicy
} from './naruto-host-credentials.js'

export const OFFICIAL_SUBAGENT_WORKFLOW_SCHEMA = 'sks.subagent-workflow.v1'

function officialSubagentMissionDir(root: string, missionId: string): string {
  return path.join(root, '.sneakoscope', 'missions', missionId)
}

const OFFICIAL_SUBAGENT_CHILD_ENV_ALLOWLIST = Object.freeze([
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CODEX_HOME',
  'CODEX_CI',
  'CODEX_MANAGED_BY_NPM',
  'CODEX_INTERNAL_ORIGINATOR',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'SKS_AGENT_MODE',
  'SKS_NARUTO_PARENT_EDGE_ID',
  'SKS_NARUTO_PARENT_LEASE_OWNER',
  'SKS_NARUTO_PARENT_LEASE_GENERATION',
  'SKS_NARUTO_PARENT_MISSION_GENERATION',
  'ACAS_CUSTOMER_ID',
  'ACAS_AGENT_SLUG',
  'ACAS_AGENT_WORKSPACE',
  'ALFREDO_AGENT_SOULS_FILE',
  'ACAS_CHROME_PATH',
  'ACAS_HTML_TO_PDF_ENGINE',
  'ACAS_HTML_TO_PDF_ALLOW_CHROME_CLI_FALLBACK'
] as const)

const SECRET_ENV_KEY_RE = /(?:api[_-]?key|token|secret|password|credential|authorization|cookie)/i
const SECRET_BEARING_ENV_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy'
])

export interface OfficialSubagentWorkflowInput {
  root: string
  goal: string
  prompt: string
  requestedSubagents: number
  maxThreads: number
  appSession: boolean
  projectTrusted?: boolean
  missionId?: string | null
  workflowRunId?: string | null
  sessionKey?: string | null
  codexBin?: string | null
  timeoutMs?: number | null
  env?: NodeJS.ProcessEnv
  runProcessImpl?: typeof runProcess
  onChildSpawn?: (pid: number) => void | Promise<void>
  hostCapabilityDependencies?: HostCapabilityRuntimeDependencies
  /** Host credential/model delegation; omitted means SKS-managed ChatGPT auth. */
  credentialPolicy?: NarutoCredentialPolicy
}

export function detectCodexAppSession(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SKS_NARUTO_STANDALONE_CLI === '1') return false
  if (env.SKS_NARUTO_APP_SESSION === '1') return true
  return Boolean(env.CODEX_THREAD_ID)
}

export function codexAppSessionKey(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!detectCodexAppSession(env)) return null
  const threadId = String(env.CODEX_THREAD_ID || '').trim()
  return threadId || null
}

/**
 * Default policy: SKS owns the credential and pins the ChatGPT login.
 *
 * A caller that already holds an OpenAI-compatible credential passes a resolved
 * policy instead — see `naruto-host-credentials.ts`. In that case SKS injects
 * neither `model_provider` nor `forced_login_method`, so Codex authenticates
 * with the provider block the host configured.
 */
export function defaultNarutoCredentialPolicy(): NarutoCredentialPolicy {
  return resolveNarutoCredentialPolicy({
    args: [],
    env: {},
    defaultParentModel: NARUTO_PARENT_MODEL,
    defaultParentEffort: NARUTO_PARENT_EFFORT,
    defaultSubagentModel: DEFAULT_SUBAGENT_MODEL,
    defaultSubagentEffort: DEFAULT_SUBAGENT_EFFORT
  })
}

export function buildOfficialSubagentCodexArgs(input: {
  prompt: string
  maxThreads: number
  parentSummaryFile: string
  workingDirectory?: string
  projectConfigArgs?: readonly string[]
  hostCapabilityConfigArgs?: readonly string[]
  credentialPolicy?: NarutoCredentialPolicy
}): string[] {
  const maxThreads = Math.max(1, Math.floor(input.maxThreads))
  const maV2Total = maxThreads + 1
  const policy = input.credentialPolicy ?? defaultNarutoCredentialPolicy()
  return [
    'exec',
    '--json',
    ...(input.workingDirectory ? ['-C', input.workingDirectory] : []),
    '-m', policy.parentModel,
    '-c', `model_reasoning_effort="${policy.parentEffort}"`,
    ...narutoCredentialConfigArgs(policy),
    // Codex 0.145+ stable opt-in multi-agent V2 (authoritative over V1 collab).
    '-c', `features.multi_agent_v2={enabled=true,max_concurrent_threads_per_session=${maV2Total},expose_spawn_agent_model_overrides=true}`,
    '-c', 'agents.enabled=true',
    '-c', `agents.max_concurrent_threads_per_session=${maxThreads}`,
    '-c', 'agents.max_depth=1',
    '-c', `agents.default_subagent_model="${policy.subagentModel}"`,
    '-c', `agents.default_subagent_reasoning_effort="${policy.subagentEffort}"`,
    '-c', 'agents.interrupt_message=true',
    ...(input.projectConfigArgs || []),
    ...(input.hostCapabilityConfigArgs || []),
    '--output-last-message', input.parentSummaryFile,
    input.prompt
  ]
}

export function buildOfficialSubagentChildEnv(input: {
  env?: NodeJS.ProcessEnv
  missionId?: string | null
  workflowRunId?: string | null
  hostCapabilityLaunchNonce?: string | null
  credentialPolicy?: NarutoCredentialPolicy
} = {}): NodeJS.ProcessEnv {
  const source = { ...process.env, ...(input.env || {}) }
  const childEnv: NodeJS.ProcessEnv = {}
  for (const key of OFFICIAL_SUBAGENT_CHILD_ENV_ALLOWLIST) {
    if (source[key] !== undefined) childEnv[key] = source[key]
  }
  // Host auth mode: Codex resolves the provider block's `env_key` from its own
  // environment, so the named variable has to survive the allowlist. Only the
  // one variable the policy names is forwarded, and its value is redacted from
  // every log line by the same secret scrubber that covers the rest of the env.
  const providerEnvKey = input.credentialPolicy?.providerEnvKey
  if (providerEnvKey && source[providerEnvKey] !== undefined) {
    childEnv[providerEnvKey] = source[providerEnvKey]
  }
  childEnv.SKS_NARUTO_STANDALONE_CLI = '0'
  childEnv.SKS_NARUTO_PARENT_LAUNCH = '1'
  if (input.missionId) childEnv.SKS_NARUTO_PARENT_MISSION_ID = input.missionId
  if (input.workflowRunId) childEnv.SKS_NARUTO_PARENT_WORKFLOW_RUN_ID = input.workflowRunId
  if (input.hostCapabilityLaunchNonce) {
    childEnv.SKS_NARUTO_PARENT_HOST_CAPABILITY_NONCE = input.hostCapabilityLaunchNonce
  }
  return childEnv
}

export function hostCapabilityProjectCodexConfigArgs(input: {
  canonicalRoot: string
  projectTrusted: boolean
  globalHostCapabilityConfigured?: boolean
}): string[] {
  const trustLevel = input.projectTrusted ? 'trusted' : 'untrusted'
  return [
    '-c', `projects={${JSON.stringify(input.canonicalRoot)}={trust_level="${trustLevel}"}}`,
    ...(!input.projectTrusted && input.globalHostCapabilityConfigured
      ? ['-c', `mcp_servers.${HOST_CAPABILITY_MCP_SERVER}.enabled=false`]
      : [])
  ]
}

async function inspectConfiguredGlobalHostCapabilityServer(input: {
  codexCommand: string
  canonicalRoot: string
  env: NodeJS.ProcessEnv
}): Promise<{ ok: boolean; present: boolean }> {
  const result = await runProcess(input.codexCommand, [
    '-C', input.canonicalRoot,
    ...hostCapabilityProjectCodexConfigArgs({
      canonicalRoot: input.canonicalRoot,
      projectTrusted: false
    }),
    'mcp', 'list', '--json'
  ], {
    cwd: input.canonicalRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
    env: input.env,
    envMode: 'replace'
  }).catch(() => null)
  if (!result || result.code !== 0 || result.timedOut || result.truncated) {
    return { ok: false, present: false }
  }
  try {
    const rows = JSON.parse(result.stdout)
    if (!Array.isArray(rows)) return { ok: false, present: false }
    return {
      ok: true,
      present: rows.some((row) => row && typeof row === 'object' && row.name === HOST_CAPABILITY_MCP_SERVER)
    }
  } catch {
    return { ok: false, present: false }
  }
}

async function writeHostCapabilityPendingRuntime(input: {
  dir: string
  missionId: string
  workflowRunId: string
  launchNonce: string
  runtime: Parameters<typeof createHostCapabilityHookPendingRuntime>[0]['runtime']
}): Promise<boolean> {
  try {
    await withFileLock({
      lockPath: path.join(input.dir, '.host-capability-hooks.lock'),
      timeoutMs: 5_000,
      staleMs: 60_000
    }, async () => {
      await fsp.rm(path.join(input.dir, HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME), { force: true })
      await writeJsonAtomic(
        path.join(input.dir, HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME),
        createHostCapabilityHookPendingRuntime({
          missionId: input.missionId,
          workflowRunId: input.workflowRunId,
          launchNonce: input.launchNonce,
          runtime: input.runtime
        })
      )
    })
    return true
  } catch {
    return false
  }
}

async function removeHostCapabilityPendingRuntime(dir: string | null): Promise<void> {
  if (!dir) return
  await withFileLock({
    lockPath: path.join(dir, '.host-capability-hooks.lock'),
    timeoutMs: 5_000,
    staleMs: 60_000
  }, () => fsp.rm(path.join(dir, HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME), { force: true }))
    .catch(() => undefined)
}

function knownInheritedSecretValues(env: NodeJS.ProcessEnv | undefined): string[] {
  const source = { ...process.env, ...(env || {}) }
  return [...new Set(Object.entries(source)
    .filter(([key, value]) => String(value || '').length >= 8 && (SECRET_ENV_KEY_RE.test(key) || SECRET_BEARING_ENV_KEYS.has(key)))
    .map(([, value]) => String(value)))]
    .sort((a, b) => b.length - a.length)
}

function redactKnownValues(text: string, values: readonly string[]): string {
  let redacted = text
  for (const value of values) redacted = redacted.split(value).join('<redacted>')
  return redacted
}

function structuredValueContainsKnownValue(value: unknown, values: readonly string[]): boolean {
  if (typeof value === 'string') return values.some((secret) => value.includes(secret))
  if (Array.isArray(value)) return value.some((item) => structuredValueContainsKnownValue(item, values))
  if (!value || typeof value !== 'object') return false
  return Object.values(value).some((item) => structuredValueContainsKnownValue(item, values))
}

function confineHostCapabilityEvidenceSecrets(
  evidence: HostCapabilityExecutionEvidence,
  secretValues: readonly string[]
): HostCapabilityExecutionEvidence {
  if (!structuredValueContainsKnownValue(evidence, secretValues)) return evidence
  const confined = createHostCapabilityEventCollector(evidence.runtime).finish()
  return {
    ...confined,
    ok: false,
    blockers: uniqueStrings([
      ...confined.blockers,
      'host_capability_evidence_secret_reflection'
    ])
  }
}

export async function runOfficialSubagentWorkflow(input: OfficialSubagentWorkflowInput): Promise<any> {
  const hostCapabilityRequest = requestHostCapabilities(input.goal)
  const base = {
    schema: OFFICIAL_SUBAGENT_WORKFLOW_SCHEMA,
    workflow: 'official_codex_subagent',
    requested_subagents: input.requestedSubagents,
    max_threads: input.maxThreads,
    max_depth: 1,
    parent_model: NARUTO_PARENT_MODEL,
    parent_reasoning_effort: NARUTO_PARENT_EFFORT,
    session_scope: input.sessionKey || null,
    host_capability_request: hostCapabilityRequest
  }

  const hostCapabilityRuntime = await inspectHostCapabilityRuntime({
    root: input.root,
    request: hostCapabilityRequest,
    projectTrusted: input.projectTrusted === true,
    ...(input.hostCapabilityDependencies ? { dependencies: input.hostCapabilityDependencies } : {})
  })

  if (input.appSession) {
    if (hostCapabilityRequest.capability_ids.length > 0 && !input.sessionKey) {
      return {
        ...base,
        ok: false,
        status: 'host_capability_blocked',
        prepared: false,
        additionalContext: null,
        host_capability_runtime: hostCapabilityRuntime,
        blockers: ['host_capability_session_scope_missing'],
        completion_evidence: false,
        note: 'Requested host capabilities cannot be safely bound without the current Codex session identity.'
      }
    }
    if (!hostCapabilityRuntime.ok) {
      return {
        ...base,
        ok: false,
        status: 'host_capability_blocked',
        prepared: false,
        additionalContext: null,
        host_capability_runtime: hostCapabilityRuntime,
        blockers: hostCapabilityRuntime.blockers,
        completion_evidence: false,
        note: 'Requested project-scoped host capabilities are missing or unhealthy. No runnable delegation context was returned.'
      }
    }
    return {
      ...base,
      ok: false,
      status: 'delegation_context_ready',
      prepared: true,
      additionalContext: input.prompt,
      host_capability_runtime: hostCapabilityRuntime,
      completion_evidence: false,
      note: 'The current Codex parent must spawn and await the official subagents. Preparation is not completion evidence.'
    }
  }

  const inheritedSecretValues = knownInheritedSecretValues(input.env)
  const parentSummaryFile = path.join(os.tmpdir(), `sks-naruto-parent-summary-${process.pid}-${Date.now()}.txt`)
  const hostCapabilityCollector = createHostCapabilityEventCollector(hostCapabilityRuntime)
  if (!hostCapabilityRuntime.ok) {
    const hostCapabilityEvidence = hostCapabilityCollector.finish()
    return {
      ...base,
      ok: false,
      status: 'host_capability_blocked',
      prepared: false,
      codex_exit_code: null,
      parent_summary: null,
      parent_summary_file: null,
      host_capability_runtime: hostCapabilityRuntime,
      host_capability_evidence: hostCapabilityEvidence,
      blockers: hostCapabilityEvidence.blockers,
      completion_evidence: false
    }
  }
  const canonicalRoot = await fsp.realpath(input.root).catch(() => null)
  if (!canonicalRoot) {
    return {
      ...base,
      ok: false,
      status: 'trusted_runtime_blocked',
      prepared: false,
      codex_exit_code: null,
      parent_summary: null,
      parent_summary_file: null,
      host_capability_runtime: hostCapabilityRuntime,
      host_capability_evidence: hostCapabilityCollector.finish(),
      blockers: ['host_capability_project_root_realpath_failed'],
      completion_evidence: false
    }
  }
  let hostCapabilityLaunchNonce: string | null = null
  let hostCapabilityPendingDir: string | null = null
  if (hostCapabilityRequest.capability_ids.length > 0) {
    if (!input.missionId || !input.workflowRunId) {
      return {
        ...base,
        ok: false,
        status: 'host_capability_blocked',
        prepared: false,
        codex_exit_code: null,
        parent_summary: null,
        parent_summary_file: null,
        host_capability_runtime: hostCapabilityRuntime,
        host_capability_evidence: hostCapabilityCollector.finish(),
        blockers: ['host_capability_parent_binding_identity_missing'],
        completion_evidence: false
      }
    }
    hostCapabilityLaunchNonce = randomId(32)
    hostCapabilityPendingDir = officialSubagentMissionDir(canonicalRoot, input.missionId)
  }
  const credentialPolicy = input.credentialPolicy ?? defaultNarutoCredentialPolicy()
  const childEnv = buildOfficialSubagentChildEnv({
    ...(input.env ? { env: input.env } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {}),
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(hostCapabilityLaunchNonce ? { hostCapabilityLaunchNonce } : {}),
    credentialPolicy
  })
  const outputSecretValues = hostCapabilityLaunchNonce
    ? [...inheritedSecretValues, hostCapabilityLaunchNonce]
    : inheritedSecretValues

  let codexCommand: string
  let codexVersion: string | null = null
  if (input.runProcessImpl) {
    codexCommand = input.codexBin || 'codex'
  } else {
    if (input.codexBin) {
      return {
        ...base,
        ok: false,
        status: 'trusted_runtime_blocked',
        prepared: false,
        codex_exit_code: null,
        parent_summary: null,
        parent_summary_file: null,
        host_capability_runtime: hostCapabilityRuntime,
        host_capability_evidence: hostCapabilityCollector.finish(),
        blockers: ['codex_parent_executable_override_forbidden'],
        completion_evidence: false
      }
    }
    const runtime = await resolveOfficialCodexPackageRuntime({ requestedBy: 'official-subagent-runner' })
    if (!runtime.ok || !runtime.identity) {
      return {
        ...base,
        ok: false,
        status: 'trusted_runtime_blocked',
        prepared: false,
        codex_exit_code: null,
        parent_summary: null,
        parent_summary_file: null,
        host_capability_runtime: hostCapabilityRuntime,
        host_capability_evidence: hostCapabilityCollector.finish(),
        blockers: [...runtime.blockers],
        completion_evidence: false
      }
    }
    codexCommand = runtime.identity.realpath
    codexVersion = runtime.identity.version || null
  }

  // Naruto requires Codex multi-agent V2 when available; older hosts fail with
  // an update CTA instead of silently reviving a legacy process runtime.
  if (!input.runProcessImpl) {
    const capability = await probeNarutoCodexCapability({
      codexBin: codexCommand,
      version: codexVersion,
      env: childEnv
    })
    if (!capability.naruto.ok) {
      return {
        ...base,
        ok: false,
        status: 'codex_capability_blocked',
        prepared: false,
        codex_exit_code: null,
        parent_summary: null,
        parent_summary_file: null,
        host_capability_runtime: hostCapabilityRuntime,
        host_capability_evidence: hostCapabilityCollector.finish(),
        capability_matrix: capability.matrix,
        blockers: [...capability.naruto.blockers],
        operator_actions: capability.naruto.guidance,
        completion_evidence: false
      }
    }
  }

  let globalHostCapabilityConfigured = false
  if (input.projectTrusted !== true && !input.runProcessImpl) {
    const configured = await inspectConfiguredGlobalHostCapabilityServer({
      codexCommand,
      canonicalRoot,
      env: childEnv
    })
    if (!configured.ok) {
      return {
        ...base,
        ok: false,
        status: 'trusted_runtime_blocked',
        prepared: false,
        codex_exit_code: null,
        parent_summary: null,
        parent_summary_file: null,
        host_capability_runtime: hostCapabilityRuntime,
        host_capability_evidence: hostCapabilityCollector.finish(),
        blockers: ['host_capability_global_config_probe_failed'],
        completion_evidence: false
      }
    }
    globalHostCapabilityConfigured = configured.present
  }
  const args = buildOfficialSubagentCodexArgs({
    prompt: input.prompt,
    maxThreads: input.maxThreads,
    parentSummaryFile,
    workingDirectory: canonicalRoot,
    projectConfigArgs: hostCapabilityProjectCodexConfigArgs({
      canonicalRoot,
      projectTrusted: input.projectTrusted === true,
      globalHostCapabilityConfigured
    }),
    hostCapabilityConfigArgs: hostCapabilityCodexConfigArgs(hostCapabilityRuntime),
    credentialPolicy
  })
  const toolOutputRecovery = await inspectCodexLbCliLaunchRecovery({
    root: input.root,
    env: childEnv,
    cliArgs: args.slice(0, -1)
  })
  if (!toolOutputRecovery.ok) {
    return {
      ...base,
      ok: false,
      status: 'tool_output_recovery_blocked',
      prepared: false,
      codex_exit_code: null,
      parent_summary: null,
      parent_summary_file: null,
      host_capability_runtime: hostCapabilityRuntime,
      host_capability_evidence: hostCapabilityCollector.finish(),
      tool_output_recovery: toolOutputRecovery,
      blockers: toolOutputRecovery.blockers,
      operator_actions: toolOutputRecovery.operator_actions,
      completion_evidence: false
    }
  }
  await fsp.mkdir(path.dirname(parentSummaryFile), { recursive: true })
  if (hostCapabilityPendingDir && hostCapabilityLaunchNonce && input.missionId && input.workflowRunId) {
    const prepared = await writeHostCapabilityPendingRuntime({
      dir: hostCapabilityPendingDir,
      missionId: input.missionId,
      workflowRunId: input.workflowRunId,
      launchNonce: hostCapabilityLaunchNonce,
      runtime: hostCapabilityRuntime
    })
    if (!prepared) {
      return {
        ...base,
        ok: false,
        status: 'host_capability_blocked',
        prepared: false,
        codex_exit_code: null,
        parent_summary: null,
        parent_summary_file: null,
        host_capability_runtime: hostCapabilityRuntime,
        host_capability_evidence: hostCapabilityCollector.finish(),
        tool_output_recovery: toolOutputRecovery,
        blockers: ['host_capability_pending_runtime_write_failed'],
        completion_evidence: false
      }
    }
  }
  const execute = input.runProcessImpl || runProcess
  let processResult: RunProcessResult
  try {
    processResult = await execute(codexCommand, args, {
      cwd: canonicalRoot,
      timeoutMs: input.timeoutMs || 60 * 60 * 1000,
      maxOutputBytes: 256 * 1024,
      env: childEnv,
      envMode: 'replace',
      onStdout: hostCapabilityCollector.push,
      ...(input.onChildSpawn ? { onSpawn: input.onChildSpawn } : {})
    })
  } catch (error: any) {
    processResult = {
      code: -1,
      stdout: '',
      stderr: String(error?.message || error),
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      timedOut: false
    }
  } finally {
    await removeHostCapabilityPendingRuntime(hostCapabilityPendingDir)
  }
  const parentSummary = redactKnownValues(
    await fsp.readFile(parentSummaryFile, 'utf8').catch(() => ''),
    outputSecretValues
  )
  await fsp.rm(parentSummaryFile, { force: true }).catch(() => undefined)
  const hostCapabilityEvidence = confineHostCapabilityEvidenceSecrets(
    hostCapabilityCollector.finish(processResult.stdout),
    outputSecretValues
  )
  const stdout = summarizeCodexJsonlOutput(processResult.stdout, outputSecretValues)
  const stderr = redactKnownValues(processResult.stderr, outputSecretValues).slice(-12_000)
  const blockers = uniqueStrings([
    ...(processResult.spawnRegistrationFailed === true
      ? ['codex_parent_spawn_registration_failed']
      : processResult.timedOut
        ? ['codex_parent_timeout']
        : processResult.code === 0
          ? []
          : ['codex_parent_exit:' + String(processResult.code ?? 'unknown')]),
    ...hostCapabilityEvidence.blockers
  ])
  const ok = processResult.code === 0 && hostCapabilityEvidence.ok
  const status = processResult.code !== 0
    ? 'parent_failed'
    : hostCapabilityEvidence.ok
      ? 'parent_completed'
      : 'host_capability_blocked'

  return {
    ...base,
    ok,
    status,
    codex_exit_code: processResult.code,
    parent_summary: parentSummary.trim() || null,
    parent_summary_file: null,
    blockers,
    host_capability_runtime: hostCapabilityRuntime,
    host_capability_evidence: hostCapabilityEvidence,
    tool_output_recovery: toolOutputRecovery,
    process: {
      pid: processResult.pid || null,
      timed_out: processResult.timedOut,
      stdout_tail: stdout.tail,
      stderr_tail: stderr,
      jsonl_event_count: stdout.event_count,
      jsonl_event_types: stdout.event_types,
      output_truncated: processResult.truncated
    },
    completion_evidence: false
  }
}

function summarizeCodexJsonlOutput(text: string, secretValues: readonly string[]): {
  tail: string
  event_count: number
  event_types: string[]
} {
  const redacted = redactKnownValues(String(text || ''), secretValues)
  const eventTypes: string[] = []
  let eventCount = 0
  for (const line of redacted.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      eventCount += 1
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const type = String((parsed as Record<string, unknown>).type || '').trim()
        if (type) eventTypes.push(type)
      }
      continue
    } catch {}
  }
  return {
    // `codex exec --json` stdout is an evidence stream. Even an apparently
    // non-JSON tail can be a truncated JSONL tool-call record, so never return
    // raw stdout content from this path.
    tail: '',
    event_count: eventCount,
    event_types: uniqueStrings(eventTypes)
  }
}
