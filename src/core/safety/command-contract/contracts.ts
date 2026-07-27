import {
  COMMANDS,
  type CommandEntry,
  type CommandInputProfile,
  type CommandName
} from '../../../cli/command-registry.js';
import type {
  CommandContractRegistryValidation,
  CommandContractV2,
  CommandLatency
} from './types.js';
import { NARUTO_ACTIONS } from './types.js';

type JsonObject = Record<string, unknown>;
type ArgvBuilder = (input: JsonObject) => string[];

interface ArgumentProfile {
  schema: JsonObject;
  build: ArgvBuilder;
}

const ARGUMENT_PROFILES: Record<CommandInputProfile, ArgumentProfile> = {
  none: {
    schema: objectSchema({}),
    build: () => []
  },
  'json-only': {
    schema: objectSchema({ json: { type: 'boolean' } }),
    build: jsonFlag
  },
  naruto: {
    schema: objectSchema({
      action: { type: 'string', enum: [...NARUTO_ACTIONS] },
      task: boundedString(1, 32_768),
      prompt: boundedString(1, 32_768),
      mission: boundedString(1, 160),
      agents: { type: 'integer', minimum: 1 },
      max_threads: { type: 'integer', minimum: 1 },
      stdin: { type: 'boolean' },
      readonly: { type: 'boolean' },
      trusted_project: { type: 'boolean' },
      json: { type: 'boolean' }
    }),
    build: (input) => {
      const task = typeof input.prompt === 'string'
        ? input.prompt
        : typeof input.task === 'string'
          ? input.task
          : '';
      const action = stringValue(input.action, task ? 'run' : 'help');
      return [
        action,
        ...(task ? [task] : []),
        ...valueFlag(input, 'mission', '--mission'),
        ...numberFlag(input, 'agents', '--agents'),
        ...numberFlag(input, 'max_threads', '--max-threads'),
        ...booleanFlag(input, 'stdin', '--stdin'),
        ...booleanFlag(input, 'readonly', '--readonly'),
        ...booleanFlag(input, 'trusted_project', '--trusted-project'),
        ...jsonFlag(input)
      ];
    }
  },
  paths: {
    schema: objectSchema({
      action: { type: 'string', enum: ['managed', 'git-policy'] },
      json: { type: 'boolean' }
    }),
    build: (input) => [stringValue(input.action, 'managed'), ...jsonFlag(input)]
  },
  'pipeline-status': {
    schema: objectSchema({
      action: { type: 'string', enum: ['status'] },
      json: { type: 'boolean' }
    }),
    build: (input) => [stringValue(input.action, 'status'), ...jsonFlag(input)]
  },
  stats: {
    schema: objectSchema({ full: { type: 'boolean' }, json: { type: 'boolean' } }),
    build: (input) => [...booleanFlag(input, 'full', '--full'), ...jsonFlag(input)]
  },
  'stop-gate': {
    schema: objectSchema({
      route: boundedString(1, 80),
      mission: boundedString(1, 160),
      gate: boundedString(1, 1024),
      json: { type: 'boolean' }
    }),
    build: (input) => [
      'check',
      ...valueFlag(input, 'route', '--route'),
      ...valueFlag(input, 'mission', '--mission'),
      ...valueFlag(input, 'gate', '--gate'),
      ...jsonFlag(input)
    ]
  },
  proof: {
    schema: objectSchema({
      action: { type: 'string', enum: ['show', 'latest', 'validate', 'route'] },
      mission: boundedString(1, 160),
      completion: { type: 'boolean' },
      json: { type: 'boolean' }
    }),
    build: (input) => {
      const action = stringValue(input.action, 'show');
      const mission = typeof input.mission === 'string' && action === 'route' ? [input.mission] : [];
      return [action, ...mission, ...booleanFlag(input, 'completion', '--completion'), ...jsonFlag(input)];
    }
  },
  trust: {
    schema: objectSchema({
      action: { type: 'string', enum: ['report', 'status', 'explain'] },
      mission: boundedString(1, 160),
      json: { type: 'boolean' }
    }),
    build: (input) => [
      stringValue(input.action, 'status'),
      ...(typeof input.mission === 'string' ? [input.mission] : []),
      ...jsonFlag(input)
    ]
  },
  gates: {
    schema: objectSchema({
      target: boundedString(1, 120),
      mode: { type: 'string', enum: ['preset', 'gate'] },
      full: { type: 'boolean' },
      json: { type: 'boolean' }
    }),
    build: (input) => {
      const target = stringValue(input.target, 'affected');
      const selector = input.mode === 'gate' ? ['--gate', target] : ['--preset', target];
      return ['run', ...selector, ...booleanFlag(input, 'full', '--full'), ...jsonFlag(input)];
    }
  },
  'validate-artifacts': {
    schema: objectSchema({
      mission: boundedString(1, 160),
      required: {
        type: 'array',
        items: boundedString(1, 80),
        maxItems: 32
      },
      json: { type: 'boolean' }
    }),
    build: (input) => [
      ...(typeof input.mission === 'string' ? [input.mission] : []),
      ...(Array.isArray(input.required) && input.required.length > 0 ? ['--required', input.required.join(',')] : []),
      ...jsonFlag(input)
    ]
  }
};

function objectSchema(properties: JsonObject): JsonObject {
  return { type: 'object', properties, additionalProperties: false };
}

function boundedString(minLength: number, maxLength: number): JsonObject {
  return { type: 'string', minLength, maxLength };
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function jsonFlag(input: JsonObject): string[] {
  return input.json === true ? ['--json'] : [];
}

function booleanFlag(input: JsonObject, key: string, flag: string): string[] {
  return input[key] === true ? [flag] : [];
}

function valueFlag(input: JsonObject, key: string, flag: string): string[] {
  return typeof input[key] === 'string' ? [flag, input[key] as string] : [];
}

function numberFlag(input: JsonObject, key: string, flag: string): string[] {
  return typeof input[key] === 'number' ? [flag, String(input[key])] : [];
}

function maturityFor(command: CommandEntry): CommandContractV2['maturity'] {
  return command.maturity === 'beta' ? 'preview' : command.maturity;
}

function buildContract(name: CommandName, command: CommandEntry): CommandContractV2 {
  const profile = ARGUMENT_PROFILES[command.inputProfile];
  const r3Denied = command.risk === 'R3';
  const remoteAllowed = !r3Denied && command.remoteAllowed;
  return {
    schema: 'sks.command-contract.v2',
    name,
    description: command.summary,
    maturity: maturityFor(command),
    read_only: command.risk === 'R0',
    risk: command.risk,
    latency: command.latency,
    supports_json: command.supportsJson,
    remote_allowed: remoteAllowed,
    telegram_allowed: remoteAllowed && command.telegramAllowed,
    input_schema: profile.schema,
    argv_builder: (input: unknown) => [name, ...profile.build((input ?? {}) as JsonObject)],
    required_capabilities: [...command.requiredCapabilities]
  };
}

let cachedContracts: Map<CommandName, CommandContractV2> | null = null;

export function commandContracts(): Map<CommandName, CommandContractV2> {
  if (cachedContracts) return cachedContracts;
  cachedContracts = new Map(
    (Object.keys(COMMANDS) as CommandName[])
      .sort()
      .map((name) => [name, buildContract(name, COMMANDS[name])])
  );
  return cachedContracts;
}

export function commandContract(name: string): CommandContractV2 | null {
  return commandContracts().get(name as CommandName) ?? null;
}

export function validateCommandContractRegistry(): CommandContractRegistryValidation {
  const expectedNames = (Object.keys(COMMANDS) as CommandName[]).sort();
  const contracts = commandContracts();
  const observedNames = [...contracts.keys()].sort();
  const issues: string[] = [];
  for (const name of expectedNames) {
    const command = COMMANDS[name];
    const contract = contracts.get(name);
    if (!contract) {
      issues.push(`missing_contract:${name}`);
      continue;
    }
    if (contract.schema !== 'sks.command-contract.v2') issues.push(`invalid_schema:${name}`);
    if (contract.name !== name) issues.push(`name_mismatch:${name}`);
    if (contract.risk !== command.risk) issues.push(`risk_mismatch:${name}`);
    if (contract.latency !== command.latency) issues.push(`latency_mismatch:${name}`);
    if (contract.supports_json !== command.supportsJson) issues.push(`json_support_mismatch:${name}`);
    if (command.risk === 'R3' && (command.remoteAllowed || command.telegramAllowed)) issues.push(`r3_metadata_exposed:${name}`);
    if (contract.risk === 'R3' && (contract.remote_allowed || contract.telegram_allowed)) issues.push(`r3_exposed:${name}`);
    if (command.telegramAllowed && !command.remoteAllowed) issues.push(`telegram_metadata_without_remote:${name}`);
    if (contract.telegram_allowed && !contract.remote_allowed) issues.push(`telegram_without_remote:${name}`);
    if (contract.input_schema.type !== 'object' || contract.input_schema.additionalProperties !== false) issues.push(`unsafe_schema:${name}`);
    if (command.supportsJson && command.inputProfile === 'none') issues.push(`json_support_without_input_profile:${name}`);
    if (command.inputProfile !== 'none' && !command.supportsJson) issues.push(`profile_without_json_support:${name}`);
    if (command.remoteAllowed && command.inputProfile === 'none') issues.push(`remote_without_input_profile:${name}`);
  }
  for (const name of observedNames) {
    if (!(name in COMMANDS)) issues.push(`unexpected_contract:${name}`);
  }
  return { ok: issues.length === 0, issues, expected_names: expectedNames, observed_names: observedNames };
}

export function timeoutFor(latency: CommandLatency): number {
  if (latency === 'fast') return 15_000;
  if (latency === 'normal') return 60_000;
  return 180_000;
}

export function outputCapFor(latency: CommandLatency): number {
  if (latency === 'fast') return 128 * 1024;
  if (latency === 'normal') return 512 * 1024;
  return 1024 * 1024;
}
