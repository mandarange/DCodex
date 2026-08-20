import { exists, readText } from '../fsx.js'
import { escapeRegExp } from '../text/regex.js'
import { safeWriteCodexConfigToml } from '../codex-runtime/codex-desktop-config-policy.js'
import { codexUserConfigPath, readTopLevelTomlString } from './codex-model-catalog.js'
import { isCodexAppRunningByBundleId } from './menubar/config.js'
import { restartCodexApp } from './codex-app-restart.js'

export const CODEX_CONTEXT_1M_SCHEMA = 'sks.codex-context-1m.v1'
// Inline marker: keeping ownership and the pre-enable value on the key line
// itself means the pair can never be separated by another writer, and the
// mode-lock provenance scan in codex-config-guard stops at these keys before
// it can misattribute the operator's `model` line to SKS.
export const CODEX_CONTEXT_1M_MARKER = 'sks-codex-context-1m'
export const CODEX_CONTEXT_1M_TARGETS = {
  model_context_window: 1_000_000,
  model_auto_compact_token_limit: 900_000
} as const
// The 1M opt-in is documented by OpenAI for GPT-5.6 Sol only; the keys are
// global and not model-aware, so a smaller-window model would overflow.
export const CODEX_CONTEXT_1M_MODEL = 'gpt-5.6-sol'

export type CodexContext1mKey = keyof typeof CODEX_CONTEXT_1M_TARGETS
const MANAGED_KEYS = Object.keys(CODEX_CONTEXT_1M_TARGETS) as CodexContext1mKey[]

export interface CodexContext1mKeyState {
  present: boolean
  managed: boolean
  value: number | null
  previous: number | 'unset' | null
  duplicate: boolean
}

export interface CodexContext1mInspection {
  enabled: boolean
  model: string | null
  keys: Record<CodexContext1mKey, CodexContext1mKeyState>
  warnings: string[]
}

function topLevelRegionEnd(lines: string[]): number {
  const first = lines.findIndex((line) => /^\s*\[.+\]\s*$/.test(line))
  return first === -1 ? lines.length : first
}

function managedLine(key: CodexContext1mKey, previous: number | 'unset'): string {
  return `${key} = ${CODEX_CONTEXT_1M_TARGETS[key]} # ${CODEX_CONTEXT_1M_MARKER} prev=${previous}`
}

function inspectKeyLines(lines: string[], key: CodexContext1mKey): CodexContext1mKeyState & { lineIndex: number } {
  const end = topLevelRegionEnd(lines)
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  const managedPattern = new RegExp(
    `^\\s*${escapeRegExp(key)}\\s*=\\s*(\\d+)\\s*#\\s*${escapeRegExp(CODEX_CONTEXT_1M_MARKER)}\\s+prev=(unset|\\d+)\\s*$`
  )
  const valuePattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(\\d+)\\s*(?:#.*)?$`)
  let state: (CodexContext1mKeyState & { lineIndex: number }) | null = null
  let duplicate = false
  for (let index = 0; index < end; index += 1) {
    const line = lines[index] || ''
    if (!keyPattern.test(line)) continue
    if (state) {
      duplicate = true
      continue
    }
    const managed = line.match(managedPattern)
    const value = line.match(valuePattern)
    state = {
      present: true,
      managed: Boolean(managed),
      value: managed ? Number(managed[1]) : value ? Number(value[1]) : null,
      previous: managed ? (managed[2] === 'unset' ? 'unset' : Number(managed[2])) : null,
      duplicate: false,
      lineIndex: index
    }
  }
  if (!state) return { present: false, managed: false, value: null, previous: null, duplicate: false, lineIndex: -1 }
  return { ...state, duplicate }
}

export function inspectCodexContext1m(text: string): CodexContext1mInspection {
  const lines = String(text || '').split('\n')
  const warnings: string[] = []
  const keys = {} as Record<CodexContext1mKey, CodexContext1mKeyState>
  for (const key of MANAGED_KEYS) {
    const { lineIndex: _lineIndex, ...state } = inspectKeyLines(lines, key)
    keys[key] = state
    if (state.duplicate) warnings.push(`codex_context_duplicate_key:${key}`)
    if (state.managed && state.value !== CODEX_CONTEXT_1M_TARGETS[key]) warnings.push(`codex_context_managed_value_drift:${key}`)
  }
  const enabled = MANAGED_KEYS.every((key) => keys[key].managed && keys[key].value === CODEX_CONTEXT_1M_TARGETS[key])
  return { enabled, model: readTopLevelTomlString(String(text || ''), 'model'), keys, warnings }
}

export interface CodexContext1mMutation {
  next: string
  changed: boolean
  previous: Partial<Record<CodexContext1mKey, number | 'unset'>>
  restored: Partial<Record<CodexContext1mKey, number | 'unset'>>
  blockers: string[]
  warnings: string[]
}

export function enableCodexContext1m(text: string): CodexContext1mMutation {
  const source = String(text || '')
  const lines = source.split('\n')
  const blockers: string[] = []
  const previous: Partial<Record<CodexContext1mKey, number | 'unset'>> = {}
  for (const key of MANAGED_KEYS) {
    const state = inspectKeyLines(lines, key)
    if (state.duplicate) blockers.push(`codex_context_duplicate_key:${key}`)
    if (state.present && !state.managed && state.value === null) blockers.push(`codex_context_unparseable_value:${key}`)
  }
  if (blockers.length) return { next: source, changed: false, previous: {}, restored: {}, blockers, warnings: [] }
  for (const key of MANAGED_KEYS) {
    const state = inspectKeyLines(lines, key)
    if (state.present) {
      const prior = state.managed ? (state.previous ?? 'unset') : (state.value as number)
      previous[key] = prior
      lines[state.lineIndex] = managedLine(key, prior)
    } else {
      previous[key] = 'unset'
      lines.splice(topLevelRegionEnd(lines), 0, managedLine(key, 'unset'))
    }
  }
  const next = lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n')
  return { next, changed: next !== source, previous, restored: {}, blockers: [], warnings: [] }
}

export function disableCodexContext1m(text: string): CodexContext1mMutation {
  const source = String(text || '')
  const lines = source.split('\n')
  const warnings: string[] = []
  const restored: Partial<Record<CodexContext1mKey, number | 'unset'>> = {}
  for (const key of MANAGED_KEYS) {
    const state = inspectKeyLines(lines, key)
    if (state.duplicate) {
      return { next: source, changed: false, previous: {}, restored: {}, blockers: [`codex_context_duplicate_key:${key}`], warnings: [] }
    }
    if (!state.present) continue
    if (!state.managed) {
      // A value SKS never wrote stays host-owned; disable never deletes it.
      warnings.push(`codex_context_unmanaged_key_left:${key}`)
      continue
    }
    const prior = state.previous ?? 'unset'
    restored[key] = prior
    if (prior === 'unset') lines.splice(state.lineIndex, 1)
    else lines[state.lineIndex] = `${key} = ${prior}`
  }
  const next = lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n')
  return { next, changed: next !== source, previous: {}, restored, blockers: [], warnings }
}

export type CodexContext1mAction = 'status' | 'on' | 'off'

export function normalizeCodexContext1mAction(value: unknown): CodexContext1mAction {
  const text = String(value || 'status').toLowerCase()
  if (['on', 'enable', 'enabled', '1m'].includes(text)) return 'on'
  if (['off', 'disable', 'disabled', 'default'].includes(text)) return 'off'
  return 'status'
}

export interface CodexContext1mRestartOutcome {
  attempted: boolean
  running: boolean | null
  status: string
  reason: string | null
  ok: boolean
  blockers: string[]
}

export interface CodexContext1mCommandOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  root?: string
  isRunningImpl?: typeof isCodexAppRunningByBundleId
  restartImpl?: typeof restartCodexApp
}

export async function codexContext1mCommand(args: string[] = [], opts: CodexContext1mCommandOptions = {}) {
  const env = opts.env || process.env
  const action = normalizeCodexContext1mAction(args[0])
  const noRestart = args.includes('--no-restart')
  const configPath = codexUserConfigPath({ env, ...(opts.home ? { home: opts.home } : {}) })
  const before = String(await readText(configPath, ''))
  const fileExists = await exists(configPath)
  const blockers: string[] = []
  const warnings: string[] = []
  let write: Awaited<ReturnType<typeof safeWriteCodexConfigToml>> | null = null
  let changed = false
  let afterText = before
  let mutation: CodexContext1mMutation | null = null

  if (action === 'on' || action === 'off') {
    mutation = action === 'on' ? enableCodexContext1m(before) : disableCodexContext1m(before)
    blockers.push(...mutation.blockers)
    warnings.push(...mutation.warnings)
    if (!blockers.length && mutation.changed) {
      write = await safeWriteCodexConfigToml(configPath, before, mutation.next, 'codex-context-1m', {
        verifyUnchangedBeforeWrite: true,
        expectedBeforeExists: fileExists
      })
      if (!write.ok) {
        blockers.push(`codex_config_write_${write.status}`)
      } else {
        changed = write.changed
        afterText = write.expected_after?.text ?? mutation.next
      }
    }
  }

  const inspection = inspectCodexContext1m(afterText)
  warnings.push(...inspection.warnings)
  if (action === 'on' || inspection.enabled) {
    if (!inspection.model) warnings.push('codex_context_model_line_missing')
    else if (inspection.model !== CODEX_CONTEXT_1M_MODEL) warnings.push(`codex_context_active_model_not_${CODEX_CONTEXT_1M_MODEL}:${inspection.model}`)
  }

  let restart: CodexContext1mRestartOutcome | null = null
  if ((action === 'on' || action === 'off') && !blockers.length) {
    restart = await maybeRestartCodexApp({
      env,
      changed,
      noRestart,
      ...(opts.root === undefined ? {} : { root: opts.root }),
      ...(opts.isRunningImpl === undefined ? {} : { isRunningImpl: opts.isRunningImpl }),
      ...(opts.restartImpl === undefined ? {} : { restartImpl: opts.restartImpl })
    })
    if (restart.attempted && !restart.ok) warnings.push('codex_restart_failed_manual_restart_required')
  }

  return {
    schema: CODEX_CONTEXT_1M_SCHEMA,
    ok: blockers.length === 0,
    action,
    enabled: inspection.enabled,
    config_path: configPath,
    model: inspection.model,
    expected_model: CODEX_CONTEXT_1M_MODEL,
    target: { ...CODEX_CONTEXT_1M_TARGETS },
    keys: inspection.keys,
    previous: mutation && action === 'on' ? mutation.previous : null,
    restored: mutation && action === 'off' ? mutation.restored : null,
    changed,
    write: write ? { status: write.status, backup_path: write.backup_path } : null,
    restart,
    blockers,
    warnings,
    notes: [
      'Only new Codex sessions pick up context-window changes; existing conversations keep their previous limits.',
      'Requests with more than 272K input tokens are billed at the long-context rate (2x input / 1.5x output) for the entire request.'
    ],
    cli_commands: {
      status: 'sks codex-app context-1m status',
      on: 'sks codex-app context-1m on',
      off: 'sks codex-app context-1m off'
    }
  }
}

async function maybeRestartCodexApp(input: {
  env: NodeJS.ProcessEnv
  changed: boolean
  noRestart: boolean
  root?: string
  isRunningImpl?: typeof isCodexAppRunningByBundleId
  restartImpl?: typeof restartCodexApp
}): Promise<CodexContext1mRestartOutcome> {
  const skippedOutcome = (reason: string): CodexContext1mRestartOutcome => (
    { attempted: false, running: null, status: 'skipped', reason, ok: true, blockers: [] }
  )
  if (input.noRestart) return skippedOutcome('no_restart_flag')
  if (!input.changed) return skippedOutcome('config_unchanged')
  if (input.env.SKS_SKIP_CODEX_APP_RESTART === '1') return skippedOutcome('SKS_SKIP_CODEX_APP_RESTART')
  if (process.platform !== 'darwin') return skippedOutcome('not_macos')
  const bundleId = String(input.env.SKS_CODEX_APP_BUNDLE_ID || 'com.openai.codex')
  const running = await (input.isRunningImpl || isCodexAppRunningByBundleId)(bundleId, input.env)
  if (!running) {
    // SKS never launches Codex on its own; the new config applies on next launch.
    return { attempted: false, running: false, status: 'skipped', reason: 'codex_not_running', ok: true, blockers: [] }
  }
  const result = await (input.restartImpl || restartCodexApp)({ env: input.env, ...(input.root ? { root: input.root } : {}) })
  return { attempted: true, running: true, status: result.status, reason: null, ok: result.ok, blockers: result.blockers }
}
