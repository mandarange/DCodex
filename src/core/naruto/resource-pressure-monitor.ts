import type { HardwareCapacityProbe } from './hardware-capacity-probe.js'

export type NarutoBackpressureState = 'normal' | 'throttled' | 'saturated'

export interface NarutoResourcePressure {
  schema: 'sks.naruto-resource-pressure.v1'
  state: NarutoBackpressureState
  memory_pressure: number
  cpu_pressure: number
  fd_pressure: number
  disk_io_pressure: number
  dominant_metric: string
  dominant_pressure: number
  reasons: string[]
}

const PRESSURE_HISTORY_LIMIT = 5
const PRESSURE_HISTORY: Array<Record<string, number>> = []

export function monitorNarutoResourcePressure(probe: HardwareCapacityProbe, input: {
  activeWorkers?: number
} = {}): NarutoResourcePressure {
  const activeWorkers = Math.max(1, Math.floor(Number(input.activeWorkers || 1)))
  const memoryPressure = 1 - (probe.free_memory_bytes / Math.max(1, probe.total_memory_bytes))
  const cpuPressure = Math.min(1, (probe.current_load_average[0] || 0) / Math.max(1, probe.cpu_core_count))
  const fdPressure = Math.min(1, (activeWorkers * 6 + probe.process_count) / Math.max(1, probe.file_descriptor_limit))
  const diskIoPressure = Number(probe.disk_io_pressure || 0)
  const current = {
    memory: memoryPressure,
    cpu: cpuPressure,
    fd: fdPressure,
    disk: diskIoPressure
  }
  const average = movingAveragePressure(current)
  const pressureKeys = Object.keys(current) as Array<keyof typeof current>
  const sample = Object.fromEntries(pressureKeys.map((key) => [key, Math.max(current[key] || 0, average[key] || 0)])) as typeof current
  const entries = Object.entries(sample).sort((a, b) => b[1] - a[1])
  const [dominantMetric = 'unknown', dominantPressure = 0] = entries[0] || []
  const reasons = entries
    .filter(([, value]) => value >= 0.85)
    .map(([metric, value]) => `${metric}:${round(value).toFixed(2)}`)
  const state: NarutoBackpressureState = dominantPressure >= 0.95 ? 'saturated' : dominantPressure >= 0.85 ? 'throttled' : 'normal'
  return {
    schema: 'sks.naruto-resource-pressure.v1',
    state,
    memory_pressure: round(sample.memory),
    cpu_pressure: round(sample.cpu),
    fd_pressure: round(sample.fd),
    disk_io_pressure: round(sample.disk),
    dominant_metric: dominantMetric,
    dominant_pressure: round(dominantPressure),
    reasons
  }
}

function movingAveragePressure(sample: Record<string, number>) {
  PRESSURE_HISTORY.push(sample)
  while (PRESSURE_HISTORY.length > PRESSURE_HISTORY_LIMIT) PRESSURE_HISTORY.shift()
  const averaged: Record<string, number> = {}
  for (const key of Object.keys(sample)) {
    averaged[key] = PRESSURE_HISTORY.reduce((sum, row) => sum + Number(row[key] || 0), 0) / PRESSURE_HISTORY.length
  }
  return averaged as { memory: number; cpu: number; fd: number; disk: number }
}

function round(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000
}
