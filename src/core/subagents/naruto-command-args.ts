import { uniqueStrings } from '../text/strings.js'
import {
  NARUTO_CREDENTIAL_BOOLEAN_FLAGS,
  NARUTO_CREDENTIAL_VALUE_FLAGS
} from './naruto-command-input-contract.js'
import {
  resolveNarutoCredentialPolicy,
  type NarutoCredentialPolicy
} from './naruto-host-credentials.js'
import {
  DEFAULT_SUBAGENT_EFFORT,
  DEFAULT_SUBAGENT_MODEL,
  NARUTO_PARENT_EFFORT,
  NARUTO_PARENT_MODEL
} from './model-policy.js'
import { HARD_NARUTO_MAX_THREADS } from './thread-budget.js'

type NarutoAction = 'run' | 'status' | 'subagents' | 'proof' | 'parent-summary' | 'help'

export interface NarutoArgs {
  action: NarutoAction
  prompt: string
  requestedSubagents: number | undefined
  maxThreads: number | undefined
  missionId: string
  json: boolean
  stdin: boolean
  readOnly: boolean
  trustedProject: boolean
  argumentErrors: string[]
  credentialPolicy: NarutoCredentialPolicy
}

export function parseNarutoArgs(args: string[]): NarutoArgs {
  const helpRequested = args.includes('--help') || args.includes('-h')
  const validationArgs = [...args]
  const normalized = helpRequested
    ? ['help', ...(args.includes('--json') ? ['--json'] : [])]
    : args
  const first = normalized[0] && !normalized[0].startsWith('-') ? normalized[0] : ''
  const actionName = first
  const actions = new Set(['run', 'status', 'subagents', 'proof', 'parent-summary', 'help'])
  const action = (actions.has(actionName) ? actionName : 'run') as NarutoAction
  const explicitAction = actions.has(actionName)
  const rest = explicitAction ? normalized.slice(1) : normalized
  const optionArgs = validationArgs.includes('--') ? validationArgs.slice(0, validationArgs.indexOf('--')) : validationArgs
  const agentsOption = optionValue(optionArgs, '--agents')
  const maxThreadsOption = optionValue(optionArgs, '--max-threads')
  const missionOption = optionValue(optionArgs, '--mission')
  const missionIdOption = optionValue(optionArgs, '--mission-id')
  const credentialOptions = NARUTO_CREDENTIAL_VALUE_FLAGS.map((name) => ({
    name,
    option: optionValue(optionArgs, name)
  }))
  const argumentErrors = uniqueStrings([
    ...optionErrors('--agents', agentsOption, true),
    ...optionErrors('--max-threads', maxThreadsOption, true),
    ...optionErrors('--mission', missionOption, false),
    ...optionErrors('--mission-id', missionIdOption, false),
    ...credentialOptions.flatMap(({ name, option }) => optionErrors(name, option, false)),
    ...booleanOptionErrors(validationArgs),
    ...unknownOptionErrors(validationArgs)
  ])
  if (first && !explicitAction) argumentErrors.push(`unknown_subcommand:${String(first).toLowerCase()}`)
  const requestedSubagents = strictPositiveInteger(agentsOption.value)
  const maxThreads = strictPositiveInteger(maxThreadsOption.value)
  if (requestedSubagents !== undefined && requestedSubagents > HARD_NARUTO_MAX_THREADS) {
    argumentErrors.push(`exceeds_hard_thread_cap:--agents=${requestedSubagents}:${HARD_NARUTO_MAX_THREADS}`)
  }
  if (maxThreads !== undefined && maxThreads > HARD_NARUTO_MAX_THREADS) {
    argumentErrors.push(`exceeds_hard_thread_cap:--max-threads=${maxThreads}:${HARD_NARUTO_MAX_THREADS}`)
  }
  const missionFlag = missionOption.value ?? missionIdOption.value
  const positional = positionalValues(rest)
  const positionalMission = action === 'status' || action === 'subagents' || action === 'proof'
    ? positional.find((value) => value === 'latest' || /^M-/.test(value))
    : undefined
  const prompt = action === 'run' ? positional.join(' ').trim() : ''
  const positionalHead = String(positional[0] || '').toLowerCase()
  const subcommandNames = new Set(['run', 'status', 'subagents', 'proof', 'parent-summary', 'help'])
  if (!first && !explicitAction && positionalHead && !subcommandNames.has(positionalHead)) {
    argumentErrors.push(`unknown_subcommand:${positionalHead}`)
  }
  if (explicitAction && action === 'run' && subcommandNames.has(positionalHead)) {
    argumentErrors.push(`misplaced_subcommand:${positionalHead}`)
  } else if (!explicitAction && subcommandNames.has(positionalHead)) {
    argumentErrors.push(`misplaced_subcommand:${positionalHead}`)
  }
  if (action !== 'run') {
    let missionConsumed = false
    for (const value of positional) {
      if (!missionConsumed && positionalMission !== undefined && value === positionalMission) {
        missionConsumed = true
        continue
      }
      const normalizedValue = String(value || '').toLowerCase()
      if (subcommandNames.has(normalizedValue)) {
        argumentErrors.push(`misplaced_subcommand:${normalizedValue}`)
      } else {
        argumentErrors.push(`unexpected_positional:${value}`)
      }
    }
  }
  if (action === 'run' && !prompt) argumentErrors.push('empty_task')
  const presentRunOnlyOptions = [
    ...(agentsOption.present ? ['--agents'] : []),
    ...(maxThreadsOption.present ? ['--max-threads'] : []),
    ...credentialOptions.filter(({ option }) => option.present).map(({ name }) => name),
    ...(normalized.includes('--readonly') ? ['--readonly'] : []),
    ...(normalized.includes('--read-only') ? ['--read-only'] : []),
    ...(normalized.includes('--trusted-project') ? ['--trusted-project'] : []),
    ...(normalized.includes('--no-forced-login-method') ? ['--no-forced-login-method'] : [])
  ]
  if (action === 'parent-summary') {
    if (!missionOption.present || !missionOption.value || missionOption.value === 'latest') {
      argumentErrors.push('parent_summary_requires_explicit_mission')
    }
    if (missionIdOption.present) argumentErrors.push('parent_summary_mission_id_alias_not_supported')
    if (!normalized.includes('--stdin')) argumentErrors.push('parent_summary_requires_stdin')
    if (presentRunOnlyOptions.length > 0) argumentErrors.push('parent_summary_unsupported_run_option')
  } else {
    if (action !== 'run' && action !== 'help') {
      for (const name of presentRunOnlyOptions) {
        argumentErrors.push(`option_not_supported_for_action:${action}:${name}`)
      }
    }
    if (normalized.includes('--stdin')) argumentErrors.push('stdin_only_supported_for_parent_summary')
  }
  return {
    action,
    prompt,
    requestedSubagents,
    maxThreads,
    missionId: String(missionFlag || positionalMission || 'latest'),
    json: normalized.includes('--json'),
    stdin: normalized.includes('--stdin'),
    readOnly: normalized.includes('--readonly') || normalized.includes('--read-only'),
    trustedProject: optionArgs.includes('--trusted-project'),
    argumentErrors: uniqueStrings(argumentErrors),
    credentialPolicy: resolveNarutoCredentialPolicy({
      args: action === 'run' ? optionArgs : [],
      env: action === 'run' ? process.env : {},
      defaultParentModel: NARUTO_PARENT_MODEL,
      defaultParentEffort: NARUTO_PARENT_EFFORT,
      defaultSubagentModel: DEFAULT_SUBAGENT_MODEL,
      defaultSubagentEffort: DEFAULT_SUBAGENT_EFFORT
    })
  }
}

function positionalValues(args: string[]) {
  const valueFlags = new Set([
    '--agents', '--max-threads', '--mission', '--mission-id',
    ...NARUTO_CREDENTIAL_VALUE_FLAGS
  ])
  const booleanFlags = new Set([
    '--json', '--stdin', '--readonly', '--read-only', '--trusted-project',
    ...NARUTO_CREDENTIAL_BOOLEAN_FLAGS
  ])
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || ''
    if (arg === '--') {
      result.push(...args.slice(index + 1))
      break
    }
    if (valueFlags.has(arg)) {
      index += 1
      continue
    }
    if ([...valueFlags].some((flag) => arg.startsWith(`${flag}=`))) continue
    if (booleanFlags.has(arg)) continue
    if (!arg.startsWith('--')) result.push(arg)
  }
  return result
}

function optionValue(args: string[], name: string) {
  const values: Array<string | undefined> = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || ''
    if (arg === name) {
      const next = args[index + 1]
      values.push(next && !next.startsWith('--') ? next : undefined)
      continue
    }
    if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1) || undefined)
  }
  return {
    present: values.length > 0,
    value: values.at(-1),
    missing: values.some((value) => value === undefined),
    duplicate: values.length > 1
  }
}

function strictPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (!/^\d+$/.test(String(value))) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function optionErrors(name: string, option: ReturnType<typeof optionValue>, numeric: boolean): string[] {
  const errors: string[] = []
  if (option.missing) errors.push(`missing_option_value:${name}`)
  if (option.duplicate) errors.push(`duplicate_option:${name}`)
  if (numeric && option.present && option.value !== undefined && strictPositiveInteger(option.value) === undefined) {
    errors.push(`invalid_positive_integer:${name}=${option.value}`)
  }
  return errors
}

function unknownOptionErrors(args: string[]): string[] {
  const canonical = new Set([
    '--agents', '--max-threads', '--mission', '--mission-id',
    '--json', '--stdin', '--readonly', '--read-only', '--trusted-project', '--help', '-h', '--',
    ...NARUTO_CREDENTIAL_VALUE_FLAGS,
    ...NARUTO_CREDENTIAL_BOOLEAN_FLAGS
  ])
  const errors: string[] = []
  const optionArgs = args.includes('--') ? args.slice(0, args.indexOf('--')) : args
  for (const arg of optionArgs) {
    if (!arg.startsWith('-') || arg === '-') continue
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    if (!canonical.has(name)) errors.push(`unsupported_argument:${name}`)
  }
  return errors
}

function booleanOptionErrors(args: string[]): string[] {
  const booleanNames = new Set([
    '--json',
    '--stdin',
    '--readonly',
    '--read-only',
    '--trusted-project',
    ...NARUTO_CREDENTIAL_BOOLEAN_FLAGS,
    '--help',
    '-h'
  ])
  const optionArgs = args.includes('--') ? args.slice(0, args.indexOf('--')) : args
  const errors: string[] = []
  for (const arg of optionArgs) {
    if (!arg.includes('=')) continue
    const name = arg.slice(0, arg.indexOf('='))
    if (booleanNames.has(name)) errors.push(`boolean_option_value_not_supported:${name}`)
  }
  return errors
}
