import { runCodexTask as runTask } from './codex-task-runner.js'

export interface RequestedScopeContract {
  id?: string
  route?: string
  read_only?: boolean
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  allowed_paths?: string[]
  write_paths?: string[]
  user_confirmed_full_access?: boolean
  mad_sks_authorized?: boolean
  resume_thread_id?: string | null
  [key: string]: unknown
}

export type CodexControlBackend =
  | 'codex-sdk'
  | 'python-codex-sdk'
  | 'local-llm'
  | 'fake'

export type CodexControlBackendFamily =
  | 'remote-gpt'
  | 'python-sdk'
  | 'local-llm'
  | 'fake'

export interface CodexTaskInput {
  route: string
  tier?: 'orchestrator' | 'worker'
  missionId: string
  workItemId?: string
  slotId?: string
  generationIndex?: number
  sessionId?: string
  cwd: string
  prompt: string
  inputFiles?: string[]
  inputImages?: string[]
  outputSchemaId: string
  outputSchema: Record<string, unknown>
  sandboxPolicy: 'read-only' | 'workspace-write' | 'full-access'
  requestedScopeContract: RequestedScopeContract
  reliabilityPolicy?: {
    maxEmptyResultRetries?: number
    idleTimeoutMs?: number
    hardTimeoutMs?: number
    deadlineEpochMs?: number
    timeoutClass?: 'short' | 'standard' | 'long'
  }
  backendPreference?: CodexControlBackend[]
  allowLocalLlm?: boolean
  localLlmPolicy?: {
    mode: 'worker_only' | 'local_preferred' | 'local_only' | 'disabled'
    requiresGptFinal: boolean
  }
  mutationLedgerRoot: string
  model?: string | null
  reasoningEffort?: string | null
  modelReasoningEffort?: string | null
  serviceTier?: 'fast' | 'standard' | string | null
}

export interface CodexTaskResult {
  ok: boolean
  backend: CodexControlBackend
  backend_family: CodexControlBackendFamily
  sdkThreadId: string
  sdkRunId: string | null
  streamEventCount: number
  structuredOutputValid: boolean
  workerResultPath: string
  patchEnvelopePath?: string | null
  localLlmProofPath?: string | null
  pythonSdkProofPath?: string | null
  blockers: string[]
  reliabilityShield?: Record<string, unknown>
  ultraRouterDecision?: Record<string, unknown>
}

export async function runCodexTask(input: CodexTaskInput): Promise<CodexTaskResult & Record<string, unknown>> {
  return runTask(input)
}
