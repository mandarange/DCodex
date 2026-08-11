import { appendParallelRuntimeEvent } from '../agents/parallel-runtime-proof.js'

export interface ModelCallSemaphore {
  provider: string
  budget: number
  active: number
  queued: number
  maxObserved: number
  run<T>(fn: () => Promise<T>): Promise<T>
}

const semaphores = new Map<string, ModelCallSemaphoreImpl>()

export function getModelCallSemaphore(provider: string, budget: number): ModelCallSemaphore {
  const normalizedProvider = String(provider || 'codex-sdk')
  const normalizedBudget = Math.max(1, Math.floor(Number(budget || 1)))
  const key = `${normalizedProvider}:${normalizedBudget}`
  const existing = semaphores.get(key)
  if (existing) return existing
  const created = new ModelCallSemaphoreImpl(normalizedProvider, normalizedBudget)
  semaphores.set(key, created)
  return created
}

export async function withModelCallSlot<T>(input: {
  root: string
  missionId: string
  provider: string
  budget: number
  slotId?: string | null
  generationIndex?: number | null
  sessionId?: string | null
  backend?: string
  modelCallId?: string | null
}, fn: () => Promise<T>): Promise<T> {
  const semaphore = getModelCallSemaphore(input.provider, input.budget)
  const modelCallId = input.modelCallId || `${input.provider}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return semaphore.run(async () => {
    await appendParallelRuntimeEvent(input.root, input.missionId, {
      event_type: 'model_call_started',
      slot_id: input.slotId ?? null,
      generation_index: input.generationIndex ?? null,
      session_id: input.sessionId ?? null,
      model_call_id: modelCallId,
      backend: input.backend || input.provider,
      placement: 'unknown',
      meta: {
        provider: input.provider,
        budget: semaphore.budget,
        active_model_calls: semaphore.active,
        queued_model_calls: semaphore.queued
      }
    }).catch(() => undefined)
    try {
      return await fn()
    } finally {
      await appendParallelRuntimeEvent(input.root, input.missionId, {
        event_type: 'model_call_completed',
        slot_id: input.slotId ?? null,
        generation_index: input.generationIndex ?? null,
        session_id: input.sessionId ?? null,
        model_call_id: modelCallId,
        backend: input.backend || input.provider,
        placement: 'unknown',
        meta: {
          provider: input.provider,
          budget: semaphore.budget,
          max_observed_model_calls: semaphore.maxObserved,
          queued_model_calls: semaphore.queued
        }
      }).catch(() => undefined)
    }
  })
}

export function defaultModelCallBudget(provider: string): number {
  const text = String(provider || '')
  return envInt('SKS_REMOTE_API_PARALLEL_BUDGET', 3)
}

class ModelCallSemaphoreImpl implements ModelCallSemaphore {
  active = 0
  queued = 0
  maxObserved = 0
  private waiters: Array<() => void> = []

  constructor(public provider: string, public budget: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.budget) {
      this.active += 1
      this.maxObserved = Math.max(this.maxObserved, this.active)
      return
    }
    this.queued += 1
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.queued = Math.max(0, this.queued - 1)
    this.active += 1
    this.maxObserved = Math.max(this.maxObserved, this.active)
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.waiters.shift()
    if (next) next()
  }
}

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.floor(parsed)
}
