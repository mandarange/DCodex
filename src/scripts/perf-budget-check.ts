#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const config = JSON.parse(fs.readFileSync(path.join(root, 'config/perf-budgets.v1.json'), 'utf8'))
const { writePerfBudgetReport } = await importDist('core/perf/perf-budget.js')
const report = await writePerfBudgetReport(root, config.commands || [])
assertGate(report.ok, 'perf_budget_failed', report)
emitGate('perf:budgets', {
  commands: report.commands.length,
  slowest_p95_ms: Math.max(...report.commands.map((row) => row.p95_ms), 0)
})
