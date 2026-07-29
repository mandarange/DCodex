export type CommandRisk = 'R0' | 'R1' | 'R2' | 'R3';
export type CommandLatency = 'fast' | 'normal' | 'long';

export const NARUTO_ACTIONS = ['run', 'status', 'subagents', 'proof', 'parent-summary', 'help'] as const;
export type NarutoAction = typeof NARUTO_ACTIONS[number];

export interface CommandContractV3 {
  schema: 'sks.command-contract.v3';
  name: string;
  description: string;
  maturity: 'stable' | 'preview' | 'labs';
  read_only: boolean;
  risk: CommandRisk;
  latency: CommandLatency;
  supports_json: boolean;
  remote_allowed: boolean;
  input_schema: Record<string, unknown>;
  argv_builder: (input: unknown) => string[];
  required_capabilities: string[];
}

export interface JsonSchemaIssue {
  path: string;
  code: string;
  message: string;
}

export type JsonSchemaValidation =
  | { ok: true; value: Record<string, unknown>; issues: [] }
  | { ok: false; value: null; issues: JsonSchemaIssue[] };

export interface CommandContractRegistryValidation {
  ok: boolean;
  issues: string[];
  expected_names: string[];
  observed_names: string[];
}
