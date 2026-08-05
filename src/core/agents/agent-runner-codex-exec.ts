import path from 'node:path'
import { packageRoot, readJson, runProcess, writeJsonAtomic } from '../fsx.js'
import { managedProxyEnvForChild } from '../codex/managed-proxy-env.js'
import { agentWorkerEnv, validateAgentWorkerResult } from './agent-worker-pipeline.js'
import { fastModeEnv, resolveFastModePolicy } from './fast-mode-policy.js'
import { buildCodexExecArgs } from '../codex/codex-cli-syntax-builder.js'
import {
  desktopBridgeLaunchBlockedProcessResult,
  withDesktopBridgeCliLaunchGuard
} from '../codex-control/desktop-bridge-launch-guard.js'
import { prepareCodexAppServerRuntimeEnv } from '../codex-control/codex-app-server-runtime-env.js'

export function buildCodexExecAgentArgs(agent: any, prompt: string, opts: any = {}) {
  const resultFile = opts.resultFile || defaultCodexResultFile(agent, opts)
  const sandbox = opts.workspaceWrite ? 'workspace-write' : 'read-only'
  const noMcp = workerNoMcpDefault(agent, opts, sandbox)
  const args = buildCodexExecArgs({
    json: true,
    outputSchema: opts.schemaFile || path.join(packageRoot(), 'schemas/codex/agent-result.schema.json'),
    outputLastMessage: resultFile,
    ephemeral: true,
    skipGitRepoCheck: opts.skipGitRepoCheck !== false,
    profile: opts.profile ? String(opts.profile) : null,
    ignoreUserConfig: !opts.profile,
    noMcp,
    ignoreRules: true,
    sandbox,
    serviceTier: opts.serviceTier || (opts.fastMode === false ? 'standard' : 'fast'),
    prompt
  })
  return {
    resultFile,
    args
  }
}

function codexArgsIncludeServiceTier(args: string[], serviceTier: string) {
  return args.includes('-c') && args.includes(`service_tier=${serviceTier}`)
}

function defaultCodexResultFile(agent: any, opts: any = {}) {
  const root = opts.agentRoot || opts.cwd || process.cwd()
  const artifactDir = agent.session_artifact_dir || path.join('sessions', agent.id || agent.session_id || 'agent')
  return path.join(root, artifactDir, 'agent-result.json')
}

export async function runCodexExecAgent(agent: any, slice: any, opts: any = {}) {
  const fastPolicy = resolveFastModePolicy({ fastMode: opts.fastMode ?? agent.fast_mode, serviceTier: opts.serviceTier ?? agent.service_tier })
  if (opts.outputSchemaSupported === false) {
    return validateAgentWorkerResult({ mission_id: opts.missionId || opts.mission_id || '', agent_id: agent.id, session_id: agent.session_id, persona_id: agent.persona_id || agent.id, task_slice_id: slice?.id || '', status: 'blocked', backend: 'codex-exec', summary: 'Codex exec output schema support was not verified.', artifacts: [], blockers: ['codex_exec_output_schema_unsupported'], unverified: [], writes: [], source_intelligence_refs: agent.source_intelligence_refs || null, goal_mode_ref: agent.goal_mode_ref || null })
  }
  if (opts.dryRun !== false) {
    const command = buildCodexExecAgentArgs(agent, opts.prompt || slice?.description || '', opts)
    const proxyEnv = managedProxyEnvForChild({ ...process.env, ...(opts.env || {}) })
    const report = await writeCodexProcessReport(opts.agentRoot || opts.cwd || process.cwd(), agent, {
      project_hash: opts.projectHash || agent.project_hash || agent.root_hash || null,
      command: [opts.codexBin || 'codex', ...command.args],
      profile: opts.profile || null,
      result_file: command.resultFile,
      service_tier: fastPolicy.service_tier,
      fast_mode: fastPolicy.fast_mode,
      service_tier_passed_to_codex: codexArgsIncludeServiceTier(command.args, fastPolicy.service_tier),
      service_tier_cli_override_present: codexArgsIncludeServiceTier(command.args, fastPolicy.service_tier),
      no_mcp: command.args.includes('--no-mcp'),
      output_schema_used: command.args.includes('--output-schema'),
      output_last_message_path: command.resultFile,
      agent_worker_env_injected: false,
      recursion_guard_env: false,
      managed_proxy_env_keys: Object.keys(proxyEnv).sort(),
      pid: null,
      exit_code: null,
      stdout_log: null,
      stderr_log: null,
      dry_run: true
    })
    return validateAgentWorkerResult({ mission_id: opts.missionId || opts.mission_id || '', agent_id: agent.id, session_id: agent.session_id, persona_id: agent.persona_id || agent.id, task_slice_id: slice?.id || '', status: 'done', backend: 'codex-exec', summary: 'Codex exec command prepared for ' + agent.id + '.', findings: ['codex exec command prepared'], proposed_changes: [], changed_files: [], lease_compliance: { ok: true, violations: [] }, artifacts: [command.resultFile, report], blockers: [], confidence: 'verified_partial', handoff_notes: 'Dry-run did not launch Codex exec.', unverified: ['codex-exec dry-run command was not launched'], writes: [], source_intelligence_refs: agent.source_intelligence_refs || null, goal_mode_ref: agent.goal_mode_ref || null, verification: { status: 'dry_run', checks: ['codex-exec-args-built'] } })
  }
  const command = buildCodexExecAgentArgs(agent, opts.prompt || slice?.description || '', opts)
  const logRoot = path.join(opts.agentRoot || opts.cwd || process.cwd(), agent.session_artifact_dir || path.join('sessions', agent.id))
  const stdoutFile = path.join(logRoot, 'codex-exec.stdout.log')
  const stderrFile = path.join(logRoot, 'codex-exec.stderr.log')
  const allowedCommandsFile = path.join(opts.agentRoot || opts.cwd || process.cwd(), 'agent-allowed-commands.json')
  const workerEnv = agentWorkerEnv(agent, allowedCommandsFile)
  const effectiveEnv = { ...process.env, ...(opts.env || {}) }
  const runtimeEnv = await prepareCodexAppServerRuntimeEnv({ env: effectiveEnv })
  const proxyEnv = managedProxyEnvForChild(runtimeEnv)
  const execute: typeof runProcess = opts.runProcessImpl || runProcess
  const guarded = await withDesktopBridgeCliLaunchGuard({
    root: opts.cwd || process.cwd(),
    env: runtimeEnv,
    cliArgs: command.args.slice(0, -1)
  }, (sanitizedEnv) => execute(opts.codexBin || 'codex', command.args, { cwd: opts.cwd || process.cwd(), env: { ...sanitizedEnv, ...proxyEnv, ...fastModeEnv(fastPolicy), ...workerEnv }, timeoutMs: opts.timeoutMs || 30 * 60 * 1000, maxOutputBytes: 256 * 1024, stdoutFile, stderrFile }))
  const result = guarded.launched
    ? guarded.value
    : desktopBridgeLaunchBlockedProcessResult(guarded.desktopBridgeLaunchGuard)
  const report = await writeCodexProcessReport(opts.agentRoot || opts.cwd || process.cwd(), agent, {
    project_hash: opts.projectHash || agent.project_hash || agent.root_hash || null,
    command: [opts.codexBin || 'codex', ...command.args],
    profile: opts.profile || null,
    result_file: command.resultFile,
    service_tier: fastPolicy.service_tier,
    fast_mode: fastPolicy.fast_mode,
    service_tier_passed_to_codex: codexArgsIncludeServiceTier(command.args, fastPolicy.service_tier),
    service_tier_cli_override_present: codexArgsIncludeServiceTier(command.args, fastPolicy.service_tier),
    no_mcp: command.args.includes('--no-mcp'),
    output_schema_used: command.args.includes('--output-schema'),
    output_last_message_path: command.resultFile,
    agent_worker_env_injected: Object.keys(workerEnv).length > 0,
    recursion_guard_env: Boolean(workerEnv.SKS_AGENT_SESSION_ID),
    managed_proxy_env_keys: Object.keys(proxyEnv).sort(),
    pid: result.pid || null,
    exit_code: result.code,
    stdout_log: path.relative(opts.agentRoot || opts.cwd || process.cwd(), stdoutFile),
    stderr_log: path.relative(opts.agentRoot || opts.cwd || process.cwd(), stderrFile),
    stdout_tail: result.stdout,
    stderr_tail: result.stderr,
    stdout_bytes: result.stdoutBytes,
    stderr_bytes: result.stderrBytes,
    truncated: result.truncated,
    timed_out: result.timedOut,
    desktop_bridge_launch_guard: guarded.desktopBridgeLaunchGuard,
    dry_run: false
  })
  if (result.code === 0) {
    const parsed = await readJson<any>(command.resultFile, null).catch(() => null)
    if (parsed) {
      const validated = validateAgentWorkerResult({
        ...parsed,
        mission_id: parsed.mission_id || opts.missionId || opts.mission_id || '',
        agent_id: parsed.agent_id || agent.id,
        session_id: parsed.session_id || agent.session_id,
        persona_id: parsed.persona_id || agent.persona_id || agent.id,
        task_slice_id: parsed.task_slice_id || slice?.id || '',
        backend: 'codex-exec',
        patch_envelopes: normalizeCodexRuntimePatchEnvelopes(parsed.patch_envelopes, { childPid: Number.isFinite(Number(result.pid)) ? Number(result.pid) : null, workerPid: process.pid, fastPolicy }),
        source_intelligence_refs: parsed.source_intelligence_refs || agent.source_intelligence_refs || null,
        goal_mode_ref: parsed.goal_mode_ref || agent.goal_mode_ref || null,
        artifacts: [...(Array.isArray(parsed.artifacts) ? parsed.artifacts : []), command.resultFile, report],
        verification: { status: parsed.verification?.status || 'passed', checks: [...(Array.isArray(parsed.verification?.checks) ? parsed.verification.checks : []), 'codex-exec-output-last-message', 'agent-result-schema'] }
      })
      if (!validated.blockers.some((blocker: string) => blocker.startsWith('schema_invalid:'))) return validated
      return { ...validated, status: 'blocked', blockers: [...validated.blockers, 'codex_exec_result_schema_invalid'] }
    }
  }
  return validateAgentWorkerResult({ mission_id: opts.missionId || opts.mission_id || '', agent_id: agent.id, session_id: agent.session_id, persona_id: agent.persona_id || agent.id, task_slice_id: slice?.id || '', status: result.code === 0 ? 'done' : 'failed', backend: 'codex-exec', summary: result.stdout.slice(-1000) || result.stderr.slice(-1000), artifacts: [command.resultFile, report], blockers: result.code === 0 ? ['codex_exec_output_last_message_missing_or_invalid'] : [...(guarded.launched ? [] : guarded.desktopBridgeLaunchGuard.blockers), 'codex_exec_exit_' + result.code], confidence: 'verified_partial', unverified: result.code === 0 ? ['codex-exec stdout fallback; resultFile JSON missing or invalid'] : [], writes: [], source_intelligence_refs: agent.source_intelligence_refs || null, goal_mode_ref: agent.goal_mode_ref || null, codex_child_report: { desktop_bridge_launch_guard: guarded.desktopBridgeLaunchGuard }, verification: { status: result.code === 0 ? 'partial' : 'failed', checks: ['codex-exec-exit-code', 'codex-exec-process-report', 'codex-exec-output-last-message'] } })
}

function workerNoMcpDefault(agent: any, opts: any = {}, sandbox = 'read-only') {
  if (opts.noMcp !== undefined) return opts.noMcp !== false
  if (sandbox === 'read-only') return true
  const roleText = [
    agent?.role,
    agent?.persona_id,
    agent?.required_role,
    agent?.kind,
    opts.role,
    opts.kind
  ].map((value) => String(value || '')).join(' ')
  if (/\b(?:verify|verifier|verification|review|reviewer|qa|audit|read[-_ ]?only)\b/i.test(roleText)) return true
  const safeList = Array.isArray(opts.workerSafeMcpServers)
    ? opts.workerSafeMcpServers
    : String(process.env.SKS_WORKER_SAFE_MCP_SERVERS || '').split(',').map((item) => item.trim()).filter(Boolean)
  return !(opts.allowWorkerMcp === true && safeList.length > 0)
}

async function writeCodexProcessReport(root: string, agent: any, report: any) {
  const rel = path.join(agent.session_artifact_dir || path.join('sessions', agent.id), 'agent-process-report.json')
  await writeJsonAtomic(path.join(root, rel), { schema: 'sks.agent-process-report.v1', backend: 'codex-exec', agent_id: agent.id, session_id: agent.session_id, service_tier: report.service_tier || agent.service_tier || 'fast', fast_mode: report.fast_mode !== false, ...report })
  return rel
}

function normalizeCodexRuntimePatchEnvelopes(envelopes: any, input: { childPid?: number | null; workerPid?: number; fastPolicy: { fast_mode: boolean; service_tier: 'fast' | 'standard' } }) {
  if (!Array.isArray(envelopes)) return envelopes
  return envelopes.map((envelope) => ({
    ...envelope,
    source: 'model_authored',
    ...(Number.isFinite(Number(input.childPid)) ? { backend_child_process_id: Number(input.childPid) } : {}),
    ...(Number.isFinite(Number(input.workerPid)) ? { worker_process_id: Number(input.workerPid), native_cli_process_id: Number(input.workerPid) } : {}),
    fast_mode: input.fastPolicy.fast_mode,
    service_tier: input.fastPolicy.service_tier
  }))
}
