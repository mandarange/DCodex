import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { ensureDir, exists, nowIso, packageRoot, readJson, writeJsonAtomic } from '../fsx.js'
import { fastModeEnv, type FastModePolicy } from './fast-mode-policy.js'
import { validateAgentWorkerResult } from './agent-worker-pipeline.js'
import { appendParallelRuntimeEvent } from './parallel-runtime-proof.js'
import { appendAgentMessage } from './agent-message-bus.js'
import { markLoopWorkerInterrupted, registerLoopActiveWorker } from '../loops/loop-interrupt-registry.js'

export const NATIVE_CLI_WORKER_RUNTIME_SCHEMA = 'sks.native-cli-worker-runtime.v3'

type WorkerLifecycleEvent = 'slot_reserved' | 'worker_spawned' | 'heartbeat' | 'worker_completed' | 'worker_failed'

export function createNativeCliWorkerRuntimeRecorder(root: string, input: {
  missionId: string
  requestedAgents: number
  targetActiveSlots: number
  backend: string
  backendExplicit?: boolean
  noOllama?: boolean
  route: string
  fastModePolicy: FastModePolicy
  projectRoot?: string
}) {
  return new NativeCliWorkerRuntimeRecorder(root, input)
}

class NativeCliWorkerRuntimeRecorder {
  private records: any[] = []
  private active = new Set<number>()
  private maxObserved = 0
  private writeLock: Promise<unknown> = Promise.resolve()

  constructor(private root: string, private input: {
    missionId: string
    requestedAgents: number
    targetActiveSlots: number
    backend: string
    backendExplicit?: boolean
    noOllama?: boolean
    route: string
    fastModePolicy: FastModePolicy
    projectRoot?: string
  }) {}

  async initialize() {
    await this.persist()
  }

  async launchWorker(ctx: { agent: any; slice: any; opts: any }) {
    const worktree = normalizeWorkerWorktree(ctx.agent?.worktree || ctx.slice?.worktree || ctx.opts?.worktree || null)
    const workerCwd = worktree?.path || ctx.opts.cwd || packageRoot()
    const workerDirRel = path.join(ctx.agent.session_artifact_dir || path.join('sessions', ctx.agent.id), 'worker')
    const workerDir = path.join(this.root, workerDirRel)
    await ensureDir(workerDir)

    const intakeRel = path.join(workerDirRel, 'worker-intake.json')
    const resultRel = path.join(workerDirRel, 'worker-result.json')
    const heartbeatRel = path.join(workerDirRel, 'worker-heartbeat.jsonl')
    const patchRel = path.join(workerDirRel, 'worker-patch-envelope.json')
    const stdoutRel = path.join(workerDirRel, 'worker.stdout.log')
    const stderrRel = path.join(workerDirRel, 'worker.stderr.log')
    const intake = {
      schema: 'sks.native-cli-worker-intake.v1',
      generated_at: nowIso(),
      mission_id: this.input.missionId,
      parent_mission_id: this.input.missionId,
      route: this.input.route,
      backend: this.input.backend,
      backend_explicit: this.input.backendExplicit === true,
      no_ollama: this.input.noOllama === true || ctx.opts.noOllama === true,
      agent_root: this.root,
      main_repo_root: worktree?.main_repo_root || ctx.opts.cwd || packageRoot(),
      cwd: workerCwd,
      worktree,
      agent: ctx.agent,
      slice: ctx.slice,
      worker_artifact_dir: workerDirRel,
      result_path: resultRel,
      heartbeat_path: heartbeatRel,
      patch_envelope_path: patchRel,
      service_tier: this.input.fastModePolicy.service_tier,
      fast_mode: this.input.fastModePolicy.fast_mode,
      ollama_enabled: ctx.opts.ollamaEnabled === true || this.input.backend === 'ollama' || this.input.backend === 'local-llm',
      ollama_model: ctx.opts.ollamaModel || null,
      ollama_base_url: ctx.opts.ollamaBaseUrl || null,
      source_intelligence_refs: ctx.agent.source_intelligence_refs || null,
      goal_mode_ref: ctx.agent.goal_mode_ref || null,
      strategy_refs: ctx.slice?.strategy_refs || null,
      recursion_guard_env: true
    }
    await writeJsonAtomic(path.join(this.root, intakeRel), intake)

    const workerEntrypoint = await resolveWorkerEntrypointPath()
    const args = [workerEntrypoint, '--intake', path.join(this.root, intakeRel), '--json']
    const record: any = {
      schema: 'sks.native-cli-worker-session-record.v2',
      launched_at: nowIso(),
      closed_at: null,
      mission_id: this.input.missionId,
      agent_id: ctx.agent.id,
      session_id: ctx.agent.session_id,
      slot_id: ctx.agent.slot_id || null,
      generation_index: ctx.agent.generation_index || null,
      task_slice_id: ctx.slice?.id || null,
      backend: this.input.backend,
      pid: null,
      process_id: null,
      command_line: [process.execPath, ...redactWorkerArgs(args)],
      stdout_log: stdoutRel,
      stderr_log: stderrRel,
      worker_artifact_dir: workerDirRel,
      worker_intake: intakeRel,
      result_path: resultRel,
      heartbeat_path: heartbeatRel,
      patch_envelope_path: patchRel,
      fast_mode: this.input.fastModePolicy.fast_mode,
      service_tier: this.input.fastModePolicy.service_tier,
      cwd: workerCwd,
      worker_placement: 'process',
      scaling_primitive: 'native_cli_process',
      status: 'launching',
      exit_code: null,
      blockers: []
    }

    await this.lifecycle(ctx, {
      eventType: 'slot_reserved',
      status: 'queued',
      artifacts: [intakeRel, heartbeatRel, resultRel],
      logTail: 'placement=process'
    })

    const stdout = fs.createWriteStream(path.join(this.root, stdoutRel), { flags: 'a' })
    const stderr = fs.createWriteStream(path.join(this.root, stderrRel), { flags: 'a' })
    const child = spawn(process.execPath, args, {
      cwd: workerCwd,
      env: {
        ...process.env,
        ...(ctx.opts.env || {}),
        ...fastModeEnv(this.input.fastModePolicy),
        SKS_AGENT_WORKER: '1',
        SKS_PIPELINE_MODE: 'agent-worker',
        SKS_DISABLE_ROUTE_RECURSION: '1',
        SKS_PARENT_MISSION_ID: this.input.missionId,
        SKS_AGENT_SESSION_ID: String(ctx.agent.session_id || ''),
        SKS_AGENT_SLOT_ID: String(ctx.agent.slot_id || ''),
        SKS_AGENT_GENERATION_INDEX: String(ctx.agent.generation_index || 1)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const removeAbortListener = terminateChildOnAbort(child, ctx.opts?.signal)
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }))
      child.once('error', () => resolve({ code: 1, signal: null }))
    })
    record.pid = child.pid || null
    record.process_id = child.pid || null
    record.status = 'running'
    if (child.pid) this.active.add(child.pid)
    this.maxObserved = Math.max(this.maxObserved, this.active.size)
    await this.record(record)

    const loopHandle = await registerLoopWorkerHandle({
      root: ctx.opts.projectRoot || this.input.projectRoot || ctx.opts.cwd || packageRoot(),
      env: ctx.opts.env || {},
      agentId: String(ctx.agent.id || ctx.agent.session_id || 'agent'),
      sessionId: ctx.agent.session_id || null,
      pid: child.pid || null
    })
    await appendParallelRuntimeEvent(this.root, this.input.missionId, {
      event_type: 'worker_process_spawned',
      slot_id: ctx.agent.slot_id || ctx.agent.id || null,
      generation_index: ctx.agent.generation_index || null,
      session_id: ctx.agent.session_id || null,
      pid: child.pid || null,
      backend: this.input.backend,
      placement: 'process',
      worktree_id: worktree?.id || null
    }).catch(() => undefined)
    await this.lifecycle(ctx, {
      eventType: 'worker_spawned',
      status: 'launching',
      artifacts: [intakeRel, heartbeatRel, resultRel, stdoutRel, stderrRel],
      logTail: `pid=${child.pid || 'unknown'}`
    })

    child.stdout?.pipe(stdout)
    child.stderr?.pipe(stderr)
    const exit = await exitPromise
    removeAbortListener()
    stdout.end()
    stderr.end()
    if (child.pid) this.active.delete(child.pid)
    record.closed_at = nowIso()
    record.exit_code = exit.code
    record.signal = exit.signal
    record.status = exit.code === 0 ? 'closed' : 'failed'
    if (loopHandle) {
      await markLoopWorkerInterrupted(
        ctx.opts.projectRoot || this.input.projectRoot || ctx.opts.cwd || packageRoot(),
        loopHandle.mission_id,
        loopHandle.worker_id,
        record.status === 'closed' ? 'completed' : 'failed'
      ).catch(() => undefined)
    }

    const parsed = await readJson<any>(path.join(this.root, resultRel), null).catch(() => null)
    if (!parsed) {
      record.blockers = ['native_cli_worker_result_missing']
      await this.lifecycle(ctx, {
        eventType: 'worker_failed',
        status: 'failed',
        artifacts: [stdoutRel, stderrRel],
        blockers: record.blockers,
        logTail: 'Native CLI worker result missing.'
      })
      await this.record(record)
      return validateAgentWorkerResult({
        mission_id: this.input.missionId,
        agent_id: ctx.agent.id,
        session_id: ctx.agent.session_id,
        persona_id: ctx.agent.persona_id || ctx.agent.id,
        task_slice_id: ctx.slice?.id || '',
        status: 'failed',
        backend: this.input.backend,
        summary: 'Native CLI worker result missing.',
        artifacts: [stdoutRel, stderrRel],
        blockers: record.blockers,
        unverified: [],
        writes: [],
        source_intelligence_refs: ctx.agent.source_intelligence_refs || null,
        goal_mode_ref: ctx.agent.goal_mode_ref || null
      })
    }

    const result = validateAgentWorkerResult({
      ...parsed,
      artifacts: [...new Set([...(Array.isArray(parsed.artifacts) ? parsed.artifacts : []), stdoutRel, stderrRel])]
    })
    record.status = result.status === 'done' ? 'closed' : result.status
    record.blockers = result.blockers || []
    await this.lifecycle(ctx, {
      eventType: result.status === 'done' ? 'worker_completed' : 'worker_failed',
      status: result.status === 'done' ? 'completed' : 'failed',
      artifacts: result.artifacts || [],
      blockers: result.blockers || [],
      changedFiles: changedFilesFromWorkerResult(result),
      logTail: result.summary || ''
    })
    await this.record(record)
    return result
  }

  async finalize() {
    await this.persist()
    return this.summary()
  }

  private async record(record: any) {
    const index = this.records.findIndex((row) => row.session_id === record.session_id)
    if (index >= 0) this.records[index] = record
    else this.records.push(record)
    await this.persist()
  }

  private async lifecycle(ctx: { agent: any; slice: any; opts: any }, input: {
    eventType: WorkerLifecycleEvent
    status: string
    artifacts?: string[]
    blockers?: string[]
    changedFiles?: string[]
    logTail?: string
  }) {
    if (input.eventType === 'worker_completed' || input.eventType === 'worker_failed') {
      await appendAgentMessage(this.root, {
        from: String(ctx.agent?.slot_id || ctx.agent?.id || 'worker'),
        session_id: ctx.agent?.session_id == null ? '' : String(ctx.agent.session_id),
        to: 'orchestrator',
        type: input.eventType,
        body: input.logTail || input.eventType
      }).catch(() => undefined)
    }
    const parallelEvent = mapLifecycleToParallelEvent(input.eventType)
    if (!parallelEvent) return
    await appendParallelRuntimeEvent(this.root, this.input.missionId, {
      event_type: parallelEvent,
      slot_id: String(ctx.agent?.slot_id || ctx.agent?.id || 'slot-001'),
      generation_index: Number(ctx.agent?.generation_index || 1),
      session_id: ctx.agent?.session_id == null ? null : String(ctx.agent.session_id),
      pid: null,
      backend: this.input.backend,
      placement: 'process',
      worktree_id: ctx.agent?.worktree?.id || ctx.slice?.worktree?.id || null,
      meta: {
        status: input.status,
        artifacts: input.artifacts || [],
        changed_files: input.changedFiles || [],
        blockers: input.blockers || []
      }
    }).catch(() => undefined)
  }

  private async persist() {
    this.writeLock = this.writeLock.catch(() => undefined).then(async () => {
      await writeJsonAtomic(path.join(this.root, 'native-cli-worker-runtime.json'), this.summary())
    })
    await this.writeLock
  }

  private summary() {
    const closed = this.records.filter((row) => row.status === 'closed')
    return {
      schema: NATIVE_CLI_WORKER_RUNTIME_SCHEMA,
      generated_at: nowIso(),
      ok: this.records.every((row) => row.status === 'closed'),
      mission_id: this.input.missionId,
      route: this.input.route,
      backend: this.input.backend,
      scaling_primitive: 'native_cli_process',
      requested_agents: this.input.requestedAgents,
      target_active_slots: this.input.targetActiveSlots,
      spawned_worker_process_count: this.records.length,
      closed_worker_process_count: closed.length,
      max_observed_worker_process_count: this.maxObserved,
      active_worker_process_count: this.active.size,
      unique_worker_session_count: new Set(this.records.map((row) => row.session_id).filter(Boolean)).size,
      unique_slot_count: new Set(this.records.map((row) => row.slot_id).filter(Boolean)).size,
      unique_generation_count: new Set(this.records.map((row) => `${row.slot_id}:${row.generation_index}`).filter(Boolean)).size,
      process_ids: this.records.map((row) => row.pid).filter((pid) => Number.isFinite(Number(pid))),
      worker_command_lines: this.records.map((row) => row.command_line),
      stdout_logs: this.records.map((row) => row.stdout_log),
      stderr_logs: this.records.map((row) => row.stderr_log),
      worker_artifact_dirs: this.records.map((row) => row.worker_artifact_dir),
      service_tier: this.input.fastModePolicy.service_tier,
      fast_mode: this.input.fastModePolicy.fast_mode,
      records: this.records,
      blockers: this.records.flatMap((row) => row.blockers || [])
    }
  }
}

function terminateChildOnAbort(child: ReturnType<typeof spawn>, signal?: AbortSignal) {
  if (!signal) return () => undefined
  let hardKillTimer: NodeJS.Timeout | null = null
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    hardKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 1500)
    hardKillTimer.unref?.()
  }
  if (signal.aborted) terminate()
  else signal.addEventListener('abort', terminate, { once: true })
  return () => {
    signal.removeEventListener('abort', terminate)
    if (hardKillTimer) clearTimeout(hardKillTimer)
  }
}

async function resolveWorkerEntrypointPath() {
  const distEntrypoint = path.join(packageRoot(), 'dist', 'core', 'agents', 'native-cli-worker-entry.js')
  if (await exists(distEntrypoint)) return distEntrypoint
  return path.join(packageRoot(), 'src', 'core', 'agents', 'native-cli-worker-entry.ts')
}

function redactWorkerArgs(args: string[]) {
  return args.map((arg, index) => index > 0 && args[index - 1] === '--intake' ? '<worker-intake.json>' : arg)
}

function normalizeWorkerWorktree(value: any): { id: string; path: string; branch: string; main_repo_root: string | null } | null {
  const pathValue = value?.path || value?.worktree_path
  if (!pathValue) return null
  return {
    id: String(value?.id || value?.worktree_id || value?.slot_id || 'worktree'),
    path: String(pathValue),
    branch: String(value?.branch || 'unknown'),
    main_repo_root: value?.main_repo_root == null ? null : String(value.main_repo_root)
  }
}

function mapLifecycleToParallelEvent(eventType: WorkerLifecycleEvent) {
  if (eventType === 'slot_reserved') return 'slot_reserved' as const
  if (eventType === 'heartbeat') return 'worker_heartbeat_seen' as const
  if (eventType === 'worker_completed') return 'worker_completed' as const
  if (eventType === 'worker_failed') return 'worker_failed' as const
  return null
}

function changedFilesFromWorkerResult(result: any): string[] {
  const direct = Array.isArray(result?.changed_files) ? result.changed_files : []
  const envelopeFiles = (Array.isArray(result?.patch_envelopes) ? result.patch_envelopes : [])
    .flatMap((envelope: any) => [
      ...(Array.isArray(envelope?.changed_files) ? envelope.changed_files : []),
      ...(Array.isArray(envelope?.allowed_paths) ? envelope.allowed_paths : []),
      ...(Array.isArray(envelope?.operations) ? envelope.operations.map((operation: any) => operation?.path) : [])
    ])
  return [...new Set([...direct, ...envelopeFiles].map((file) => String(file || '').replace(/\\/g, '/').replace(/^\.\/+/, '')).filter(Boolean))]
}

async function registerLoopWorkerHandle(input: {
  root: string
  env: NodeJS.ProcessEnv
  agentId: string
  sessionId: string | null
  pid: number | null
}) {
  const missionId = String(input.env.SKS_MISSION_ID || input.env.SKS_PARENT_MISSION_ID || '').trim()
  const loopId = String(input.env.SKS_LOOP_ID || '').trim()
  const phase = String(input.env.SKS_LOOP_PHASE || '').trim()
  if (!missionId || !loopId || (phase !== 'maker' && phase !== 'checker')) return null
  return registerLoopActiveWorker(input.root, {
    mission_id: missionId,
    loop_id: loopId,
    phase,
    worker_id: input.agentId,
    session_id: input.sessionId,
    pid: input.pid,
    interrupt_supported: Boolean(input.pid || input.sessionId)
  }).catch(() => null)
}
