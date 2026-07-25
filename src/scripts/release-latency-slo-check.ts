#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist, readJson, root } from './gate-lib.js'

const config = readJson('config/perf-budgets.v1.json')
const budgets = Array.isArray(config.release_latency_slos) ? config.release_latency_slos : []
assertGate(config.schema === 'sks.perf-budgets.v1' && budgets.length === 6, 'release_latency_slo_config_invalid', {
  schema: config.schema,
  count: budgets.length
})

const { runReleaseLatencySlo } = await importDist('core/perf/release-latency-slo.js')
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
