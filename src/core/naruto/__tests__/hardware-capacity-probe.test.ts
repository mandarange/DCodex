import test from 'node:test'
import assert from 'node:assert/strict'
import { probeHardwareCapacity } from '../hardware-capacity-probe.js'

const RATE_LIMIT_ENV_KEYS = [
  'SKS_NARUTO_REMOTE_API_PARALLEL_BUDGET',
  'SKS_REMOTE_API_PARALLEL_BUDGET'
] as const

function withRateLimitEnv<T>(overrides: Record<string, string>, run: () => T): T {
  const saved = new Map<string, string | undefined>()
  for (const key of RATE_LIMIT_ENV_KEYS) {
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

test('remote api rate-limit budget defaults to the conservative floor of 12', () => {
  const probe = withRateLimitEnv({}, () => probeHardwareCapacity({}))
  assert.equal(probe.remote_api_rate_limit_budget, 12)
  assert.equal(probe.remote_api_rate_limit_budget_source, 'default_unmeasured')
  assert.deepEqual(Object.keys(probe).sort(), [
    'cpu_core_count',
    'current_load_average',
    'disk_io_pressure',
    'file_descriptor_limit',
    'free_memory_bytes',
    'gpu_available',
    'gpu_vram_mb',
    'local_llm_max_parallel_requests',
    'node_heap_total_bytes',
    'node_heap_used_bytes',
    'process_count',
    'remote_api_rate_limit_budget',
    'remote_api_rate_limit_budget_source',
    'schema',
    'total_memory_bytes'
  ])
})

test('SKS_NARUTO_REMOTE_API_PARALLEL_BUDGET raises the rate-limit budget for mass fan-out', () => {
  const probe = withRateLimitEnv(
    { SKS_NARUTO_REMOTE_API_PARALLEL_BUDGET: '200' },
    () => probeHardwareCapacity({})
  )
  assert.equal(probe.remote_api_rate_limit_budget, 200)
  assert.equal(probe.remote_api_rate_limit_budget_source, 'environment')
})

test('legacy SKS_REMOTE_API_PARALLEL_BUDGET remains honored as a fallback', () => {
  const probe = withRateLimitEnv(
    { SKS_REMOTE_API_PARALLEL_BUDGET: '48' },
    () => probeHardwareCapacity({})
  )
  assert.equal(probe.remote_api_rate_limit_budget, 48)
})

test('the naruto-scoped override wins over the legacy variable', () => {
  const probe = withRateLimitEnv(
    {
      SKS_NARUTO_REMOTE_API_PARALLEL_BUDGET: '200',
      SKS_REMOTE_API_PARALLEL_BUDGET: '48'
    },
    () => probeHardwareCapacity({})
  )
  assert.equal(probe.remote_api_rate_limit_budget, 200)
})

test('an explicit probe input beats every environment override', () => {
  const probe = withRateLimitEnv(
    { SKS_NARUTO_REMOTE_API_PARALLEL_BUDGET: '200' },
    () => probeHardwareCapacity({ remoteApiRateLimitBudget: 24 })
  )
  assert.equal(probe.remote_api_rate_limit_budget, 24)
  assert.equal(probe.remote_api_rate_limit_budget_source, 'input')
})
