import test from 'node:test'
import assert from 'node:assert/strict'
import { decideNarutoConcurrency } from '../naruto-concurrency-governor.js'

const GOVERNOR_ENV_KEYS = [
  'SKS_NARUTO_GB_PER_WORKER',
  'SKS_NARUTO_LIGHT_GB_PER_WORKER',
  'SKS_NARUTO_HEADLESS_PROCESS_CAP',
  'SKS_NARUTO_GIT_WORKTREE_CAP',
  'SKS_NARUTO_PARALLELISM',
  'SKS_NARUTO_REMOTE_API_PARALLEL_BUDGET',
  'SKS_REMOTE_API_PARALLEL_BUDGET'
] as const

function withCleanGovernorEnv<T>(overrides: Record<string, string>, run: () => T): T {
  const saved = new Map<string, string | undefined>()
  for (const key of GOVERNOR_ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value
  try {
    return run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const LIGHT_MASS_HARDWARE = {
  cores: 320,
  loadAverage: [0, 0, 0],
  freeMemoryBytes: 200 * 1024 ** 3,
  totalMemoryBytes: 256 * 1024 ** 3,
  fileDescriptorLimit: 1_048_576,
  processCount: 200
}

const HEAVY_MASS_HARDWARE = {
  cores: 1024,
  loadAverage: [0, 0, 0],
  freeMemoryBytes: 512 * 1024 ** 3,
  totalMemoryBytes: 1024 * 1024 ** 3,
  fileDescriptorLimit: 1_048_576,
  processCount: 200
}

test('governor lets light lanes scale into the hundreds when hardware budgets allow', () => {
  const governed = withCleanGovernorEnv({}, () => decideNarutoConcurrency({
    requestedWorkers: 200,
    totalWorkItems: 200,
    backend: 'worker-pool',
    parallelismMode: 'extreme',
    maxThreads: 256,
    hardware: LIGHT_MASS_HARDWARE
  }))
  assert.equal(governed.safe_active_workers, 200)
  assert.ok(governed.safe_active_workers > 32)
  assert.equal(governed.backpressure, 'normal')
  assert.equal(governed.headless_workers, governed.safe_active_workers)
})

test('governor scales heavy codex-sdk lanes honestly via the rate-limit env override', () => {
  const governed = withCleanGovernorEnv(
    { SKS_NARUTO_REMOTE_API_PARALLEL_BUDGET: '192' },
    () => decideNarutoConcurrency({
      requestedWorkers: 192,
      totalWorkItems: 192,
      backend: 'codex-sdk',
      parallelismMode: 'extreme',
      maxThreads: 256,
      hardware: HEAVY_MASS_HARDWARE
    })
  )
  assert.equal(governed.remote_codex_parallel, 192)
  assert.equal(governed.safe_active_workers, 192)
  assert.ok(governed.safe_active_workers > 32)
})

test('governor rejects 257 instead of silently clamping explicit thread intent', () => {
  assert.throws(() => withCleanGovernorEnv({}, () => decideNarutoConcurrency({
    requestedWorkers: 257,
    totalWorkItems: 257,
    maxThreads: 256
  })), /requested_workers_must_be_integer_1_to_256:257/)
  assert.throws(() => withCleanGovernorEnv({}, () => decideNarutoConcurrency({
    requestedWorkers: 256,
    totalWorkItems: 256,
    maxThreads: 257
  })), /max_threads_must_be_integer_1_to_256:257/)
})

test('official-subagent lane permits 256 host threads without applying local worker heuristics', () => {
  const governed = withCleanGovernorEnv({}, () => decideNarutoConcurrency({
    requestedWorkers: 256,
    totalWorkItems: 256,
    backend: 'official-subagent',
    parallelismMode: 'extreme',
    maxThreads: 256,
    hardware: {
      cores: 1,
      freeMemoryBytes: 512 * 1024 ** 2,
      totalMemoryBytes: 8 * 1024 ** 3,
      fileDescriptorLimit: 32,
      processCount: 30
    }
  }))
  assert.equal(governed.safe_active_workers, 256)
  assert.equal(governed.headless_workers, 0)
  assert.equal(governed.hardware.remote_api_rate_limit_budget_source, 'default_unmeasured')
  assert.deepEqual(governed.limiting_factors, [])
})

test('governor names an external Codex host cap exactly', () => {
  const governed = withCleanGovernorEnv({}, () => decideNarutoConcurrency({
    requestedWorkers: 256,
    totalWorkItems: 256,
    backend: 'official-subagent',
    parallelismMode: 'extreme',
    maxThreads: 256,
    externalCodexHostCap: 64,
    hardware: {
      ...HEAVY_MASS_HARDWARE,
      freeMemoryBytes: 512 * 1024 ** 3,
      totalMemoryBytes: 512 * 1024 ** 3
    }
  }))
  assert.equal(governed.safe_active_workers, 64)
  assert.equal(governed.external_codex_host_cap, 64)
  assert.ok(governed.limiting_factors.includes('external_codex_host_cap:64'))
  assert.ok(governed.reasons.includes('external_codex_host_cap:64'))
})

test('official-subagent lane applies an explicitly configured API budget', () => {
  const governed = withCleanGovernorEnv({}, () => decideNarutoConcurrency({
    requestedWorkers: 256,
    totalWorkItems: 256,
    backend: 'official-subagent',
    maxThreads: 256,
    hardware: { remoteApiRateLimitBudget: 80 }
  }))
  assert.equal(governed.safe_active_workers, 80)
  assert.ok(governed.limiting_factors.includes('remote_api_rate_limit_budget:80'))
})

test('governor falls back to finite positive defaults for malformed numeric env values', () => {
  const governed = withCleanGovernorEnv({
    SKS_NARUTO_GB_PER_WORKER: 'oops',
    SKS_NARUTO_LIGHT_GB_PER_WORKER: 'Infinity',
    SKS_NARUTO_HEADLESS_PROCESS_CAP: 'NaN',
    SKS_NARUTO_GIT_WORKTREE_CAP: '-3'
  }, () => decideNarutoConcurrency({
    requestedWorkers: 32,
    totalWorkItems: 32,
    backend: 'codex-sdk',
    parallelismMode: 'extreme',
    maxThreads: 64,
    hardware: HEAVY_MASS_HARDWARE
  }))

  for (const value of [
    governed.safe_active_workers,
    governed.process_parallel,
    governed.git_worktree_parallel
  ]) {
    assert.equal(Number.isFinite(value), true)
    assert.ok(value >= 1)
    assert.ok(value <= 64)
  }
})
