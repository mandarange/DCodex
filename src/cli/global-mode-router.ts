const RESERVED_COMMANDS = new Set(['help', '--help', '-h', 'version', '--version', '-v']);
const RETIRED_NARUTO_OPTION = ['--', 'naruto'].join('');
const RETIRED_AGENT_OPTION = ['--', 'agent'].join('');
const RETIRED_CLONES_OPTION = ['--', 'clones'].join('');

const RETIRED_GLOBAL_EXECUTION_OPTION_NAMES = new Set([
  RETIRED_NARUTO_OPTION,
  RETIRED_AGENT_OPTION,
  RETIRED_CLONES_OPTION,
  '--mad-db',
  '--mad-native-swarm',
  '--mad-swarm',
  '--no-swarm',
  '--no-mad-swarm',
  '--mad-agents',
  '--mad-swarm-agents',
  '--mad-swarm-work-items',
  '--mad-swarm-backend',
  '--mad-swarm-prompt',
  '--tmux-smoke',
  '--require-tmux-smoke',
  '--glm'
]);

/** @deprecated Global GLM MAD mode was removed; detectGlobalMode always returns null. */
export type GlobalMode = never;

export function detectGlobalMode(args: readonly string[] = []): null {
  void args;
  return null;
}

export function stripGlobalModeFlags(args: readonly string[]): string[] {
  return args.filter((arg) => arg !== '--mad' && arg !== '--glm');
}

export function findRetiredGlobalExecutionArgumentErrors(args: readonly string[] = []): string[] {
  const errors: string[] = [];
  for (const value of args) {
    const arg = String(value);
    const separator = arg.indexOf('=');
    const name = separator >= 0 ? arg.slice(0, separator) : arg;
    if (RETIRED_GLOBAL_EXECUTION_OPTION_NAMES.has(name)) errors.push(`unsupported_argument:${name}`);
  }
  return [...new Set(errors)];
}

export interface GlobalModeBlockedResult {
  readonly ok: false;
  readonly status: 'blocked';
  readonly mode: 'glm';
  readonly reason: 'glm_mad_removed';
  readonly hint: 'use sks bridge provider configure|validate|enable, sks bridge catalog sync, and sks bridge route set-default';
}

/** @deprecated GLM MAD CLI was removed. */
export function glmWithoutMadResult(): GlobalModeBlockedResult {
  return {
    ok: false,
    status: 'blocked',
    mode: 'glm',
    reason: 'glm_mad_removed',
    hint: 'use sks bridge provider configure|validate|enable, sks bridge catalog sync, and sks bridge route set-default'
  };
}
