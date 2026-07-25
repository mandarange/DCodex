import path from 'node:path'
import { findCodexBinary } from '../codex-adapter.js'
import { readCodexHookActualState, type CodexHookActualState } from '../codex-hooks/codex-hook-actual-discovery.js'
import { nowIso, runProcess, writeJsonAtomic } from '../fsx.js'
import {
  type CodexHookApprovalProbe,
  type CodexHookApprovalSourceCheck,
  type CodexHookApprovalState,
  isRecord
} from './codex-app-types.js'
import { messageOf } from '../errors/message.js'

export async function probeCodexHookApprovalState(root: string, input: {
  codexBin?: string | null
  env?: NodeJS.ProcessEnv
  writeReport?: boolean
} = {}): Promise<CodexHookApprovalProbe> {
  const env = input.env || process.env
  const sources: CodexHookApprovalSourceCheck[] = []
  const fixture = normalizeApprovalState(env.SKS_CODEX_HOOK_APPROVAL_FIXTURE)
  if (fixture) {
    const report = buildProbe(fixture !== 'unknown', fixture, [{
      source: 'config',
      ok: fixture !== 'unknown',
      evidence: [`fixture:${fixture}`],
      blockers: fixture === 'unknown' ? ['fixture_unknown'] : []
    }])
    return persist(root, report, input.writeReport !== false)
  }

  const actual = await readCodexHookActualState(root).catch((err: unknown): CodexHookActualState => ({
    schema: 'sks.codex-hook-actual-state.v1',
    ok: false,
    root,
    sources: [],
    managed_dirs: [],
    entries: [],
    unsupported_handlers: [],
    invalid_matchers: [],
    dual_representation: [],
    warnings: [],
    blockers: [messageOf(err)]
  }))
  const actualState = approvalFromActualState(actual)
  sources.push({
    source: 'hook-actual-state',
    ok: actual.ok !== false,
    evidence: [
      `entries:${actual.entries.length}`,
      `trusted:${actual.entries.filter((entry) => entry.trust_status === 'Trusted' || entry.trust_status === 'Managed').length}`,
      `modified:${actual.entries.filter((entry) => entry.trust_status === 'Modified').length}`,
      `untrusted:${actual.entries.filter((entry) => entry.trust_status === 'Untrusted').length}`
    ],
    blockers: actual.blockers
  })

  const doctor = await probeCodexDoctorApproval(input.codexBin, env)
  sources.push(doctor.source)
  const doctorState = doctor.approval_state

  const state = strongestApprovalState([actualState, doctorState])
  const detectable = state !== 'unknown'
  const blockers = [
    ...sources.flatMap((source) => source.blockers),
    ...(state === 'modified_requires_reapproval' ? ['hook_modified_requires_reapproval'] : [])
  ]
  const warnings = [
    ...(state === 'unknown' ? ['hook_approval_state_unknown'] : []),
    ...(actual.entries.length > 0 && state === 'unknown' ? ['hooks_installed_but_approval_unknown'] : [])
  ]
  const report = {
    schema: 'sks.codex-hook-approval-probe.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0 && state !== 'pending_review' && state !== 'modified_requires_reapproval',
    detectable,
    approval_state: state,
    sources_checked: sources,
    blockers,
    warnings
  } satisfies CodexHookApprovalProbe
  return persist(root, report, input.writeReport !== false)
}

function approvalFromActualState(actual: CodexHookActualState): CodexHookApprovalState {
  if (actual.entries.length === 0) return 'not_installed'
  if (actual.entries.some((entry) => entry.trust_status === 'Modified')) return 'modified_requires_reapproval'
  if (actual.entries.some((entry) => entry.trust_status === 'Untrusted')) return 'pending_review'
  if (actual.entries.every((entry) => entry.trust_status === 'Trusted' || entry.trust_status === 'Managed')) return 'approved'
  return 'unknown'
}

async function probeCodexDoctorApproval(codexBin: string | null | undefined, env: NodeJS.ProcessEnv): Promise<{
  approval_state: CodexHookApprovalState
  source: CodexHookApprovalSourceCheck
}> {
  const bin = codexBin || env.CODEX_BIN || await findCodexBinary().catch(() => null)
  if (!bin) {
    return { approval_state: 'unknown', source: { source: 'codex-doctor-json', ok: false, evidence: [], blockers: ['codex_cli_missing'] } }
  }
  const run = await runProcess(bin, ['doctor', '--json'], { env, timeoutMs: 8000, maxOutputBytes: 256 * 1024 }).catch((err: unknown) => ({
    code: 1,
    stdout: '',
    stderr: messageOf(err)
  }))
  const text = `${run.stdout || ''}${run.stderr || ''}`.trim()
  if (run.code !== 0 || !text) {
    return {
      approval_state: 'unknown',
      source: { source: 'codex-doctor-json', ok: false, evidence: text ? [text.slice(0, 240)] : [], blockers: ['codex_doctor_json_unavailable'] }
    }
  }
  try {
    const parsed = JSON.parse(text) as unknown
    const state = findApprovalState(parsed)
    return {
      approval_state: state || 'unknown',
      source: {
        source: 'codex-doctor-json',
        ok: Boolean(state),
        evidence: state ? [`approval_state:${state}`] : ['doctor_json_no_hook_approval_field'],
        blockers: state ? [] : ['hook_approval_not_exposed_by_codex_doctor']
      }
    }
  } catch {
    return {
      approval_state: 'unknown',
      source: { source: 'codex-doctor-json', ok: false, evidence: [text.slice(0, 240)], blockers: ['codex_doctor_json_parse_failed'] }
    }
  }
}

function findApprovalState(value: unknown): CodexHookApprovalState | null {
  if (!isRecord(value)) return null
  for (const key of ['hook_approval_state', 'approval_state', 'hookApprovalState']) {
    const state = normalizeApprovalState(value[key])
    if (state) return state
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = findApprovalState(item)
        if (found) return found
      }
    } else if (isRecord(nested)) {
      const found = findApprovalState(nested)
      if (found) return found
    }
  }
  return null
}

function normalizeApprovalState(value: unknown): CodexHookApprovalState | null {
  const raw = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_')
  if (raw === 'approved' || raw === 'trusted' || raw === 'managed') return 'approved'
  if (raw === 'pending' || raw === 'pending_review' || raw === 'untrusted') return 'pending_review'
  if (raw === 'modified' || raw === 'modified_requires_reapproval') return 'modified_requires_reapproval'
  if (raw === 'not_installed' || raw === 'missing') return 'not_installed'
  if (raw === 'unknown') return 'unknown'
  return null
}

function strongestApprovalState(states: CodexHookApprovalState[]): CodexHookApprovalState {
  if (states.includes('modified_requires_reapproval')) return 'modified_requires_reapproval'
  if (states.includes('pending_review')) return 'pending_review'
  if (states.includes('approved')) return 'approved'
  if (states.every((state) => state === 'not_installed')) return 'not_installed'
  if (states.includes('not_installed') && states.length === 1) return 'not_installed'
  return 'unknown'
}

function buildProbe(detectable: boolean, approvalState: CodexHookApprovalState, sources: CodexHookApprovalSourceCheck[]): CodexHookApprovalProbe {
  return {
    schema: 'sks.codex-hook-approval-probe.v1',
    generated_at: nowIso(),
    ok: approvalState === 'approved' || approvalState === 'not_installed',
    detectable,
    approval_state: approvalState,
    sources_checked: sources,
    blockers: sources.flatMap((source) => source.blockers),
    warnings: approvalState === 'unknown' ? ['hook_approval_state_unknown'] : []
  }
}

async function persist(root: string, report: CodexHookApprovalProbe, writeReport: boolean): Promise<CodexHookApprovalProbe> {
  if (writeReport) await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'codex-hook-approval-probe.json'), report).catch(() => undefined)
  return report
}
