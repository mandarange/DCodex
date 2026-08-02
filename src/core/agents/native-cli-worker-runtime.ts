import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { appendJsonl, ensureDir, exists, nowIso, packageRoot, readJson, writeJsonAtomic } from '../fsx.js'
import { fastModeEnv, type FastModePolicy } from './fast-mode-policy.js'
import { validateAgentWorkerResult } from './agent-worker-pipeline.js'
import { closeWorkerPane, openHeadlessByDesignViewportWorker, type ZellijWorkerPaneOpenInput } from '../zellij/zellij-worker-pane-manager.js'
import { closeWorkerInRightColumn, recordHeadlessWorkerInRightColumn } from '../zellij/zellij-right-column-manager.js'
import { resolveProviderContext } from '../provider/provider-context.js'
import { buildZellijSlotPaneCommand } from '../zellij/zellij-slot-pane-renderer.js'
import { resolveZellijWorkerPaneUiMode } from '../zellij/zellij-ui-mode.js'
import { appendZellijSlotTelemetry, type ZellijSlotTelemetryEventType, type ZellijSlotTelemetryStatus } from '../zellij/zellij-slot-telemetry.js'
import { appendParallelRuntimeEvent } from './parallel-runtime-proof.js'
import { appendAgentMessage } from './agent-message-bus.js'
import { markLoopWorkerInterrupted, registerLoopActiveWorker } from '../loops/loop-interrupt-registry.js'

export const NATIVE_CLI_WORKER_RUNTIME_SCHEMA = 'sks.native-cli-worker-runtime.v2'

export function createNativeCliWorkerRuntimeRecorder(root: string, input: {
  missionId: string
  requestedAgents: number
  targetActiveSlots: number
  backend: string
  backendExplicit?: boolean
  noOllama?: boolean
  route: string
  fastModePolicy: FastModePolicy
  workerPlacement?: string
  zellijVisiblePaneCap?: number
  projectRoot?: string
}) {
  return new NativeCliWorkerRuntimeRecorder(root, input)
}

class NativeCliWorkerRuntimeRecorder {
  private records: any[] = []
  private active = new Set<number>()
  private maxObserved = 0
    private writeLock: Promise<unknown> = Promise.resolve()
    private nextPaneToken = -1

  constructor(private root: string, private input: { missionId: string; requestedAgents: number; targetActiveSlots: number; backend: string; backendExplicit?: boolean; noOllama?: boolean; route: string; fastModePolicy: FastModePolicy; workerPlacement?: string; zellijVisiblePaneCap?: number; projectRoot?: string }) {}

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
    const commandLine = [process.execPath, ...redactWorkerArgs(args)]
    const record: any = {
      schema: 'sks.native-cli-worker-session-record.v1',
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
      command_line: commandLine,
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
      status: 'launching',
      exit_code: null,
      blockers: []
    }
    const stdout = fs.createWriteStream(path.join(this.root, stdoutRel), { flags: 'a' })
    const stderr = fs.createWriteStream(path.join(this.root, stderrRel), { flags: 'a' })
	    const placement = String(ctx.opts.workerPlacement || this.input.workerPlacement || (this.input.backend === 'zellij' ? 'zellij-pane' : 'process'))
    const wantsZellijUi = placement === 'zellij-pane'
      && ctx.opts.zellijPaneWorker !== false
      && (ctx.opts.zellijSessionName || this.input.missionId)
	    const useZellijPane = Boolean(wantsZellijUi)
	    await this.telemetry(ctx, {
	      eventType: 'slot_reserved',
	      status: placement === 'zellij-pane' && !useZellijPane ? 'headless' : 'queued',
	      artifacts: [intakeRel, heartbeatRel, resultRel],
	      logTail: `placement=${placement}${wantsZellijUi ? ';viewport-ui=headless-by-design' : ''}`
	    })
	    if (useZellijPane) {
      stdout.end()
      stderr.end()
      return this.launchWorkerInZellijPane({
        ctx,
        record,
        args,
        resultRel,
        stdoutRel,
        stderrRel,
        heartbeatRel,
        workerDirRel
      })
    }
	    if (placement === 'zellij-pane' && ctx.opts.zellijPaneWorker !== false && !useZellijPane) {
	      record.worker_placement = 'headless'
	      record.headless_reason = `visible_pane_cap:${this.zellijVisiblePaneCap(ctx.opts)}`
	      await this.telemetry(ctx, {
	        eventType: 'headless_overflow',
	        status: 'headless',
	        artifacts: [intakeRel, heartbeatRel, resultRel],
	        logTail: record.headless_reason
	      })
	      await recordHeadlessWorkerInRightColumn({
        root: this.root,
        projectRoot: ctx.opts.projectRoot || this.input.projectRoot || ctx.opts.cwd,
        missionId: this.input.missionId,
        sessionName: String(ctx.opts.zellijSessionName || (this.input.missionId ? `sks-${this.input.missionId}` : 'sks-agent-runtime')),
        slotId: String(ctx.agent.slot_id || ctx.agent.id || 'slot-001'),
        generationIndex: Number(ctx.agent.generation_index || 1),
        reason: record.headless_reason
      }).catch(() => null)
    } else {
      record.worker_placement = placement === 'zellij-pane' ? 'zellij-pane' : 'process'
    }
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
    const loopHandle = await registerLoopWorkerHandle({
      root: ctx.opts.projectRoot || this.input.projectRoot || ctx.opts.cwd || packageRoot(),
      env: ctx.opts.env || {},
      agentId: String(ctx.agent.id || ctx.agent.session_id || 'agent'),
      sessionId: ctx.agent.session_id || null,
      pid: child.pid || null
    })
	    record.status = 'running'
	    await appendParallelRuntimeEvent(this.root, this.input.missionId, {
	      event_type: 'worker_process_spawned',
	      slot_id: ctx.agent.slot_id || ctx.agent.id || null,
	      generation_index: ctx.agent.generation_index || null,
	      session_id: ctx.agent.session_id || null,
	      pid: child.pid || null,
	      backend: this.input.backend,
	      placement: record.worker_placement === 'headless' ? 'headless' : 'process',
	      worktree_id: worktree?.id || null
	    }).catch(() => undefined)
	    await this.telemetry(ctx, {
	      eventType: 'worker_spawned',
	      status: 'launching',
	      artifacts: [intakeRel, heartbeatRel, resultRel, stdoutRel, stderrRel],
	      logTail: `pid=${child.pid || 'unknown'}`
	    })
    if (child.pid) this.active.add(child.pid)
    this.maxObserved = Math.max(this.maxObserved, this.active.size)
    await this.record(record)
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
    if (record.worker_placement === 'headless') {
      await closeWorkerInRightColumn({
        root: this.root,
        projectRoot: ctx.opts.projectRoot || this.input.projectRoot || ctx.opts.cwd,
        missionId: this.input.missionId,
        slotId: String(ctx.agent.slot_id || ctx.agent.id || 'slot-001'),
        generationIndex: Number(ctx.agent.generation_index || 1),
        paneId: null,
        status: record.status === 'closed' ? 'closed' : 'failed'
      }).catch(() => null)
    }
    const parsed = await readJson<any>(path.join(this.root, resultRel), null).catch(() => null)
	    if (!parsed) {
	      record.blockers = ['native_cli_worker_result_missing']
	      await this.telemetry(ctx, {
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
      artifacts: [...(Array.isArray(parsed.artifacts) ? parsed.artifacts : []), stdoutRel, stderrRel]
    })
	    record.status = result.status === 'done' ? 'closed' : result.status
	    record.blockers = result.blockers || []
	    await this.telemetry(ctx, {
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

  private async launchWorkerInZellijPane(input: {
    ctx: { agent: any; slice: any; opts: any }
    record: any
    args: string[]
    resultRel: string
    stdoutRel: string
    stderrRel: string
    heartbeatRel: string
    workerDirRel: string
  }) {
    const sessionName = String(input.ctx.opts.zellijSessionName || (this.input.missionId ? `sks-${this.input.missionId}` : 'sks-agent-runtime'))
    const slotId = String(input.ctx.agent.slot_id || input.ctx.agent.id || 'slot-001')
    const worktree = normalizeWorkerWorktree(input.ctx.agent?.worktree || input.ctx.slice?.worktree || input.ctx.opts?.worktree || null)
    const workerCwd = worktree?.path || input.ctx.opts.cwd || packageRoot()
    const activeToken = this.nextPaneToken--
    this.active.add(activeToken)
    this.maxObserved = Math.max(this.maxObserved, this.active.size)

    const providerContext = await resolveProviderContext({
      root: this.root,
      route: this.input.route,
      serviceTier: this.input.fastModePolicy.service_tier
    })
    const uiMode = resolveZellijWorkerPaneUiMode(Array.isArray(input.ctx.opts.args) ? input.ctx.opts.args : [], process.env)
    const liveWorkerPane = uiMode !== 'compact-slots'
    const workerEnv = {
      ...(input.ctx.opts.env || {}),
      ...fastModeEnv(this.input.fastModePolicy),
      SKS_AGENT_WORKER: '1',
      SKS_PIPELINE_MODE: 'agent-worker',
      SKS_DISABLE_ROUTE_RECURSION: '1',
      SKS_PARENT_MISSION_ID: this.input.missionId,
      SKS_AGENT_SESSION_ID: String(input.ctx.agent.session_id || ''),
      SKS_AGENT_SLOT_ID: slotId,
      SKS_AGENT_GENERATION_INDEX: String(input.ctx.agent.generation_index || 1),
      ...(input.ctx.opts.ollamaModel ? { SKS_OLLAMA_MODEL: String(input.ctx.opts.ollamaModel) } : {}),
      ...(input.ctx.opts.ollamaBaseUrl ? { SKS_OLLAMA_BASE_URL: String(input.ctx.opts.ollamaBaseUrl) } : {}),
      SKS_ZELLIJ_SESSION_NAME: sessionName
    }
	    const role = String(input.ctx.agent.naruto_role || input.ctx.agent.role || input.ctx.agent.persona_id || 'worker')
	    await this.telemetry(input.ctx, {
	      eventType: 'slot_reserved',
	      status: 'queued',
	      artifacts: [path.join(input.workerDirRel, 'worker-intake.json'), input.heartbeatRel, input.resultRel],
	      logTail: `zellij=${sessionName}`
	    })
    const workerCommand = liveWorkerPane
      ? buildPaneWorkerCommand({
        args: input.args,
        stdoutPath: path.join(this.root, input.stdoutRel),
        stderrPath: path.join(this.root, input.stderrRel),
        heartbeatPath: path.join(this.root, input.heartbeatRel),
        header: buildPaneWorkerHeader({
          slotId,
          generationIndex: Number(input.ctx.agent.generation_index || 1),
          role,
          backend: this.input.backend,
          provider: providerContext.provider,
          serviceTier: this.input.fastModePolicy.service_tier,
          worktree,
          task: input.ctx.slice?.description || input.ctx.slice?.title || input.ctx.slice?.id || ''
        }),
        env: {
          ...workerEnv,
          SKS_ZELLIJ_WORKER_PANE: '1'
        }
      })
      : buildZellijSlotPaneCommand({
        cliPath: String(input.args[0] || ''),
        missionId: this.input.missionId,
        slotId,
        generationIndex: Number(input.ctx.agent.generation_index || 1),
        artifactDir: path.join(this.root, input.workerDirRel),
        backend: this.input.backend,
        role,
        provider: providerContext.provider,
        model: String(process.env.SKS_MODEL || process.env.OPENAI_MODEL || process.env.CODEX_MODEL || ''),
        serviceTier: this.input.fastModePolicy.service_tier,
        reasoningEffort: String(input.ctx.agent.model_reasoning_effort || input.ctx.agent.reasoning_effort || process.env.SKS_REASONING_EFFORT || ''),
        currentTask: String(input.ctx.slice?.title || input.ctx.slice?.description || input.ctx.slice?.id || ''),
        mode: uiMode,
        watch: true
    })
    const processRun = liveWorkerPane
      ? null
      : await this.spawnCompactSlotWorkerProcess({
        args: input.args,
        cwd: workerCwd,
        env: workerEnv,
        stdoutRel: input.stdoutRel,
        stderrRel: input.stderrRel,
        signal: input.ctx.opts?.signal
      })
    let loopHandle = await registerLoopWorkerHandle({
      root: input.ctx.opts.projectRoot || this.input.projectRoot || input.ctx.opts.cwd || packageRoot(),
      env: input.ctx.opts.env || {},
      agentId: String(input.ctx.agent.id || input.ctx.agent.session_id || 'agent'),
      sessionId: input.ctx.agent.session_id || null,
      pid: processRun?.pid || null
    })
    if (processRun?.pid) {
      input.record.pid = processRun.pid
      input.record.process_id = processRun.pid
      await appendParallelRuntimeEvent(this.root, this.input.missionId, {
        event_type: 'worker_process_spawned',
        slot_id: slotId,
        generation_index: Number(input.ctx.agent.generation_index || 1),
        session_id: input.ctx.agent.session_id || null,
        pid: processRun.pid,
        backend: this.input.backend,
        placement: 'headless_by_design_viewport_ui',
        worktree_id: worktree?.id || null
      }).catch(() => undefined)
      await this.record(input.record)
    }
    const paneInput: ZellijWorkerPaneOpenInput = {
        root: this.root,
        missionId: this.input.missionId,
        sessionName,
        slotId,
        generationIndex: Number(input.ctx.agent.generation_index || 1),
        sessionId: String(input.ctx.agent.session_id || ''),
        workerArtifactDir: input.workerDirRel,
        workerCommand,
        resultPath: input.resultRel,
        heartbeatPath: input.heartbeatRel,
        patchEnvelopePath: input.record.patch_envelope_path,
        stdoutLog: input.stdoutRel,
        stderrLog: input.stderrRel,
        cwd: workerCwd,
        providerContext,
        serviceTier: this.input.fastModePolicy.service_tier,
        worktree: worktree ? { id: worktree.id, path: worktree.path, branch: worktree.branch } : null,
        backend: this.input.backend,
        taskTitle: String(input.ctx.slice?.title || input.ctx.slice?.description || input.ctx.slice?.id || '') || null,
        uiMode,
        projectRoot: input.ctx.opts.projectRoot || this.input.projectRoot || input.ctx.opts.cwd,
        rightColumnMode: 'spawn-on-first-worker',
        visiblePaneCap: this.zellijVisiblePaneCap(input.ctx.opts),
        plannedAgentCount: this.input.targetActiveSlots
    }
    let paneRecord: any = await openHeadlessByDesignViewportWorker(paneInput)
    const zellijRequired = process.env.SKS_REQUIRE_ZELLIJ === '1'
    const launchBlockers = zellijRequired ? paneRecord.blockers || [] : []
    const launchWarnings = zellijRequired ? [] : paneRecord.blockers || []
    input.record.command_line = paneRecord.pane_id_source === 'headless_by_design_viewport_ui'
      ? ['node', '<native-cli-worker-command>', '# headless-by-design viewport UI']
      : ['zellij', '--session', sessionName, 'action', 'new-pane', '--direction', paneRecord.direction_applied, '--name', paneRecord.pane_name, '--', 'sh', '-lc', liveWorkerPane ? '<native-cli-worker-command>' : '<zellij-slot-pane-renderer-command>']
    input.record.zellij_session_name = sessionName
    input.record.zellij_pane_id = paneRecord.pane_id || null
    input.record.zellij_pane_id_source = paneRecord.pane_id_source
    input.record.zellij_create_session = paneRecord.create_session
    input.record.zellij_launch = paneRecord.launch
    input.record.zellij_worker_pane = path.join(input.workerDirRel, 'zellij-worker-pane.json')
    input.record.pane_kind = paneRecord.pane_kind
    input.record.scaling_primitive = paneRecord.scaling_primitive
    input.record.provider = paneRecord.provider
    input.record.service_tier = paneRecord.service_tier
    input.record.provider_context = paneRecord.provider_context
    input.record.worktree = worktree
    input.record.zellij_ui_mode = uiMode
    input.record.slot_visualization = liveWorkerPane ? 'worker-command-pane' : 'zellij-slot-pane-renderer'
    if (paneRecord.pane_id_source === 'headless_by_design_viewport_ui') {
      input.record.worker_placement = 'headless_by_design_viewport_ui'
      input.record.slot_visualization = 'monitor-plus-viewport'
    }
	    input.record.status = launchBlockers.length ? 'failed' : 'running'
	    input.record.blockers = launchBlockers
	    input.record.warnings = [...(input.record.warnings || []), ...launchWarnings]
	    await this.telemetry(input.ctx, {
	      eventType: 'worker_spawned',
	      status: launchBlockers.length ? 'failed' : 'launching',
	      artifacts: [input.resultRel, input.heartbeatRel, input.stdoutRel, input.stderrRel, path.join(input.workerDirRel, 'zellij-worker-pane.json')],
	      blockers: launchBlockers,
	      logTail: paneRecord.pane_title || ''
	    })
	    await this.record(input.record)
	    if (launchBlockers.length) {
      this.active.delete(activeToken)
      input.record.closed_at = nowIso()
	      input.record.status = 'failed'
	      await this.telemetry(input.ctx, {
	        eventType: 'worker_failed',
	        status: 'failed',
	        artifacts: [input.stdoutRel, input.stderrRel, path.join(input.workerDirRel, 'zellij-worker-pane.json')],
	        blockers: launchBlockers,
	        logTail: 'Zellij worker pane launch failed.'
	      })
      await this.record(input.record)
      return validateAgentWorkerResult({
        mission_id: this.input.missionId,
        agent_id: input.ctx.agent.id,
        session_id: input.ctx.agent.session_id,
        persona_id: input.ctx.agent.persona_id || input.ctx.agent.id,
        task_slice_id: input.ctx.slice?.id || '',
        status: 'failed',
        backend: this.input.backend,
        summary: 'Zellij worker pane launch failed.',
        artifacts: [input.stdoutRel, input.stderrRel, path.join(input.workerDirRel, 'zellij-worker-pane.json')],
        blockers: launchBlockers,
        unverified: [],
        writes: [],
        source_intelligence_refs: input.ctx.agent.source_intelligence_refs || null,
        goal_mode_ref: input.ctx.agent.goal_mode_ref || null
      })
    }

	    const heartbeatSeen = await waitForWorkerHeartbeat(path.join(this.root, input.heartbeatRel), Number(process.env.SKS_ZELLIJ_WORKER_HEARTBEAT_TIMEOUT_MS || 5000))
	    if (heartbeatSeen) {
	      await this.telemetry(input.ctx, {
	        eventType: 'heartbeat',
	        status: 'running',
	        artifacts: [input.heartbeatRel],
	        logTail: await tailFile(path.join(this.root, input.heartbeatRel), 600)
	      })
	    } else {
	      input.record.warnings = [...(input.record.warnings || []), 'zellij_worker_heartbeat_missing_launch_warning']
	    }
    await appendJsonl(path.join(this.root, input.workerDirRel, 'zellij-worker-pane-events.jsonl'), {
      schema: 'sks.zellij-worker-pane-event.v1',
      ts: nowIso(),
      event_type: 'worker_started',
      mission_id: this.input.missionId,
      slot_id: slotId,
      generation_index: input.ctx.agent.generation_index || null,
      session_id: input.ctx.agent.session_id,
      worker_artifact_dir: input.workerDirRel
    })
    const parsed = await this.waitForWorkerResultWithActivity({
      resultPath: path.join(this.root, input.resultRel),
      activityPaths: [
        path.join(this.root, input.heartbeatRel),
        path.join(this.root, input.stdoutRel),
        path.join(this.root, input.stderrRel),
        path.join(this.root, input.workerDirRel, 'codex-sdk-events.jsonl'),
        path.join(this.root, input.workerDirRel, 'python-codex-sdk-events.jsonl'),
        path.join(this.root, input.workerDirRel, 'local-llm-events.jsonl')
      ],
      stdoutPath: path.join(this.root, input.stdoutRel),
      ctx: input.ctx,
      heartbeatRel: input.heartbeatRel,
      resultRel: input.resultRel,
      stdoutRel: input.stdoutRel,
      stderrRel: input.stderrRel
    })
    const compactExit = processRun ? await processRun.wait(parsed ? 10000 : 1000) : null
    this.active.delete(activeToken)
    input.record.closed_at = nowIso()
    const workerProcessReport = await readJson<any>(path.join(this.root, input.workerDirRel, 'worker-process-report.json'), null).catch(() => null)
    const sdkThreadId = workerProcessReport?.sdk_thread_id || workerProcessReport?.backend_router_report?.sdk_thread_id || parsed?.codex_sdk_thread?.sdk_thread_id || parsed?.codex_child_report?.sdk_thread_id || null
    const sdkRunId = workerProcessReport?.sdk_run_id || workerProcessReport?.backend_router_report?.sdk_run_id || parsed?.codex_sdk_thread?.sdk_run_id || parsed?.codex_child_report?.sdk_run_id || null
    if ((workerProcessReport?.backend_child_process_ids || []).length || sdkThreadId) {
      await appendJsonl(path.join(this.root, input.workerDirRel, 'zellij-worker-pane-events.jsonl'), {
        schema: 'sks.zellij-worker-pane-event.v1',
        ts: nowIso(),
        event_type: 'codex_sdk_thread_started',
        mission_id: this.input.missionId,
        slot_id: slotId,
        generation_index: input.ctx.agent.generation_index || null,
        session_id: input.ctx.agent.session_id,
        child_process_ids: workerProcessReport?.backend_child_process_ids || [],
        sdk_thread_id: sdkThreadId,
        sdk_run_id: sdkRunId
      })
    }
	    if (parsed) {
      await appendJsonl(path.join(this.root, input.workerDirRel, 'zellij-worker-pane-events.jsonl'), {
        schema: 'sks.zellij-worker-pane-event.v1',
        ts: nowIso(),
        event_type: 'result_written',
        mission_id: this.input.missionId,
        slot_id: slotId,
        generation_index: input.ctx.agent.generation_index || null,
        session_id: input.ctx.agent.session_id,
        result_path: input.resultRel
	      })
	      await this.telemetry(input.ctx, {
	        eventType: 'artifact_written',
	        status: 'verifying',
	        artifacts: [input.resultRel],
	        logTail: parsed.summary || 'worker result written'
	      })
	    }
    input.record.pid = Number(workerProcessReport?.pid || processRun?.pid) || null
    input.record.process_id = input.record.pid
    if (!loopHandle && input.record.pid) {
      loopHandle = await registerLoopWorkerHandle({
        root: input.ctx.opts.projectRoot || this.input.projectRoot || input.ctx.opts.cwd || packageRoot(),
        env: input.ctx.opts.env || {},
        agentId: String(input.ctx.agent.id || input.ctx.agent.session_id || 'agent'),
        sessionId: input.ctx.agent.session_id || null,
        pid: input.record.pid
      })
    }
    input.record.compact_worker_exit_code = compactExit?.code ?? null
    input.record.compact_worker_signal = compactExit?.signal ?? null
    input.record.sdk_thread_id = sdkThreadId
    input.record.sdk_run_id = sdkRunId
    input.record.stream_event_count = Number(workerProcessReport?.stream_event_count || workerProcessReport?.backend_router_report?.stream_event_count || 0)
    input.record.structured_output_valid = workerProcessReport?.structured_output_valid === true || workerProcessReport?.backend_router_report?.structured_output_valid === true
    input.record.exit_code = parsed ? (parsed.status === 'done' ? 0 : 1) : 1
    input.record.status = parsed?.status === 'done' ? 'closed' : 'failed'
    if (loopHandle) {
      await markLoopWorkerInterrupted(
        input.ctx.opts.projectRoot || this.input.projectRoot || input.ctx.opts.cwd || packageRoot(),
        loopHandle.mission_id,
        loopHandle.worker_id,
        input.record.status === 'closed' ? 'completed' : 'failed'
      ).catch(() => undefined)
    }
    const heartbeatOk = await hasHeartbeat(path.join(this.root, input.heartbeatRel))
	    input.record.blockers = [
      ...(parsed ? parsed.blockers || [] : ['zellij_worker_result_timeout']),
      ...(heartbeatOk ? [] : [])
	    ]
    if (!heartbeatOk) input.record.warnings = [...(input.record.warnings || []), 'zellij_worker_heartbeat_missing']
    paneRecord = await closeWorkerPane({
      root: this.root,
      paneRecord,
      cwd: workerCwd,
      projectRoot: input.ctx.opts.projectRoot || this.input.projectRoot || input.ctx.opts.cwd,
      status: input.record.status === 'closed' ? 'closed' : 'failed',
      blockers: input.record.blockers,
      sdkThreadId,
      sdkRunId,
      streamEventCount: input.record.stream_event_count,
      structuredOutputValid: input.record.structured_output_valid,
      workerResultPath: input.resultRel
    })
    input.record.zellij_worker_pane_closed_at = paneRecord.closed_at
	    await this.record(input.record)
	    if (!parsed) {
	      await this.telemetry(input.ctx, {
	        eventType: 'worker_failed',
	        status: 'failed',
	        artifacts: [input.stdoutRel, input.stderrRel, path.join(input.workerDirRel, 'zellij-worker-pane.json')],
	        blockers: input.record.blockers,
	        logTail: 'Zellij pane worker result timed out.'
	      })
	      return validateAgentWorkerResult({
        mission_id: this.input.missionId,
        agent_id: input.ctx.agent.id,
        session_id: input.ctx.agent.session_id,
        persona_id: input.ctx.agent.persona_id || input.ctx.agent.id,
        task_slice_id: input.ctx.slice?.id || '',
        status: 'failed',
        backend: this.input.backend,
        summary: 'Zellij pane worker result timed out.',
        artifacts: [input.stdoutRel, input.stderrRel, path.join(input.workerDirRel, 'zellij-worker-pane.json')],
        blockers: input.record.blockers,
        unverified: [],
        writes: [],
        source_intelligence_refs: input.ctx.agent.source_intelligence_refs || null,
        goal_mode_ref: input.ctx.agent.goal_mode_ref || null
      })
	    }
	    await this.telemetry(input.ctx, {
	      eventType: parsed.status === 'done' ? 'worker_completed' : 'worker_failed',
	      status: parsed.status === 'done' ? 'completed' : 'failed',
	      artifacts: [...new Set([...(Array.isArray(parsed.artifacts) ? parsed.artifacts : []), input.stdoutRel, input.stderrRel, path.join(input.workerDirRel, 'zellij-worker-pane.json')])],
	      blockers: input.record.blockers,
	      changedFiles: changedFilesFromWorkerResult(parsed),
	      logTail: parsed.summary || ''
	    })
	    return validateAgentWorkerResult({
      ...parsed,
      blockers: input.record.blockers,
      artifacts: [...new Set([...(Array.isArray(parsed.artifacts) ? parsed.artifacts : []), input.stdoutRel, input.stderrRel, path.join(input.workerDirRel, 'zellij-worker-pane.json')])]
    })
  }

  // Root-cause-2 fix: a fixed 2-minute wall-clock result timeout killed live codex-sdk
  // workers (real runs exceed 2 min), marking false zellij_worker_result_timeout failures and
  // freezing the UI while the worker kept running. Replace it with an activity-aware wait: keep
  // waiting as long as ANY worker artifact (heartbeat, stdout/stderr, sdk event jsonl) was touched
  // recently. Only give up after SKS_ZELLIJ_WORKER_INACTIVITY_TIMEOUT_MS of silence (default 5min)
  // OR an absolute cap SKS_ZELLIJ_WORKER_RESULT_TIMEOUT_MS (default 1h; 0 = no cap). While waiting,
  // emit a heartbeat telemetry event every ~10s so the SLOTS snapshot updated_at stays fresh from
  // the orchestrator side too.
  private async waitForWorkerResultWithActivity(input: {
    resultPath: string
    activityPaths: string[]
    stdoutPath: string
    ctx: { agent: any; slice: any; opts: any }
    heartbeatRel: string
    resultRel: string
    stdoutRel: string
    stderrRel: string
  }) {
    const inactivityTimeoutMs = Math.max(1000, Number(process.env.SKS_ZELLIJ_WORKER_INACTIVITY_TIMEOUT_MS || 300000))
    const absoluteCapRaw = Number(process.env.SKS_ZELLIJ_WORKER_RESULT_TIMEOUT_MS ?? 3600000)
    const absoluteCapMs = Number.isFinite(absoluteCapRaw) ? absoluteCapRaw : 3600000
    const start = Date.now()
    let lastActivityMs = start
    let lastHeartbeatEmit = 0
    for (;;) {
      if (input.ctx.opts?.signal?.aborted) return null
      const result = await readJson<any>(input.resultPath, null).catch(() => null)
      if (result) return result
      const now = Date.now()
      const newestActivity = await newestMtimeMs(input.activityPaths)
      if (newestActivity != null && newestActivity > lastActivityMs) lastActivityMs = newestActivity
      if (absoluteCapMs > 0 && now - start >= absoluteCapMs) return null
      if (now - lastActivityMs >= inactivityTimeoutMs) return null
      if (now - lastHeartbeatEmit >= 10000) {
        lastHeartbeatEmit = now
        await this.telemetry(input.ctx, {
          eventType: 'heartbeat',
          status: 'running',
          artifacts: [input.heartbeatRel, input.resultRel, input.stdoutRel, input.stderrRel],
          logTail: await tailFile(input.stdoutPath, 600)
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
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

	  private async telemetry(ctx: { agent: any; slice: any; opts: any }, input: {
	    eventType: ZellijSlotTelemetryEventType
	    status: ZellijSlotTelemetryStatus
	    artifacts?: string[]
	    blockers?: string[]
	    changedFiles?: string[]
	    logTail?: string
	  }) {
	    await appendZellijSlotTelemetry(this.root, {
	      schema: 'sks.zellij-slot-telemetry-event.v1',
	      ts: nowIso(),
	      mission_id: this.input.missionId,
	      slot_id: String(ctx.agent?.slot_id || ctx.agent?.id || 'slot-001'),
	      generation_index: Number(ctx.agent?.generation_index || 1),
	      worker_id: String(ctx.agent?.id || ctx.agent?.slot_id || 'worker'),
	      event_type: input.eventType,
	      status: input.status,
	      role: String(ctx.agent?.naruto_role || ctx.agent?.role || ctx.agent?.persona_id || ctx.agent?.id || 'worker'),
	      backend: this.input.backend,
	      service_tier: this.input.fastModePolicy.service_tier,
	      worktree_id: ctx.agent?.worktree?.id || ctx.slice?.worktree?.id || null,
	      worktree_path: ctx.agent?.worktree?.path || ctx.slice?.worktree?.path || null,
	      task_title: String(ctx.slice?.description || ctx.slice?.title || ctx.slice?.id || 'worker task'),
	      current_file: firstString([ctx.slice?.write_paths?.[0], ctx.slice?.readonly_paths?.[0], ctx.slice?.input_files?.[0]]) || null,
	      artifact_paths: input.artifacts || [],
	      log_tail: input.logTail || '',
	      blockers: input.blockers || []
	    }).catch(() => undefined)
	    if (input.eventType === 'worker_completed' || input.eventType === 'worker_failed') {
	      await appendAgentMessage(this.root, {
	        from: String(ctx.agent?.slot_id || ctx.agent?.id || 'worker'),
	        session_id: ctx.agent?.session_id == null ? '' : String(ctx.agent.session_id),
	        to: 'orchestrator',
	        type: input.eventType,
	        body: input.logTail || input.eventType
	      }).catch(() => undefined)
	    }
	    const parallelEvent = mapTelemetryToParallelEvent(input.eventType)
	    if (parallelEvent) {
	      await appendParallelRuntimeEvent(this.root, this.input.missionId, {
	        event_type: parallelEvent,
	        slot_id: String(ctx.agent?.slot_id || ctx.agent?.id || 'slot-001'),
	        generation_index: Number(ctx.agent?.generation_index || 1),
	        session_id: ctx.agent?.session_id == null ? null : String(ctx.agent.session_id),
	        pid: null,
	        backend: this.input.backend,
	        placement: normalizeParallelPlacement(ctx.opts?.workerPlacement || this.input.workerPlacement || (input.status === 'headless' ? 'headless' : 'unknown')),
	        worktree_id: ctx.agent?.worktree?.id || ctx.slice?.worktree?.id || null,
	        meta: {
	          status: input.status,
	          artifacts: input.artifacts || [],
	          changed_files: input.changedFiles || [],
	          blockers: input.blockers || []
	        }
	      }).catch(() => undefined)
	    }
	  }

  private async persist() {
    this.writeLock = this.writeLock.catch(() => undefined).then(async () => {
      await writeJsonAtomic(path.join(this.root, 'native-cli-worker-runtime.json'), this.summary())
    })
    await this.writeLock
  }

  private summary() {
    const closed = this.records.filter((row) => row.status === 'closed')
    const processIds = this.records.map((row) => row.pid).filter((pid) => Number.isFinite(Number(pid)))
    // Both pane-backed primitives count as zellij pane worker sessions: the
    // worker command can run inside the pane (full-debug) or headless behind a
    // live slot renderer pane (compact-slots default). Counting only the
    // former under-reported pane sessions as 0 in the default UI mode.
    const paneBackedRecords = this.records.filter((row) =>
      row.scaling_primitive === 'native_cli_process_in_zellij_worker_pane'
      || row.scaling_primitive === 'native_cli_process_with_zellij_slot_renderer')
    return {
      schema: NATIVE_CLI_WORKER_RUNTIME_SCHEMA,
      generated_at: nowIso(),
      ok: this.records.every((row) => row.status === 'closed'),
      mission_id: this.input.missionId,
      route: this.input.route,
      backend: this.input.backend,
      scaling_primitive: this.records.some((row) => row.scaling_primitive === 'native_cli_process_in_zellij_worker_pane')
        ? 'native_cli_process_in_zellij_worker_pane'
        : paneBackedRecords.length
          ? 'native_cli_process_with_zellij_slot_renderer'
          : 'native_cli_process',
      zellij_pane_worker_sessions: paneBackedRecords.length,
      requested_agents: this.input.requestedAgents,
      target_active_slots: this.input.targetActiveSlots,
      spawned_worker_process_count: this.records.length,
      closed_worker_process_count: closed.length,
      max_observed_worker_process_count: this.maxObserved,
      active_worker_process_count: this.active.size,
      visible_zellij_pane_cap: this.input.zellijVisiblePaneCap || null,
      headless_overflow_worker_count: this.records.filter((row) => row.worker_placement === 'headless').length,
      unique_worker_session_count: new Set(this.records.map((row) => row.session_id).filter(Boolean)).size,
      unique_slot_count: new Set(this.records.map((row) => row.slot_id).filter(Boolean)).size,
      unique_generation_count: new Set(this.records.map((row) => `${row.slot_id}:${row.generation_index}`).filter(Boolean)).size,
      process_ids: processIds,
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

  private zellijVisiblePaneCap(opts: any = {}) {
    const raw = Number(opts.zellijVisiblePaneCap || this.input.zellijVisiblePaneCap || this.input.targetActiveSlots || 1)
    return Math.max(1, Math.floor(Number.isFinite(raw) ? raw : 1))
  }

  private async spawnCompactSlotWorkerProcess(input: {
    args: string[]
    cwd: string
    env: Record<string, unknown>
    stdoutRel: string
    stderrRel: string
    signal?: AbortSignal
  }) {
    const stdout = fs.createWriteStream(path.join(this.root, input.stdoutRel), { flags: 'a' })
    const stderr = fs.createWriteStream(path.join(this.root, input.stderrRel), { flags: 'a' })
    const child = spawn(process.execPath, input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(input.env).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]))
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const removeAbortListener = terminateChildOnAbort(child, input.signal)
    child.stdout?.pipe(stdout)
    child.stderr?.pipe(stderr)
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, signal) => {
        removeAbortListener()
        stdout.end()
        stderr.end()
        resolve({ code, signal })
      })
      child.on('error', () => {
        removeAbortListener()
        stdout.end()
        stderr.end()
        resolve({ code: 1, signal: null })
      })
    })
    return {
      pid: child.pid || null,
      wait: async (timeoutMs: number) => waitForChildExit(child, exitPromise, timeoutMs)
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

export function buildPaneWorkerCommand(input: { args: string[]; stdoutPath: string; stderrPath: string; heartbeatPath: string; env: Record<string, unknown>; header?: string }) {
  const envPrefix = Object.entries(input.env)
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value != null)
    .map(([key, value]) => `export ${key}=${shellQuote(String(value))};`)
    .sort()
  const command = [shellQuote(process.execPath), ...input.args.map(shellQuote)].join(' ')
  const heartbeat = `printf '%s\\n' ${shellQuote(JSON.stringify({ schema: 'sks.zellij-worker-pane-event.v1', event: 'worker_command_exited' }))} >> ${shellQuote(input.heartbeatPath)}`
  const holdMs = Math.max(0, Number(process.env.SKS_ZELLIJ_WORKER_PANE_HOLD_MS || 1500))
  const hold = holdMs > 0 ? `sleep ${shellQuote(String(Math.min(30, holdMs / 1000)))}` : ':'
  const header = input.header ? `printf '%s\\n' ${shellQuote(input.header)} | tee -a ${shellQuote(input.stdoutPath)};` : ''
  const exitPath = `${input.heartbeatPath}.exit`
  const visibleCommand = `(${command}; printf '%s' "$?" > ${shellQuote(exitPath)}) 2>&1 | tee -a ${shellQuote(input.stdoutPath)}`
  const readExit = `code=$(cat ${shellQuote(exitPath)} 2>/dev/null || printf '1'); rm -f ${shellQuote(exitPath)}`
  return `${envPrefix.join(' ')} ${header} ${visibleCommand}; ${readExit}; ${heartbeat}; ${hold}; exit $code`.trim()
}

function buildPaneWorkerHeader(input: {
  slotId: string
  generationIndex: number
  role: string
  backend: string
  provider: string
  serviceTier: string
  worktree: ReturnType<typeof normalizeWorkerWorktree>
  task: string
}) {
  return [
    'SKS Worker',
    `slot: ${input.slotId} gen: ${input.generationIndex} role: ${input.role}`,
    `backend: ${input.backend} provider: ${input.provider} service: ${input.serviceTier}`,
    `worktree: ${input.worktree ? `${input.worktree.id} branch: ${input.worktree.branch}` : '-'}`,
    `task: ${String(input.task || '').slice(0, 160)}`,
    'status: running'
  ].join('\n')
}

async function newestMtimeMs(files: string[]): Promise<number | null> {
  let newest: number | null = null
  for (const file of files) {
    try {
      const mtime = (await fs.promises.stat(file)).mtimeMs
      if (newest == null || mtime > newest) newest = mtime
    } catch {
      // missing file: no activity signal from it
    }
  }
  return newest
}

async function waitForWorkerHeartbeat(file: string, timeoutMs: number) {
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  while (Date.now() < deadline) {
    if (await hasHeartbeat(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function hasHeartbeat(file: string) {
  try {
    const text = await fs.promises.readFile(file, 'utf8')
    return text.trim().length > 0
  } catch {
    return false
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

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function normalizeWorkerWorktree(value: any): {
  id: string
  path: string
  branch: string
  main_repo_root: string | null
} | null {
  const pathValue = value?.path || value?.worktree_path
  if (!pathValue) return null
  return {
    id: String(value?.id || value?.worktree_id || value?.slot_id || 'worktree'),
    path: String(pathValue),
    branch: String(value?.branch || 'unknown'),
    main_repo_root: value?.main_repo_root == null ? null : String(value.main_repo_root)
  }
}

function firstString(values: unknown[]) {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return null
}

function mapTelemetryToParallelEvent(eventType: ZellijSlotTelemetryEventType) {
  if (eventType === 'slot_reserved') return 'slot_reserved'
  if (eventType === 'heartbeat') return 'worker_heartbeat_seen'
  if (eventType === 'worker_completed') return 'worker_completed'
  if (eventType === 'worker_failed') return 'worker_failed'
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

function normalizeParallelPlacement(value: unknown) {
  const text = String(value || '')
  if (text === 'zellij-pane' || text === 'process' || text === 'headless' || text === 'headless_by_design_viewport_ui') return text
  return 'unknown'
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

async function tailFile(file: string, max: number) {
  try {
    const text = await fs.promises.readFile(file, 'utf8')
    return text.length > max ? text.slice(-max) : text
  } catch {
    return ''
  }
}

async function waitForChildExit(child: ReturnType<typeof spawn>, exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>, timeoutMs: number) {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    timer = setTimeout(() => {
      if (!child.killed) child.kill()
      resolve({ code: null, signal: 'SIGTERM' })
    }, Math.max(1000, timeoutMs))
  })
  const result = await Promise.race([exitPromise, timeout])
  if (timer) clearTimeout(timer)
  return result
}
