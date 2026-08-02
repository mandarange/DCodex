import path from 'node:path';
import { readJson, writeJsonAtomic } from '../fsx.js';
import {
  normalizeExecutionControlBudget,
  normalizeExecutionControlState,
  type ExecutionControlBudget,
  type ExecutionControlState
} from '../runtime/execution-control.js';

export const QA_EXECUTION_CONTROL_ARTIFACT = 'qa-loop/execution-control.json';

export function qaExecutionBudget(input: {
  maxCycles: number;
  maxElapsedMs?: number;
  maxNoProgress?: number;
}): ExecutionControlBudget {
  return normalizeExecutionControlBudget({
    max_attempts: input.maxCycles,
    max_elapsed_ms: input.maxElapsedMs ?? 45 * 60 * 1000,
    max_tool_calls: input.maxCycles,
    max_tokens: null,
    max_no_progress: input.maxNoProgress ?? 2
  });
}

export function qaExecutionProgressFingerprint(input: {
  gate?: any;
  process?: any;
  questionBlocked?: boolean;
}) {
  const gate = input.gate?.gate || input.gate || {};
  return {
    question_blocked: input.questionBlocked === true,
    process: {
      code: finiteOrNull(input.process?.code),
      timed_out: input.process?.timed_out === true || input.process?.timedOut === true
    },
    gate: {
      passed: input.gate?.passed === true || gate.passed === true,
      reasons: strings(input.gate?.reasons || gate.reasons),
      blockers: strings(gate.blockers),
      unverified: strings(gate.unverified),
      failure_count: finiteOrNull(gate.failure_count),
      safe_fix_attempts: finiteOrNull(gate.safe_fix_attempts),
      action_count: count(gate.actions || gate.action_ledger),
      observation_count: count(gate.observations || gate.observation_ledger),
      assertion_count: count(gate.assertions || gate.assertion_ledger),
      finding_count: count(gate.findings || gate.finding_ledger),
      fix_count: count(gate.fixes || gate.fix_ledger),
      replay_count: count(gate.replays || gate.replay_ledger)
    }
  };
}

export async function readQaExecutionControl(dir: string): Promise<ExecutionControlState> {
  return normalizeExecutionControlState(await readJson(path.join(dir, QA_EXECUTION_CONTROL_ARTIFACT), null));
}

export async function writeQaExecutionControl(dir: string, state: ExecutionControlState) {
  await writeJsonAtomic(path.join(dir, QA_EXECUTION_CONTROL_ARTIFACT), state);
  return state;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))].sort() : [];
}

function count(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function finiteOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
