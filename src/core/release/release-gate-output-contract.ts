import {
  GATE_RESULT_CONTRACT,
  GATE_RESULT_CONTRACT_MODE,
  evaluateGateProcessOutput,
  parseGateResultFromStdout,
  type GateProcessEvaluation,
  type GateResultContract
} from '../commands/gate-result-contract.js'

export interface NormalizedReleaseGateOutput {
  gate_result: GateResultContract
  evaluation: GateProcessEvaluation
  line: string
}

export function normalizeReleaseGateOutput(input: {
  gateId: string
  status: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  stdout: string
}): NormalizedReleaseGateOutput {
  const childResult = parseGateResultFromStdout(input.stdout)
  const processBlockers = [
    ...(input.timedOut ? [`release_gate_timeout:${input.gateId}`] : []),
    ...(!input.timedOut && input.signal ? [`release_gate_signal:${input.gateId}:${input.signal}`] : []),
    ...(!input.timedOut && !input.signal && input.status !== 0 ? [`release_gate_exit:${input.gateId}:${String(input.status)}`] : [])
  ]
  const processOk = !input.timedOut && !input.signal && input.status === 0
  const gateResult: GateResultContract = {
    ...(childResult || {}),
    schema: GATE_RESULT_CONTRACT,
    contract_mode: GATE_RESULT_CONTRACT_MODE,
    ok: processOk && (childResult?.ok ?? true),
    blockers: dedupe([
      ...(childResult?.blockers || []),
      ...processBlockers
    ]),
    producer: 'release-gate-command-adapter',
    execution: {
      gate_id: input.gateId,
      child_contract: childResult?.schema || null,
      child_exit_code: input.status,
      child_signal: input.signal,
      timed_out: input.timedOut
    }
  }
  const line = JSON.stringify(gateResult)
  return {
    gate_result: gateResult,
    evaluation: evaluateGateProcessOutput({ status: input.status, stdout: line }),
    line
  }
}

function dedupe(values: unknown[]): unknown[] {
  const seen = new Set<string>()
  const result: unknown[] = []
  for (const value of values) {
    const key = typeof value === 'string' ? `string:${value}` : `json:${safeJson(value)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? String(value) : encoded
  } catch {
    return String(value)
  }
}
