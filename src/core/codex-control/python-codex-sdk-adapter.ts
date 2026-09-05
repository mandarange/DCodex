import { spawn } from 'node:child_process'
import path from 'node:path'
import { packageRoot, randomId, registerDetachedProcessGroup, runProcess, which } from '../fsx.js'
import type { CodexTaskInput } from './codex-control-plane.js'
import { translatePythonCodexSdkEvents } from './python-codex-sdk-event-translator.js'
import { normalizeAstraSdkEffort } from './codex-sdk-config-policy.js'

export async function detectPythonCodexSdkCapability() {
  const python = await resolvePythonCodexSdkPython()
  if (!python.path) return capability(false, null, '', ['python_missing'], null, 'Install Python >= 3.10 and install the Codex Python SDK.')
  const pyOk = parsePythonVersion(python.versionText) >= 3.10
  const probes: Array<Record<string, unknown>> = []
  let detected: PythonCodexSdkCandidate | null = null
  let detectedModulePath = ''
  let detectedModuleParentPath = ''
  if (pyOk) {
    for (const candidate of PYTHON_CODEX_SDK_CANDIDATES) {
      const importProbe = await runProcess(python.path, ['-c', `import ${candidate.importName} as m, os; print(os.path.dirname(os.path.abspath(getattr(m, "__file__", ""))))`], { timeoutMs: 5000, maxOutputBytes: 4096 })
        .catch((err: any) => ({ code: 1, stdout: '', stderr: err.message || String(err) }))
      const modulePath = String(importProbe.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || ''
      probes.push({
        package_name: candidate.packageName,
        import_name: candidate.importName,
        ok: importProbe.code === 0,
        module_path: modulePath || null,
        stderr: String(importProbe.stderr || '').slice(-500)
      })
      if (importProbe.code === 0) {
        detected = candidate
        detectedModulePath = modulePath
        detectedModuleParentPath = modulePath ? path.dirname(modulePath) : ''
        break
      }
    }
  }
  const blockers = [
    ...(pyOk ? [] : ['python_version_below_3_10']),
    ...(detected ? [] : ['python_codex_sdk_unavailable'])
  ]
  return capability(
    blockers.length === 0,
    python.path,
    python.versionText,
    blockers,
    detected,
    blockers.length ? setupAction(python.path) : null,
    probes,
    detectedModulePath,
    detectedModuleParentPath
  )
}

export async function runPythonCodexSdkTask(input: CodexTaskInput, opts: {
  pythonBin?: string | null
  env?: Record<string, string>
  config?: Record<string, unknown>
} = {}) {
  const cap = await detectPythonCodexSdkCapability()
  if (!cap.ok && process.env.SKS_PYTHON_CODEX_SDK_FAKE !== '1') {
    return { ok: false, events: [], translatedEvents: [], finalResponse: '', blockers: cap.blockers, capability: cap }
  }
  const python = opts.pythonBin || cap.python_bin || await which('python3') || 'python3'
  const sessionId = input.sessionId || `sks-${randomId(12)}`
  const config = opts.config || {}
  const model = typeof config.model === 'string' ? config.model : ''
  const request = {
    schema: 'sks.python-codex-sdk-request.v1',
    session_id: sessionId,
    route: input.route,
    thread_policy: input.requestedScopeContract?.resume_thread_id ? 'resume' : 'new',
    sandbox: mapSandbox(input.sandboxPolicy),
    cwd: input.cwd,
    model,
    model_reasoning_effort: normalizeAstraSdkEffort(model, typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : 'minimal'),
    prompt: input.prompt,
    output_schema: input.outputSchema || {}
  }
  const timeoutMs = pythonCodexSdkTimeoutMs(input)
  if (timeoutMs <= 0) {
    return {
      ok: false,
      events: [{ event: 'error', retryable: false, message: 'python_codex_sdk_hard_deadline_exceeded' }],
      translatedEvents: [],
      finalResponse: '',
      threadId: '',
      sessionId,
      turnId: '',
      blockers: ['python_codex_sdk_hard_deadline_exceeded'],
      capability: cap
    }
  }
  const events = await runPythonRunner(python, request, pythonRunnerEnv(opts.env, cap.module_parent_path), timeoutMs)
  const translatedEvents = translatePythonCodexSdkEvents(events)
  const last = [...events].reverse().find((event: any) => event?.event === 'turn_completed') as any
  const errors = events.filter((event: any) => event?.event === 'error').map((event: any) => String(event.message || 'python_codex_sdk_error'))
  return {
    ok: errors.length === 0 && Boolean(last),
    events,
    translatedEvents,
    finalResponse: String(last?.final_response || ''),
    threadId: String(events.find((event: any) => event?.thread_id)?.thread_id || ''),
    sessionId,
    turnId: String(last?.turn_id || ''),
    blockers: errors,
    capability: cap
  }
}

function pythonRunnerEnv(envOverride: Record<string, string> | undefined, moduleParentPath: unknown) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(envOverride || {})) {
    if (value !== undefined) env[key] = String(value)
  }
  if (process.env.SKS_PYTHON_CODEX_SDK_FAKE === '1' && env.SKS_PYTHON_CODEX_SDK_FAKE === undefined) {
    env.SKS_PYTHON_CODEX_SDK_FAKE = '1'
  }
  const parent = String(moduleParentPath || '').trim()
  if (!parent) return env
  env.PYTHONPATH = prependPath(env.PYTHONPATH, parent)
  return env
}

function prependPath(value: string | undefined, entry: string) {
  const parts = String(value || '').split(path.delimiter).filter(Boolean)
  return [entry, ...parts.filter((part) => part !== entry)].join(path.delimiter)
}

export function runPythonRunner(
  python: string,
  request: unknown,
  envOverride: Record<string, string> | undefined,
  timeoutMs: number,
  forceKillDelayMs = 5000
): Promise<any[]> {
  const runner = path.join(packageRoot(), 'pytools', 'codex_sdk_runner.py')
  return new Promise((resolve, reject) => {
    const child = spawn(python, [runner], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: envOverride || {},
      detached: process.platform !== 'win32'
    })
    const unregisterDetachedProcessGroup = registerDetachedProcessGroup(child)
    const events: any[] = []
    let stderr = ''
    let timedOut = false
    let settled = false
    let cancelForceKill = () => {}
    const cleanupLifecycle = () => {
      clearTimeout(timer)
      cancelForceKill()
      unregisterDetachedProcessGroup()
    }
    const timer = setTimeout(() => {
      timedOut = true
      events.push({ event: 'error', retryable: true, message: `python_codex_sdk_timeout:${timeoutMs}` })
      cancelForceKill = terminatePythonRunner(child, forceKillDelayMs)
    }, timeoutMs)
    timer.unref?.()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split(/\n/).filter(Boolean)) {
        try {
          events.push(JSON.parse(line))
        } catch {
          events.push({ event: 'error', retryable: false, message: `invalid_python_jsonl:${line.slice(0, 200)}` })
        }
      }
    })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      cleanupLifecycle()
      reject(error)
    })
    child.once('close', () => {
      if (settled) return
      settled = true
      cleanupLifecycle()
      if (stderr.trim()) events.push({ event: 'stderr', message: stderr.slice(-1000) })
      if (timedOut && !events.some((event) => String(event?.message || '').startsWith('python_codex_sdk_timeout:'))) {
        events.push({ event: 'error', retryable: true, message: `python_codex_sdk_timeout:${timeoutMs}` })
      }
      resolve(events)
    })
    child.stdin.end(JSON.stringify(request))
  })
}

export function pythonCodexSdkTimeoutMs(input: CodexTaskInput, nowMs = Date.now()): number {
  const configured = Number(process.env.SKS_PYTHON_CODEX_SDK_TIMEOUT_MS || 120000)
  const base = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 120000
  const hard = positiveFinite(input.reliabilityPolicy?.hardTimeoutMs)
  const deadline = positiveFinite(input.reliabilityPolicy?.deadlineEpochMs)
  const remaining = deadline === null ? null : Math.floor(deadline - nowMs)
  if (remaining !== null && remaining <= 0) return 0
  return Math.max(1, Math.floor(Math.min(base, hard ?? Number.POSITIVE_INFINITY, remaining ?? Number.POSITIVE_INFINITY)))
}

function positiveFinite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function terminatePythonRunner(child: ReturnType<typeof spawn>, forceKillDelayMs: number): () => void {
  const pid = child.pid
  if (!pid) return () => {}
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM')
    else child.kill('SIGTERM')
  } catch {
    try { child.kill('SIGTERM') } catch {}
  }
  const forceKillTimer = setTimeout(() => {
    try {
      if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch {}
  }, forceKillDelayMs)
  forceKillTimer.unref?.()
  return () => clearTimeout(forceKillTimer)
}

function mapSandbox(value: string) {
  if (value === 'workspace-write') return 'workspace_write'
  if (value === 'full-access') return 'full_access'
  return 'read_only'
}

function parsePythonVersion(text: string) {
  const match = text.match(/Python\s+(\d+)\.(\d+)/i)
  return match ? Number(`${match[1]}.${match[2]}`) : 0
}

async function resolvePythonCodexSdkPython() {
  const requested = [
    process.env.SKS_PYTHON_CODEX_SDK_PYTHON,
    process.env.PYTHON
  ].filter((value): value is string => Boolean(value && value.trim()))
  const candidates = [...requested, 'python3.12', 'python3.11', 'python3.10', 'python3', 'python']
  const seen = new Set<string>()
  const probes: Array<{ path: string, versionText: string, score: number }> = []
  for (const candidate of candidates) {
    const resolved = candidate.includes('/') ? candidate : await which(candidate)
    if (!resolved || seen.has(resolved)) continue
    seen.add(resolved)
    const version = await runProcess(resolved, ['--version'], { timeoutMs: 5000, maxOutputBytes: 4096 })
      .catch((err: any) => ({ code: 1, stdout: '', stderr: err.message || String(err) }))
    const versionText = `${version.stdout || ''}${version.stderr || ''}`.trim()
    probes.push({ path: resolved, versionText, score: parsePythonVersion(versionText) })
  }
  const supported = probes.find((probe) => probe.score >= 3.10)
  return supported || probes[0] || { path: null, versionText: '' }
}

interface PythonCodexSdkCandidate {
  packageName: string
  importName: string
  source: string
}

const PYTHON_CODEX_SDK_CANDIDATES: PythonCodexSdkCandidate[] = [
  { packageName: 'codex-app-server', importName: 'codex_app_server', source: 'developers.openai.com/codex/sdk' },
  { packageName: 'openai-codex', importName: 'openai_codex', source: 'sks-2.0.5-directive' },
  { packageName: 'openai-codex-sdk', importName: 'openai_codex_sdk', source: 'pypi-wheel' }
]

function setupAction(pythonBin: string) {
  return [
    `Install the current Codex Python SDK in \`${pythonBin}\`.`,
    'Preferred official source install: from the Codex repository root run `cd sdk/python && python -m pip install -e .`.',
    `If using the published wrapper package, run \`${pythonBin} -m pip install openai-codex-sdk\`.`,
    `If your environment provides the directive package, run \`${pythonBin} -m pip install openai-codex\`.`
  ].join(' ')
}

function capability(
  ok: boolean,
  pythonBin: string | null,
  versionText: string,
  blockers: string[],
  detected: PythonCodexSdkCandidate | null,
  setupActionValue: string | null,
  probes: Array<Record<string, unknown>> = [],
  modulePath = '',
  moduleParentPath = ''
) {
  const selected = detected || PYTHON_CODEX_SDK_CANDIDATES[0] || { packageName: 'codex-app-server', importName: 'codex_app_server', source: 'developers.openai.com/codex/sdk' }
  return {
    schema: 'sks.python-codex-sdk-capability.v1',
    ok,
    python_bin: pythonBin,
    python_version: versionText,
    package_name: selected.packageName,
    import_name: selected.importName,
    source: selected.source,
    supported_packages: PYTHON_CODEX_SDK_CANDIDATES.map((candidate) => candidate.packageName),
    supported_imports: PYTHON_CODEX_SDK_CANDIDATES.map((candidate) => candidate.importName),
    module_path: modulePath || null,
    module_parent_path: moduleParentPath || null,
    import_probes: probes,
    setup_action: setupActionValue,
    blockers
  }
}
