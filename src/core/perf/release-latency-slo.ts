import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { loadNativeMenuBarSources } from '../codex-app/menubar/resources.js'
import { runProcess, writeJsonAtomic } from '../fsx.js'
import { listMcpInventory, type CodexMcpCliPort } from '../mcp-config/index.js'
import { RemoteSshWorkerClient } from '../remote/ssh-worker-client.js'
import type { RemoteMachineV1 } from '../remote/types.js'
import { emptyUpdateStatus, readUpdateStatusCache } from '../update/update-status.js'

export const RELEASE_LATENCY_LIMITS = {
  menubar_first_state_render: 250,
  control_center_open: 400,
  mcp_static_list: 250,
  update_cache_read: 50,
  ssh_worker_hello: 3000
} as const

export type ReleaseLatencySloId = keyof typeof RELEASE_LATENCY_LIMITS
export interface ReleaseLatencyBudget { id: ReleaseLatencySloId; budget_p95_ms: number; measured_runs?: number }
export interface ReleaseLatencyMeasurement {
  id: ReleaseLatencySloId
  budget_p95_ms: number
  producer: string
  status: 'measured' | 'not_measured_platform' | 'producer_failed'
  samples_ms: number[]
  p50_ms: number | null
  p95_ms: number | null
  ok: boolean | null
  evidence: Record<string, unknown>
  blocker: string | null
}

export interface ReleaseLatencySloReport {
  schema: 'sks.release-latency-slo.v1'
  ok: boolean
  complete: boolean
  generated_at: string
  platform: NodeJS.Platform
  measurements: ReleaseLatencyMeasurement[]
  blockers: string[]
}

export async function runReleaseLatencySlo(
  root: string,
  budgets: readonly ReleaseLatencyBudget[],
  options: { platform?: NodeJS.Platform } = {}
): Promise<ReleaseLatencySloReport> {
  const platform = options.platform ?? process.platform
  const budgetMap = new Map(budgets.map((row) => [row.id, row]))
  const blockers = Object.entries(RELEASE_LATENCY_LIMITS).flatMap(([id, limit]) => {
    const budget = budgetMap.get(id as ReleaseLatencySloId)
    return budget?.budget_p95_ms === limit ? [] : [`release_latency_budget_missing_or_changed:${id}`]
  })
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-release-latency-'))
  let measurements: ReleaseLatencyMeasurement[] = []
  try {
    const portable = [
      await capture('mcp_static_list', budgetMap, () => measureMcpStaticList(tmp, runs(budgetMap, 'mcp_static_list', 9))),
      await capture('update_cache_read', budgetMap, () => measureUpdateCacheRead(tmp, runs(budgetMap, 'update_cache_read', 15))),
      await capture('ssh_worker_hello', budgetMap, () => measureSshHello(tmp, runs(budgetMap, 'ssh_worker_hello', 5)))
    ]
    const native = platform === 'darwin'
      ? await measureNativeMenuBar(tmp, budgetMap).catch((error) => nativeFailureMeasurements(budgetMap, error))
      : (['menubar_first_state_render', 'control_center_open'] as ReleaseLatencySloId[]).map((id) => ({
          id,
          budget_p95_ms: budgetMap.get(id)?.budget_p95_ms ?? RELEASE_LATENCY_LIMITS[id],
          producer: 'native_appkit_runtime',
          status: 'not_measured_platform' as const,
          samples_ms: [], p50_ms: null, p95_ms: null, ok: null,
          evidence: { required_platform: 'darwin', observed_platform: platform },
          blocker: null
        }))
    measurements = [...native, ...portable]
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
  blockers.push(...measurements.flatMap((row) => row.blocker ? [row.blocker] : []))
  const report: ReleaseLatencySloReport = {
    schema: 'sks.release-latency-slo.v1',
    ok: blockers.length === 0,
    complete: measurements.every((row) => row.status === 'measured'),
    generated_at: new Date().toISOString(),
    platform,
    measurements,
    blockers: [...new Set(blockers)]
  }
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'release-latency-slo.json'), report)
  return report
}

export function evaluateLatencySamples(
  id: ReleaseLatencySloId,
  budgetMs: number,
  producer: string,
  samples: readonly number[],
  evidence: Record<string, unknown> = {}
): ReleaseLatencyMeasurement {
  const values = samples.map((value) => round(value)).sort((a, b) => a - b)
  const p50 = percentile(values, 0.5)
  const p95 = percentile(values, 0.95)
  const ok = values.length > 0 && p95 < budgetMs
  return {
    id, budget_p95_ms: budgetMs, producer,
    status: values.length ? 'measured' : 'producer_failed',
    samples_ms: values, p50_ms: values.length ? p50 : null, p95_ms: values.length ? p95 : null, ok,
    evidence,
    blocker: ok ? null : values.length ? `release_latency_slo_exceeded:${id}` : `release_latency_producer_failed:${id}`
  }
}

async function capture(
  id: ReleaseLatencySloId,
  budgets: Map<ReleaseLatencySloId, ReleaseLatencyBudget>,
  producer: () => Promise<{ producer: string; samples: number[]; evidence?: Record<string, unknown> }>
): Promise<ReleaseLatencyMeasurement> {
  const budget = budgets.get(id)?.budget_p95_ms ?? RELEASE_LATENCY_LIMITS[id]
  try {
    const result = await producer()
    return evaluateLatencySamples(id, budget, result.producer, result.samples, result.evidence)
  } catch (error) {
    return {
      id, budget_p95_ms: budget, producer: 'unavailable', status: 'producer_failed', samples_ms: [],
      p50_ms: null, p95_ms: null, ok: false,
      evidence: { error: publicError(error) }, blocker: `release_latency_producer_failed:${id}`
    }
  }
}

async function measureMcpStaticList(tmp: string, count: number) {
  const home = path.join(tmp, 'mcp-home')
  const config = path.join(home, '.codex', 'config.toml')
  await fs.mkdir(path.dirname(config), { recursive: true })
  const serverCount = 24
  await fs.writeFile(config, Array.from({ length: serverCount }, (_, index) => [
    `[mcp_servers.server_${index}]`, 'command = "node"', `args = ["server-${index}.js"]`, ''
  ].join('\n')).join('\n'), { mode: 0o600 })
  const cli = unavailableMcpCli()
  const read = async () => {
    const result = await listMcpInventory('global', { home, cli })
    if (!result.ok || result.server_count !== serverCount || result.source !== 'config_toml_static') throw new Error('mcp_static_inventory_invalid')
  }
  await read()
  return { producer: 'listMcpInventory:config_toml_static', samples: await samples(count, read), evidence: { server_count: serverCount, network_included: false } }
}

async function measureUpdateCacheRead(tmp: string, count: number) {
  const cache = path.join(tmp, 'update-status.json')
  const now = new Date()
  const snapshot = emptyUpdateStatus('6.3.0', now)
  snapshot.expires_at = new Date(now.getTime() + 60_000).toISOString()
  snapshot.source = 'cache'
  await fs.writeFile(cache, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
  const env = { SKS_UPDATE_STATUS_PATH: cache }
  const read = async () => { if (!(await readUpdateStatusCache(env))) throw new Error('update_cache_unreadable') }
  await read()
  return { producer: 'readUpdateStatusCache:v3', samples: await samples(count, read), evidence: { cache_bytes: Buffer.byteLength(JSON.stringify(snapshot)), network_included: false } }
}

async function measureSshHello(tmp: string, count: number) {
  const worker = path.join(tmp, 'ssh-worker-fixture.mjs')
  await fs.writeFile(worker, [
    "import readline from 'node:readline'",
    "const lines=readline.createInterface({input:process.stdin})",
    "lines.on('line',(line)=>{const request=JSON.parse(line);process.stdout.write(JSON.stringify({schema:'sks.remote-worker.response.v1',id:request.id,type:request.type,ok:true,data:{protocol:'jsonl-stdio'}})+'\\n')})"
  ].join('\n'), { mode: 0o600 })
  const projectRoot = path.join(tmp, 'remote-project')
  await fs.mkdir(projectRoot, { recursive: true })
  const machine: RemoteMachineV1 = { id: 'local', display_name: 'Local', transport: 'ssh-stdio', ssh_alias: 'local-sks', allowed_roots: [tmp], enabled: true }
  const values: number[] = []
  for (let index = 0; index < count; index += 1) {
    const client = new RemoteSshWorkerClient({
      machine, projectRoot, projectId: 'latency-probe', reconnectAttempts: 1, requestTimeoutMs: 5_000,
      loadSshConfig: async () => 'hostname localhost\nstricthostkeychecking yes\nuserknownhostsfile /tmp/sks-known-hosts',
      spawnProcess: () => spawn(process.execPath, [worker], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    })
    const started = performance.now()
    await client.connect()
    values.push(performance.now() - started)
    await client.close()
  }
  return { producer: 'RemoteSshWorkerClient.connect:local_stdio_child', samples: values, evidence: { transport: 'local_process_ssh_stdio_fixture', network_included: false, process_startup_included: true } }
}

async function measureNativeMenuBar(
  tmp: string,
  budgets: Map<ReleaseLatencySloId, ReleaseLatencyBudget>
): Promise<ReleaseLatencyMeasurement[]> {
  const sourceDir = path.join(tmp, 'native-sources')
  const executable = path.join(tmp, 'sks-menubar-latency')
  const home = path.join(tmp, 'native-home')
  await Promise.all([sourceDir, home].map((dir) => fs.mkdir(dir, { recursive: true })))
  const cache = path.join(home, '.sneakoscope-global', 'cache', 'update-status.json')
  const cacheSnapshot = emptyUpdateStatus('6.3.0', new Date())
  cacheSnapshot.source = 'cache'
  cacheSnapshot.expires_at = new Date(Date.now() + 60_000).toISOString()
  await fs.mkdir(path.dirname(cache), { recursive: true })
  await fs.writeFile(cache, `${JSON.stringify(cacheSnapshot)}\n`, { mode: 0o600 })
  await fs.writeFile(path.join(home, 'build-stamp.json'), '{}\n', { mode: 0o600 })
  const sources = loadNativeMenuBarSources({
    actionScriptPath: '/usr/bin/true', projectRootPath: tmp, buildStampPath: path.join(home, 'build-stamp.json'),
    configPath: path.join(home, 'config.json'), lastActionLogPath: path.join(home, 'last.log'),
    operationDirPath: path.join(home, 'operations'), codexBundleId: null, packageVersion: '6.3.0'
  })
  const marker = '\nlet application = NSApplication.shared'
  for (const source of sources) {
    let content = source.content
    if (source.name === 'main.swift') {
      const index = content.indexOf(marker)
      if (index < 0) throw new Error('menubar_main_marker_missing')
      content = `${content.slice(0, index)}\n${nativeHarnessSource()}`
    }
    await fs.writeFile(path.join(sourceDir, source.name), content, { mode: 0o600 })
  }
  const files = sources.map((source) => path.join(sourceDir, source.name))
  const compileStarted = performance.now()
  const compile = await runProcess('swiftc', ['-framework', 'Cocoa', '-framework', 'UserNotifications', ...files, '-o', executable], {
    cwd: tmp, timeoutMs: 90_000, maxOutputBytes: 128 * 1024
  })
  const compileMs = round(performance.now() - compileStarted)
  if (compile.code !== 0) throw new Error(`menubar_latency_compile_failed:${compile.stderr.slice(-400)}`)
  const nativeRuns = Math.max(runs(budgets, 'menubar_first_state_render', 5), runs(budgets, 'control_center_open', 5))
  const first: number[] = []
  const control: number[] = []
  const exitCodes: Array<number | null> = []
  for (let index = 0; index < nativeRuns; index += 1) {
    const result = await runProcess(executable, [], { cwd: tmp, env: { HOME: home }, timeoutMs: 15_000, maxOutputBytes: 64 * 1024 })
    exitCodes.push(result.code)
    const parsed = parseJson(result.stdout)
    if (result.code !== 0 || !Number.isFinite(parsed?.menu_bar_first_state_render_ms) || !Number.isFinite(parsed?.control_center_open_ms)) {
      throw new Error(`menubar_latency_run_failed:${result.code}:${result.stderr.slice(-300)}`)
    }
    first.push(Number(parsed.menu_bar_first_state_render_ms))
    control.push(Number(parsed.control_center_open_ms))
  }
  const evidence = {
    source_count: sources.length, compile_exit_code: compile.code, compile_duration_ms: compileMs,
    link_frameworks: ['Cocoa', 'UserNotifications'], run_exit_codes: exitCodes,
    cache_based: true, cache_bytes: Buffer.byteLength(JSON.stringify(cacheSnapshot)), controller_prebuilt: true
  }
  return [
    evaluateLatencySamples('menubar_first_state_render', budgets.get('menubar_first_state_render')?.budget_p95_ms ?? 250, 'StatusItemController.start:cache_state_render', first, evidence),
    evaluateLatencySamples('control_center_open', budgets.get('control_center_open')?.budget_p95_ms ?? 400, 'ControlCenterWindowController.show:overview', control, evidence)
  ]
}

function nativeHarnessSource(): string {
  return `let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let processClient = ProcessClient(actionScript: AppRuntime.actionScript, logPath: AppRuntime.lastActionLogPath, projectRoot: AppRuntime.projectRoot)
let operations = OperationCoordinator(directory: AppRuntime.operationDirectory)
let notifications = NotificationCoordinator()
let status = StatusItemController(processClient: processClient, operations: operations, notifications: notifications, openControlCenter: { _ in })
let firstStart = DispatchTime.now().uptimeNanoseconds
status.start()
let firstMs = Double(DispatchTime.now().uptimeNanoseconds - firstStart) / 1_000_000
status.stop()
let control = ControlCenterWindowController(processClient: processClient, operations: operations, notifications: notifications)
let controlStart = DispatchTime.now().uptimeNanoseconds
control.show(section: SidebarItem.overview)
let controlMs = Double(DispatchTime.now().uptimeNanoseconds - controlStart) / 1_000_000
control.window?.orderOut(nil as Any?)
let data = try! JSONSerialization.data(withJSONObject: ["menu_bar_first_state_render_ms": firstMs, "control_center_open_ms": controlMs])
print(String(data: data, encoding: .utf8)!)`
}

function unavailableMcpCli(): CodexMcpCliPort {
  return {
    list: async () => ({ available: false, ok: false, rows: [], public_error: 'codex_cli_not_found' }),
    transform: async () => ({ available: false, ok: false, used: false, text: null, unsupported_reason: 'codex_cli_not_found', public_error: null }),
    login: async () => ({ available: false, ok: false, public_error: 'codex_cli_not_found' }),
    logout: async () => ({ available: false, ok: false, public_error: 'codex_cli_not_found' })
  }
}

function nativeFailureMeasurements(
  budgets: Map<ReleaseLatencySloId, ReleaseLatencyBudget>,
  error: unknown
): ReleaseLatencyMeasurement[] {
  return (['menubar_first_state_render', 'control_center_open'] as ReleaseLatencySloId[]).map((id) => ({
    id,
    budget_p95_ms: budgets.get(id)?.budget_p95_ms ?? RELEASE_LATENCY_LIMITS[id],
    producer: 'native_appkit_runtime', status: 'producer_failed', samples_ms: [],
    p50_ms: null, p95_ms: null, ok: false,
    evidence: { error: publicError(error), compile_link_run_required: true },
    blocker: `release_latency_producer_failed:${id}`
  }))
}

async function samples(count: number, run: () => Promise<void>): Promise<number[]> {
  const values: number[] = []
  for (let index = 0; index < count; index += 1) {
    const started = performance.now()
    await run()
    values.push(performance.now() - started)
  }
  return values
}

function runs(budgets: Map<ReleaseLatencySloId, ReleaseLatencyBudget>, id: ReleaseLatencySloId, fallback: number): number {
  return Math.max(1, Math.min(30, Math.floor(budgets.get(id)?.measured_runs ?? fallback)))
}

function percentile(values: readonly number[], pct: number): number {
  if (!values.length) return 0
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * pct) - 1))] ?? 0
}

function round(value: number): number { return Math.round(value * 1000) / 1000 }
function parseJson(value: string): any { try { return JSON.parse(String(value || '').trim()) } catch { return null } }
function publicError(error: unknown): string { return String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 500) }
