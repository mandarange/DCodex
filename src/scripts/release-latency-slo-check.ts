#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist, readJson, root } from './gate-lib.js'

const config = readJson('config/perf-budgets.v1.json')
const budgets = Array.isArray(config.release_latency_slos) ? config.release_latency_slos : []
const { RELEASE_LATENCY_LIMITS, runReleaseLatencySlo } = await importDist('core/perf/release-latency-slo.js')
const expectedIds = Object.keys(RELEASE_LATENCY_LIMITS).sort()
const configuredIds = budgets.map((row) => row?.id).sort()
assertGate(
  config.schema === 'sks.perf-budgets.v1'
    && JSON.stringify(configuredIds) === JSON.stringify(expectedIds),
  'release_latency_slo_config_invalid',
  {
  schema: config.schema,
  count: budgets.length,
  expected_count: expectedIds.length
  }
)

const report = await runReleaseLatencySlo(root, budgets)
assertGate(report.ok, 'release_latency_slo_failed', report)
emitGate('release:latency-slo', {
  report: '.sneakoscope/reports/release-latency-slo.json',
  platform: report.platform,
  complete: report.complete,
  measured: report.measurements
    .filter((row) => row.status === 'measured')
    .map((row) => ({ id: row.id, p95_ms: row.p95_ms, budget_p95_ms: row.budget_p95_ms })),
  not_measured: report.measurements
    .filter((row) => row.status === 'not_measured_platform')
    .map((row) => row.id)
})
