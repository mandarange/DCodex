import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { cleanupReleaseGateHermeticEnv, cleanupReleaseGateRunTemp, createReleaseGateHermeticEnv } from './release-gate-hermetic-env.js'
import { appendReleaseGateJsonl, writeReleaseGateJson } from './release-gate-report.js'
import { findReadyReleaseGateNodes, findReleaseGatesBlockedByFailedDeps, pickReadyLaunchableReleaseGates } from './release-gate-scheduler.js'
import { readReleaseGateCacheRecord, releaseGateProofBankFile, writeReleaseGateCacheHit } from './release-gate-cache-v2.js'
import { RELEASE_GATE_NODE_SCHEMA, validateReleaseGateManifest, type ReleaseGateManifestV2, type ReleaseGateNode } from './release-gate-node.js'
import { countReleaseGateResources, defaultReleaseGateBudget, summarizeReleaseGateBudget, type ReleaseGateBudget } from './release-gate-resource-governor.js'
import { selectAffectedReleaseGates, type ReleaseGateAffectedSelection } from './release-gate-affected-selector.js'
import { computeTriWikiAffectedGraph, type TriWikiAffectedGraph } from '../triwiki/triwiki-affected-graph.js'
import { executeExtremeSchedule, type ExtremeSchedulerRunReport } from './extreme-parallel-scheduler.js'
import { computeResourceClassBudget } from './resource-class-budget.js'
import { guardedProcessKill, guardContextForRoute } from '../safety/mutation-guard.js'
import { createRequestedScopeContract } from '../safety/requested-scope-contract.js'
import { rmrf } from '../fsx.js'
import { sweepSksTempDirs } from '../retention.js'
import type { ReleaseAuthorizationSnapshot } from './release-authorization-snapshot.js'

export interface ReleaseGateDagRunResult {
  schema: 'sks.release-gate-dag-run.v1'
  ok: boolean
  run_id: string
  selected_preset: string
  total_gates: number
  selected_gates: number
  selected_gate_ids: string[]
  skipped_by_affected: string[]
  affected_selection: ReleaseGateAffectedSelection | null
  completed: number
  failed: number
  cached: number
  wall_ms: number
  sum_gate_ms: number
  cpu_time_saved_ms: number
  parallelism_gain: number
  critical_path_ms: number
  peak_running: number
  peak_resources: Record<string, number>
  cached_gates: string[]
  executed_gates: string[]
  slowest_gates: Array<{ id: string; duration_ms: number; cached: boolean }>
  budget_snapshot: ReleaseGateBudget
  budget_summary: string
  report_dir: string
  failures: Array<{ id: string; exit_code: number | null; stderr_tail: string; timed_out: boolean; signal: NodeJS.Signals | null }>
  affected_graph: ReleaseGateAffectedGraph
  completion_certificate: ReleaseGateCompletionCertificate
  release_authorization_snapshot: ReleaseAuthorizationSnapshot | null
  retention?: ReleaseGateRunRetention
  triwiki_affected_graph?: TriWikiAffectedGraph | null
  triwiki_selection_used: boolean
  triwiki_selected_gates: string[]
  triwiki_skipped_gates: string[]
  triwiki_conservative_reason: string | null
  executed_packs?: string[]
  pack_parallelism_gain?: number
  triwiki_proof_bank_hits?: number
  pack_proof_paths?: string[]
}

export interface ReleaseGateAffectedGraph {
  schema: 'sks.affected-gate-graph.v1'
  changed_files: string[]
  affected_modules: string[]
  affected_gates: string[]
  reused_proofs: string[]
  invalidated_proofs: string[]
  skipped_gate_ids: string[]
  proof_bank_file: string
}

export interface ReleaseGateCompletionCertificate {
  schema: 'sks.five-minute-completion-certificate.v1'
  ok: boolean
  tier: string
  confidence: 'incomplete' | 'release-equivalent-for-affected-scope' | 'full-release-proof'
  sla_ms: number
  sla_met: boolean
  changed_files: string[]
  affected_gates: number
  reused_proofs: number
  newly_executed_gates: number
  skipped_as_valid_cache: number
  skipped_as_unaffected: number
  critical_path_ms: number
  wall_ms: number
  full_release_proof: 'current_run' | 'background_or_release_before_publish_required'
  proof_bank_file: string
  affected_graph_file: string
}

export interface ReleaseGateRunRetention {
  schema: 'sks.release-gate-run-retention.v1'
  keep: number
  scanned: number
  kept: number
  removed: number
  preserve_run_id: string | null
  removed_run_ids: string[]
}

export function loadReleaseGateManifest(root: string, file = 'release-gates.v2.json'): ReleaseGateManifestV2 {
  const manifestPath = path.join(root, file)
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const validation = validateReleaseGateManifest(parsed)
  if (!validation.ok || !validation.manifest) {
    throw new Error(`invalid ${file}: ${validation.errors.join(', ')}`)
  }
  return validation.manifest
}

export function selectReleaseGateClosure(manifest: ReleaseGateManifestV2, requestedGateIds: Iterable<string>): ReleaseGateNode[] {
  const requested = [...new Set([...requestedGateIds].map(String).filter(Boolean))]
  const byId = new Map(manifest.gates.map((gate) => [gate.id, gate]))
  const unknown = requested.filter((id) => !byId.has(id)).sort()
  if (unknown.length) throw new Error(`release_gate_only_selection_unknown:${unknown.join(',')}`)
  const selected = new Set<string>()
  const visiting = new Set<string>()
  const stack: string[] = []
  const visit = (id: string) => {
    if (selected.has(id)) return
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id)
      const cycle = [...stack.slice(Math.max(0, cycleStart)), id]
      throw new Error(`release_gate_only_selection_dependency_cycle:${cycle.join('->')}`)
    }
    const gate = byId.get(id)
    if (!gate) throw new Error(`release_gate_only_selection_missing_dependency:${stack.at(-1) || 'requested'}:${id}`)
    visiting.add(id)
    stack.push(id)
    for (const dep of gate.deps || []) visit(dep)
    stack.pop()
    visiting.delete(id)
    selected.add(id)
  }
  for (const id of requested) visit(id)
  return manifest.gates.filter((gate) => selected.has(gate.id))
}

export function gatePackRunCoverageComplete(selectedGateCount: number, packRun: Pick<ExtremeSchedulerRunReport, 'executed_packs' | 'pack_reports' | 'executed_gate_count' | 'reused_proof_count'>): boolean {
  const reportIds = new Set(packRun.pack_reports.map((report) => report.pack_id))
  return selectedGateCount > 0
    && reportIds.size === packRun.executed_packs.length
    && reportIds.size === packRun.pack_reports.length
    && packRun.executed_packs.every((id) => reportIds.has(id))
    && packRun.executed_gate_count + packRun.reused_proof_count >= selectedGateCount
}

export async function runReleaseGateDag(input: {
  root: string
  preset?: string
  noCache?: boolean
  failFast?: boolean
  explain?: boolean
  changedSince?: string | null
  changedFiles?: string[]
  full?: boolean
  slaMs?: number | null
  triwiki?: boolean
  useTriWikiProofBank?: boolean
  useGatePacks?: boolean
  onlyGateIds?: string[]
  releaseAuthorizationSnapshot?: ReleaseAuthorizationSnapshot | null
}): Promise<ReleaseGateDagRunResult> {
  const root = path.resolve(input.root)
  const preset = input.preset || 'release'
  const manifest = loadReleaseGateManifest(root)
  const onlyGateIds = new Set((input.onlyGateIds || []).map(String).filter(Boolean))
  const presetGates = onlyGateIds.size
    ? selectReleaseGateClosure(manifest, onlyGateIds)
    : selectReleaseGatePreset(manifest, preset)
  const forceFullSelection = input.full === true || onlyGateIds.size > 0
  const affected = (preset === 'affected' || preset === 'fast' || preset === 'confidence') && !forceFullSelection
    ? selectAffectedReleaseGates(root, manifest, presetGates, { changedSince: input.changedSince || 'auto', ...(input.changedFiles ? { changedFiles: input.changedFiles } : {}), preset })
    : selectAffectedReleaseGates(root, manifest, presetGates, { full: true, preset })
  const rootReleaseSurfaceChanged = affected.selection.changed_files.some((file) => file === 'package.json' || file === 'package-lock.json' || file === 'release-gates.v2.json')
  const triwikiGraph = input.triwiki !== false && !rootReleaseSurfaceChanged && (preset === 'affected' || preset === 'fast' || preset === 'confidence') && input.full !== true
    ? computeTriWikiAffectedGraph({ root, tier: preset === 'fast' ? 'affected' : 'confidence', changedSince: input.changedSince || 'auto', ...(input.changedFiles ? { changedFiles: input.changedFiles } : {}) })
    : null
  const triwikiSelectionUsed = Boolean(triwikiGraph)
  const triwikiConservative = Boolean(triwikiGraph?.conservative_reason)
  const triwikiSelectedIds = new Set(triwikiGraph && !triwikiConservative ? triwikiGraph.gates : affected.gates.map((gate) => gate.id))
  const selected = triwikiGraph
    ? presetGates.filter((gate) => triwikiSelectedIds.has(gate.id))
    : affected.gates
  const triwikiSkippedGates = triwikiGraph ? presetGates.filter((gate) => !selected.some((row) => row.id === gate.id)).map((gate) => gate.id) : []
  if (triwikiGraph) {
    affected.selection.mode = 'affected'
    affected.selection.selected_gate_ids = selected.map((gate) => gate.id)
    affected.selection.skipped_gate_ids = triwikiSkippedGates
    affected.selection.reasons = Object.fromEntries(selected.map((gate) => [gate.id, triwikiConservative ? `triwiki_conservative_fallback:${triwikiGraph.conservative_reason}` : 'triwiki-affected']))
  }
  const selectedIds = new Set(selected.map((gate) => gate.id))
  const affectedExternalSatisfiedDeps = affected.selection.mode === 'affected'
    ? new Set(selected.flatMap((gate) => gate.deps || []).filter((dep) => !selectedIds.has(dep)))
    : new Set<string>()
  const missingSelectedDeps = selected.flatMap((gate) => (gate.deps || [])
    .filter((dep) => !selectedIds.has(dep) && !affectedExternalSatisfiedDeps.has(dep))
    .map((dep) => `${gate.id}->${dep}`))
  if (missingSelectedDeps.length) throw new Error(`release_gate_selection_missing_dependencies:${[...new Set(missingSelectedDeps)].sort().join(',')}`)
  const runId = `rg-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
  const retentionBefore = await pruneOldReleaseGateRunDirs(root)
  await sweepSksTempDirs(root, { maxAgeHours: 24 }).catch(() => null)
  const reportDir = path.join(root, '.sneakoscope', 'reports', 'release-gates', runId)
  fs.mkdirSync(reportDir, { recursive: true })
  const timeline = path.join(reportDir, 'timeline.jsonl')
  const affectedGraphFile = path.join(reportDir, 'affected-gate-graph.json')
  const completionCertificateFile = path.join(reportDir, 'completion-certificate.json')
  appendReleaseGateJsonl(timeline, { event: 'retention', phase: 'before_run', ...retentionBefore, at: new Date().toISOString() })
  const started = Date.now()
  const slaMs = Math.max(1, Math.floor(Number(input.slaMs || 300000)))
  const pending = new Map(selected.map((gate) => [gate.id, gate]))
  const running = new Map<string, { gate: ReleaseGateNode; promise: Promise<GateRunResult> }>()
  const completed = new Map<string, GateRunResult>()
  const failed = new Map<string, GateRunResult>()
  const budget = defaultReleaseGateBudget()
  const peakResources: Record<string, number> = {}
  let cached = 0
  const cachedGates: string[] = []
  const executedGates: string[] = []
  let sumGateMs = 0
  let peakRunning = 0

  const writeSummarySnapshot = (finished = false, completionOverride: boolean | null = null): ReleaseGateDagRunResult & { in_progress?: boolean; pending?: number; running?: number } => {
    const wallMs = Date.now() - started
    const failures = [...failed.values()].map((row) => ({ id: row.id, exit_code: row.exit_code, stderr_tail: row.stderr_tail, timed_out: row.timed_out, signal: row.signal }))
    const runComplete = completionOverride ?? (finished
      && pending.size === 0
      && running.size === 0
      && completed.size + failed.size === selected.length)
    const snapshotOk = runComplete && failures.length === 0
    const affectedGraph = buildAffectedGraph({
      selection: affected.selection,
      selected,
      cachedGates,
      executedGates,
      proofBankFile: releaseGateProofBankFile(root)
    })
    const completionCertificate = buildCompletionCertificate({
      ok: snapshotOk,
      complete: runComplete,
      preset,
      slaMs,
      wallMs,
      criticalPathMs: estimateCriticalPath(selected, completed),
      affectedGraph,
      affectedGraphFile,
      skippedByAffected: affected.selection.mode === 'affected' ? affected.selection.skipped_gate_ids : []
    })
    const snapshot: ReleaseGateDagRunResult & { in_progress?: boolean; pending?: number; running?: number } = {
      schema: 'sks.release-gate-dag-run.v1',
      ok: snapshotOk,
      run_id: runId,
      selected_preset: preset,
	      total_gates: manifest.gates.length,
	      selected_gates: selected.length,
	      selected_gate_ids: selected.map((gate) => gate.id),
	      skipped_by_affected: affected.selection.mode === 'affected' ? affected.selection.skipped_gate_ids : [],
	      affected_selection: affected.selection,
	      completed: completed.size,
      failed: failed.size,
      cached,
      wall_ms: wallMs,
      sum_gate_ms: sumGateMs,
      cpu_time_saved_ms: Math.max(0, sumGateMs - wallMs),
      parallelism_gain: wallMs > 0 ? Number((sumGateMs / wallMs).toFixed(2)) : 1,
      critical_path_ms: estimateCriticalPath(selected, completed),
	      peak_running: peakRunning,
	      peak_resources: peakResources,
	      cached_gates: cachedGates,
	      executed_gates: executedGates,
	      slowest_gates: [...completed.values(), ...failed.values()]
	        .sort((a, b) => b.duration_ms - a.duration_ms)
	        .slice(0, 10)
	        .map((row) => ({ id: row.id, duration_ms: row.duration_ms, cached: row.cached })),
	      budget_snapshot: budget,
      budget_summary: summarizeReleaseGateBudget(budget),
      report_dir: reportDir,
      failures,
      affected_graph: affectedGraph,
      completion_certificate: completionCertificate,
      release_authorization_snapshot: input.releaseAuthorizationSnapshot || null,
      triwiki_affected_graph: triwikiGraph,
      triwiki_selection_used: triwikiSelectionUsed,
      triwiki_selected_gates: triwikiGraph ? selected.map((gate) => gate.id) : [],
      triwiki_skipped_gates: triwikiSkippedGates,
      triwiki_conservative_reason: triwikiGraph?.conservative_reason || null
    }
    if (!finished) {
      snapshot.in_progress = true
      snapshot.pending = pending.size
      snapshot.running = running.size
    }
    writeReleaseGateJson(path.join(reportDir, 'summary.json'), snapshot)
    writeReleaseGateJson(affectedGraphFile, affectedGraph)
    if (triwikiGraph) writeReleaseGateJson(path.join(reportDir, 'triwiki-affected-graph.json'), triwikiGraph)
    writeReleaseGateJson(completionCertificateFile, completionCertificate)
    if (finished) {
      writeReleaseGateJson(path.join(root, '.sneakoscope', 'reports', 'affected-gate-graph.json'), affectedGraph)
      writeReleaseGateJson(path.join(root, '.sneakoscope', 'reports', 'completion-certificate.json'), completionCertificate)
    }
    return snapshot
  }

  if (input.useGatePacks === true && triwikiGraph && (preset === 'affected' || preset === 'fast' || preset === 'confidence') && selected.length > 0) {
    const packRun = await executeExtremeSchedule({
      root,
      graph: triwikiGraph,
      slaMs,
      budget: computeResourceClassBudget(),
      useProofBank: input.useTriWikiProofBank !== false
    })
    for (const report of packRun.pack_reports) {
      if (report.ok) completed.set(report.pack_id, { id: report.pack_id, ok: true, exit_code: 0, signal: null, timed_out: false, duration_ms: report.critical_path_ms || 0, cached: false, stderr_tail: '' })
      else failed.set(report.pack_id, { id: report.pack_id, ok: false, exit_code: 1, signal: null, timed_out: false, duration_ms: report.critical_path_ms || 0, cached: false, stderr_tail: report.blockers.join('\n') })
      sumGateMs += report.critical_path_ms || 0
    }
    const packCoverageComplete = gatePackRunCoverageComplete(selected.length, packRun)
    if (!packCoverageComplete) failed.set('gate-pack-coverage', {
      id: 'gate-pack-coverage', ok: false, exit_code: null, signal: null, timed_out: false, duration_ms: 0, cached: false,
      stderr_tail: `gate_pack_selected_coverage_incomplete:${packRun.executed_gate_count + packRun.reused_proof_count}/${selected.length}`
    })
    if (!packRun.ok) failed.set('gate-pack-scheduler', {
      id: 'gate-pack-scheduler', ok: false, exit_code: null, signal: null, timed_out: false, duration_ms: packRun.wall_ms, cached: false,
      stderr_tail: packRun.blockers.join('\n') || 'gate_pack_scheduler_failed'
    })
    const packed = writeSummarySnapshot(true, packCoverageComplete)
    cleanupReleaseGateRunTemp(runId)
    return {
      ...packed,
      ok: packed.ok && packRun.ok,
      completed: completed.size,
      failed: failed.size,
      executed_packs: packRun.executed_packs,
      pack_parallelism_gain: packRun.wall_ms > 0 ? Number((packRun.sequential_ms / packRun.wall_ms).toFixed(2)) : 1,
      triwiki_proof_bank_hits: packRun.reused_proof_count,
      pack_proof_paths: packRun.pack_reports.flatMap((report) => report.proof_paths)
    }
  }

  if (input.explain) {
    writeReleaseGateJson(path.join(reportDir, 'explain.json'), { schema: RELEASE_GATE_NODE_SCHEMA, preset, budget, gates: selected.map((gate) => ({ id: gate.id, deps: gate.deps, resource: gate.resource, command: gate.command })) })
  }

  while (pending.size || running.size) {
    const ready = findReadyReleaseGateNodes({ pending, completed, failed, satisfiedDeps: affectedExternalSatisfiedDeps })
    const launchable = pickReadyLaunchableReleaseGates({ ready, running: [...running.values()].map((row) => row.gate) })
    let progressed = false
    for (const gate of launchable) {
      pending.delete(gate.id)
      const cacheHit = !input.noCache && gate.cache.enabled ? readReleaseGateCacheRecord(root, gate) : null
      if (cacheHit) {
		        const result: GateRunResult = { id: gate.id, ok: true, exit_code: 0, signal: null, timed_out: false, duration_ms: cacheHit.duration_ms, cached: true, stderr_tail: '' }
	        completed.set(gate.id, result)
	        cached += 1
	        cachedGates.push(gate.id)
        sumGateMs += result.duration_ms
	        progressed = true
        appendReleaseGateJsonl(timeline, { event: 'cache_hit', gate_id: gate.id, duration_ms: result.duration_ms, at: new Date().toISOString() })
        writeSummarySnapshot(false)
        continue
	      }
	      appendReleaseGateJsonl(timeline, { event: 'start', gate_id: gate.id, resource: gate.resource, at: new Date().toISOString() })
	      executedGates.push(gate.id)
	      running.set(gate.id, { gate, promise: runGate(root, runId, reportDir, gate) })
      peakRunning = Math.max(peakRunning, running.size)
      const used = countReleaseGateResources([...running.values()].map((row) => row.gate))
      for (const [resource, count] of Object.entries(used)) {
        peakResources[resource] = Math.max(peakResources[resource] || 0, Number(count) || 0)
      }
      progressed = true
    }
    if (!running.size) {
      const blockedByFailedDeps = findReleaseGatesBlockedByFailedDeps({ pending, failed })
      if (blockedByFailedDeps.length) {
        for (const gate of blockedByFailedDeps) {
          pending.delete(gate.id)
          const result: GateRunResult = {
            id: gate.id,
            ok: false,
            exit_code: null,
            signal: null,
            timed_out: false,
            duration_ms: 0,
            cached: false,
            stderr_tail: `blocked by failed dependency: ${gate.deps.filter((dep) => failed.has(dep)).join(', ')}`
          }
          failed.set(gate.id, result)
          appendReleaseGateJsonl(timeline, { event: 'blocked_by_failed_dependency', gate_id: gate.id, deps: gate.deps.filter((dep) => failed.has(dep)), at: new Date().toISOString() })
        }
        continue
      }
      if (progressed) continue
      const blocked = [...pending.keys()]
      throw new Error(`release gate DAG stalled: ${blocked.join(', ')}`)
    }
    const result = await Promise.race([...running.values()].map((row) => row.promise))
    running.delete(result.id)
    sumGateMs += result.duration_ms
    if (result.ok) {
      completed.set(result.id, result)
      const gate = selected.find((row) => row.id === result.id)
      if (gate?.cache.enabled && !input.noCache) writeReleaseGateCacheHit(root, gate, result.duration_ms)
    } else {
      failed.set(result.id, result)
      if (input.failFast) {
        for (const id of [...pending.keys()]) pending.delete(id)
      }
    }
    appendReleaseGateJsonl(timeline, { event: result.ok ? 'pass' : 'fail', gate_id: result.id, duration_ms: result.duration_ms, at: new Date().toISOString() })
    writeSummarySnapshot(false)
  }

  const result = writeSummarySnapshot(true)
  const retentionAfter = await pruneOldReleaseGateRunDirs(root, { preserveRunId: runId })
  const finalResult = { ...result, retention: mergeReleaseGateRetention(retentionBefore, retentionAfter) }
  appendReleaseGateJsonl(timeline, { event: 'retention', phase: 'after_run', ...retentionAfter, at: new Date().toISOString() })
  writeReleaseGateJson(path.join(reportDir, 'summary.json'), finalResult)
  cleanupReleaseGateRunTemp(runId)
  return finalResult
}

export function selectReleaseGatePreset(manifest: ReleaseGateManifestV2, preset: string): ReleaseGateNode[] {
  const effectivePresets = preset === 'confidence'
    ? ['release', 'incremental', 'confidence']
    : preset === 'affected' || preset === 'fast'
      ? ['release', 'incremental']
      : [preset]
  const selected = manifest.gates.filter((gate) => effectivePresets.some((candidate) => gate.preset.includes(candidate)))
  if (!selected.length) throw new Error(`release_gate_preset_empty_or_unknown:${preset}`)
  return selected
}

interface GateRunResult {
  id: string
  ok: boolean
  exit_code: number | null
  signal: NodeJS.Signals | null
  timed_out: boolean
  duration_ms: number
  cached: boolean
  stderr_tail: string
}

function buildAffectedGraph(input: {
  selection: ReleaseGateAffectedSelection
  selected: ReleaseGateNode[]
  cachedGates: string[]
  executedGates: string[]
  proofBankFile: string
}): ReleaseGateAffectedGraph {
  return {
    schema: 'sks.affected-gate-graph.v1',
    changed_files: input.selection.changed_files,
    affected_modules: inferAffectedModules(input.selection.changed_files),
    affected_gates: input.selected.map((gate) => gate.id),
    reused_proofs: [...input.cachedGates],
    invalidated_proofs: [...input.executedGates],
    skipped_gate_ids: input.selection.skipped_gate_ids,
    proof_bank_file: input.proofBankFile
  }
}

function buildCompletionCertificate(input: {
  ok: boolean
  complete: boolean
  preset: string
  slaMs: number
  wallMs: number
  criticalPathMs: number
  affectedGraph: ReleaseGateAffectedGraph
  affectedGraphFile: string
  skippedByAffected: string[]
}): ReleaseGateCompletionCertificate {
  const affectedScope = input.preset === 'affected' || input.preset === 'fast'
  return {
    schema: 'sks.five-minute-completion-certificate.v1',
    ok: input.ok,
    tier: input.preset === 'affected' ? 'confidence' : input.preset,
    confidence: !input.complete ? 'incomplete' : affectedScope ? 'release-equivalent-for-affected-scope' : 'full-release-proof',
    sla_ms: input.slaMs,
    sla_met: input.complete && input.wallMs <= input.slaMs,
    changed_files: input.affectedGraph.changed_files,
    affected_gates: input.affectedGraph.affected_gates.length,
    reused_proofs: input.affectedGraph.reused_proofs.length,
    newly_executed_gates: input.affectedGraph.invalidated_proofs.length,
    skipped_as_valid_cache: input.affectedGraph.reused_proofs.length,
    skipped_as_unaffected: input.skippedByAffected.length,
    critical_path_ms: input.criticalPathMs,
    wall_ms: input.wallMs,
    full_release_proof: input.complete && !affectedScope ? 'current_run' : 'background_or_release_before_publish_required',
    proof_bank_file: input.affectedGraph.proof_bank_file,
    affected_graph_file: input.affectedGraphFile
  }
}

function inferAffectedModules(files: string[]): string[] {
  const modules = new Set<string>()
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/')
    const parts = normalized.split('/').filter(Boolean)
    if (!parts.length) continue
    const top = parts[0]!
    if (parts[0] === 'src' && parts.length >= 3) modules.add(parts.slice(0, 3).join('/'))
    else if (parts[0] === 'test' && parts.length >= 2) modules.add(parts.slice(0, 2).join('/'))
    else modules.add(top)
  }
  return [...modules].sort()
}

function runGate(root: string, runId: string, reportRoot: string, gate: ReleaseGateNode): Promise<GateRunResult> {
  const started = Date.now()
  const hermetic = createReleaseGateHermeticEnv({ root, runId, gate, reportRoot })
  const stdoutFile = path.join(hermetic.report_dir, 'stdout.log')
  const stderrFile = path.join(hermetic.report_dir, 'stderr.log')
  const out = fs.createWriteStream(stdoutFile)
  const err = fs.createWriteStream(stderrFile)
  return new Promise((resolve) => {
    const child = spawn(gate.command, { cwd: root, shell: true, env: hermetic.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let timedOut = false
    let timeoutCleanup: Promise<void> | null = null
    const timer = setTimeout(() => {
      timedOut = true
      timeoutCleanup = cleanupTimedOutGateProcessTree(root, child)
    }, gate.timeout_ms)
    timer.unref?.()
    child.stdout.pipe(out)
    child.stderr.pipe(err)
    child.on('close', (code, signal) => {
      void (async () => {
        clearTimeout(timer)
        if (timeoutCleanup) await timeoutCleanup
        out.end()
        err.end()
        const durationMs = Date.now() - started
        const stderrText = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8') : ''
        const timeoutTail = timedOut ? `release_gate_timeout:${gate.id}:${gate.timeout_ms}ms` : ''
        const signalTail = !timedOut && signal ? `release_gate_signal:${gate.id}:${signal}` : ''
        const stderrTail = tail([stderrText, timeoutTail, signalTail].filter(Boolean).join('\n'))
        const exitCode = timedOut ? 124 : code
        const result = { id: gate.id, ok: exitCode === 0, exit_code: exitCode, signal, timed_out: timedOut, duration_ms: durationMs, cached: false, stderr_tail: stderrTail }
        writeReleaseGateJson(path.join(hermetic.report_dir, 'result.json'), { schema: 'sks.release-gate-result.v1', ...result, stdout_log: stdoutFile, stderr_log: stderrFile })
        cleanupReleaseGateHermeticEnv(hermetic)
        resolve(result)
      })()
    })
  })
}

async function cleanupTimedOutGateProcessTree(root: string, child: ChildProcess): Promise<void> {
  await killGateProcessTree(root, child, 'SIGTERM')
  await sleep(1500)
  await killGateProcessTree(root, child, 'SIGKILL')
  await sleep(100)
}

async function killGateProcessTree(root: string, child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (!child.pid) return
  const pid = process.platform !== 'win32' ? -child.pid : child.pid
  const contract = createRequestedScopeContract({
    route: 'release:gate-runner',
    userRequest: 'Terminate only the release gate child process tree after its configured timeout.',
    projectRoot: root,
    overrides: { codex_app_process: true }
  })
  try {
    await guardedProcessKill(guardContextForRoute(root, contract, 'release gate timeout cleanup'), pid, { signal, confirmed: true })
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function estimateCriticalPath(gates: ReleaseGateNode[], completed: Map<string, GateRunResult>): number {
  const byId = new Map(gates.map((gate) => [gate.id, gate]))
  const memo = new Map<string, number>()
  const visit = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!
    const gate = byId.get(id)
    if (!gate) return 0
    const own = completed.get(id)?.duration_ms || 0
    const dep = Math.max(0, ...gate.deps.map(visit))
    memo.set(id, own + dep)
    return own + dep
  }
  return Math.max(0, ...gates.map((gate) => visit(gate.id)))
}

function tail(value: string, limit = 1200): string {
  return value.length > limit ? value.slice(-limit) : value
}

export async function pruneOldReleaseGateRunDirs(root: string, opts: { keep?: number; preserveRunId?: string | null } = {}): Promise<ReleaseGateRunRetention> {
  const keep = Math.max(1, Math.floor(Number(opts.keep ?? process.env.SKS_RELEASE_GATE_RUN_RETENTION ?? 5) || 5))
  const preserveRunId = opts.preserveRunId || null
  const base = path.join(root, '.sneakoscope', 'reports', 'release-gates')
  const report: ReleaseGateRunRetention = {
    schema: 'sks.release-gate-run-retention.v1',
    keep,
    scanned: 0,
    kept: 0,
    removed: 0,
    preserve_run_id: preserveRunId,
    removed_run_ids: []
  }
  if (!fs.existsSync(base)) return report
  const runs = fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^rg-\d{4}-/.test(entry.name))
    .map((entry) => {
      const dir = path.join(base, entry.name)
      const summary = path.join(dir, 'summary.json')
      const stat = fs.statSync(fs.existsSync(summary) ? summary : dir)
      return { id: entry.name, dir, mtimeMs: stat.mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  report.scanned = runs.length
  const keepIds = new Set(runs.slice(0, keep).map((run) => run.id))
  if (preserveRunId) keepIds.add(preserveRunId)
  for (const run of runs) {
    if (keepIds.has(run.id)) {
      report.kept += 1
      continue
    }
    await rmrf(run.dir)
    report.removed += 1
    report.removed_run_ids.push(run.id)
  }
  return report
}

function mergeReleaseGateRetention(before: ReleaseGateRunRetention, after: ReleaseGateRunRetention): ReleaseGateRunRetention {
  return {
    ...after,
    scanned: Math.max(before.scanned, after.scanned),
    kept: after.kept,
    removed: before.removed + after.removed,
    removed_run_ids: [...before.removed_run_ids, ...after.removed_run_ids]
  }
}
