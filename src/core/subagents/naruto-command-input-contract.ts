import { NARUTO_ACTIONS } from '../safety/command-contract/types.js'
import { NARUTO_AUTH_MODES, NARUTO_EFFORT_TIERS } from './naruto-host-credentials.js'
import { HARD_NARUTO_MAX_THREADS } from './thread-budget.js'

type JsonObject = Record<string, unknown>

export const NARUTO_CREDENTIAL_VALUE_FLAGS = Object.freeze([
  '--auth-mode',
  '--model-provider',
  '--provider-env-key',
  '--parent-model',
  '--parent-effort',
  '--subagent-model',
  '--subagent-effort'
] as const)

export const NARUTO_CREDENTIAL_BOOLEAN_FLAGS = Object.freeze([
  '--no-forced-login-method'
] as const)

export const NARUTO_RUN_ONLY_INPUT_FIELDS = Object.freeze([
  'task',
  'prompt',
  'agents',
  'max_threads',
  'readonly',
  'trusted_project',
  'auth_mode',
  'model_provider',
  'provider_env_key',
  'parent_model',
  'parent_effort',
  'subagent_model',
  'subagent_effort',
  'no_forced_login_method'
] as const)

export function narutoCommandInputSchema(): JsonObject {
  const properties: JsonObject = {
    action: { type: 'string', enum: [...NARUTO_ACTIONS] },
    task: boundedString(1, 32_768),
    prompt: boundedString(1, 32_768),
    mission: boundedString(1, 160),
    agents: { type: 'integer', minimum: 1, maximum: HARD_NARUTO_MAX_THREADS },
    max_threads: { type: 'integer', minimum: 1, maximum: HARD_NARUTO_MAX_THREADS },
    stdin: { type: 'boolean' },
    readonly: { type: 'boolean' },
    trusted_project: { type: 'boolean' },
    auth_mode: { type: 'string', enum: [...NARUTO_AUTH_MODES] },
    model_provider: identifierSchema(),
    provider_env_key: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
    parent_model: identifierSchema(),
    parent_effort: { type: 'string', enum: [...NARUTO_EFFORT_TIERS] },
    subagent_model: identifierSchema(),
    subagent_effort: { type: 'string', enum: [...NARUTO_EFFORT_TIERS] },
    no_forced_login_method: { type: 'boolean' },
    json: { type: 'boolean' }
  }
  const exactlyOneTask = {
    oneOf: [
      { required: ['task'], not: { required: ['prompt'] } },
      { required: ['prompt'], not: { required: ['task'] } }
    ]
  }
  const runOnlyAbsent = absentFields(NARUTO_RUN_ONLY_INPUT_FIELDS)
  const runBranch = {
    properties: { action: { const: 'run' } },
    required: ['action'],
    allOf: [exactlyOneTask, absentFields(['stdin'])]
  }
  const implicitRunBranch = {
    not: { required: ['action'] },
    allOf: [exactlyOneTask, absentFields(['stdin'])]
  }
  const observationBranch = {
    properties: { action: { enum: ['status', 'subagents', 'proof'] } },
    required: ['action'],
    allOf: [runOnlyAbsent, absentFields(['stdin'])]
  }
  const parentSummaryBranch = {
    properties: {
      action: { const: 'parent-summary' },
      stdin: { const: true }
    },
    required: ['action', 'mission', 'stdin'],
    allOf: [runOnlyAbsent]
  }
  const helpBranch = {
    properties: { action: { const: 'help' } },
    required: ['action'],
    allOf: [runOnlyAbsent, absentFields(['mission', 'stdin'])]
  }
  const implicitHelpBranch = {
    not: {
      anyOf: [
        { required: ['action'] },
        { required: ['mission'] },
        { required: ['stdin'] },
        ...NARUTO_RUN_ONLY_INPUT_FIELDS.map((field) => ({ required: [field] }))
      ]
    }
  }
  return {
    type: 'object',
    properties,
    additionalProperties: false,
    oneOf: [
      runBranch,
      implicitRunBranch,
      observationBranch,
      parentSummaryBranch,
      helpBranch,
      implicitHelpBranch
    ]
  }
}

function absentFields(fields: readonly string[]): JsonObject {
  return {
    not: {
      anyOf: fields.map((field) => ({ required: [field] }))
    }
  }
}

function identifierSchema(): JsonObject {
  return { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' }
}

function boundedString(minLength: number, maxLength: number): JsonObject {
  return { type: 'string', minLength, maxLength }
}
