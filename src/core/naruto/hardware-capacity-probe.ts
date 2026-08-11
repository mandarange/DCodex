import os from 'node:os'

export interface HardwareCapacityProbeInput {
  cores?: number
  loadAverage?: number[]
  freeMemoryBytes?: number
  totalMemoryBytes?: number
  nodeHeapUsedBytes?: number
  nodeHeapTotalBytes?: number
  processCount?: number
  fileDescriptorLimit?: number
  remoteApiRateLimitBudget?: number
  gpuAvailable?: boolean
  gpuVramMb?: number
  diskIoPressure?: number
}

export interface HardwareCapacityProbe {
  schema: 'sks.naruto-hardware-capacity-probe.v1'
  cpu_core_count: number
  current_load_average: number[]
  free_memory_bytes: number
  total_memory_bytes: number
  node_heap_used_bytes: number
  node_heap_total_bytes: number
  process_count: number
  file_descriptor_limit: number
  remote_api_rate_limit_budget: number
  remote_api_rate_limit_budget_source: 'input' | 'environment' | 'default_unmeasured'
  gpu_available: boolean
  gpu_vram_mb: number
  disk_io_pressure: number
}

export function probeHardwareCapacity(input: HardwareCapacityProbeInput = {}): HardwareCapacityProbe {
  const memory = process.memoryUsage()
  const configuredRemoteBudget = Number(process.env.SKS_NARUTO_REMOTE_API_PARALLEL_BUDGET)
    || Number(process.env.SKS_REMOTE_API_PARALLEL_BUDGET)
  const remoteBudgetSource = input.remoteApiRateLimitBudget !== undefined
    ? 'input'
    : configuredRemoteBudget
      ? 'environment'
      : 'default_unmeasured'
  return {
    schema: 'sks.naruto-hardware-capacity-probe.v1',
    cpu_core_count: normalizePositiveInt(input.cores, os.cpus()?.length || 1),
    current_load_average: input.loadAverage || os.loadavg(),
    free_memory_bytes: normalizePositiveInt(input.freeMemoryBytes, os.freemem()),
    total_memory_bytes: normalizePositiveInt(input.totalMemoryBytes, os.totalmem()),
    node_heap_used_bytes: normalizePositiveInt(input.nodeHeapUsedBytes, memory.heapUsed),
    node_heap_total_bytes: normalizePositiveInt(input.nodeHeapTotalBytes, memory.heapTotal),
    process_count: normalizePositiveInt(input.processCount, 1),
    file_descriptor_limit: normalizePositiveInt(input.fileDescriptorLimit, Number(process.env.SKS_NARUTO_FD_LIMIT) || 256),
    // Default 12 is a conservative unmeasured budget, not a discovered provider
    // limit; operators with real rate-limit headroom raise it via
    // SKS_NARUTO_REMOTE_API_PARALLEL_BUDGET
    // (legacy SKS_REMOTE_API_PARALLEL_BUDGET still honored).
    remote_api_rate_limit_budget: normalizePositiveInt(
      input.remoteApiRateLimitBudget,
      configuredRemoteBudget || 12
    ),
    remote_api_rate_limit_budget_source: remoteBudgetSource,
    gpu_available: input.gpuAvailable === true,
    gpu_vram_mb: normalizeNonNegativeInt(input.gpuVramMb, 0),
    disk_io_pressure: Math.max(0, Math.min(1, Number(input.diskIoPressure ?? 0)))
  }
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return Math.max(1, Math.floor(fallback))
  return Math.floor(parsed)
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return Math.max(0, Math.floor(fallback))
  return Math.floor(parsed)
}
