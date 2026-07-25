#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const { writeImportGraphBudgetReport } = await importDist('core/perf/import-graph-budget.js')
const report = await writeImportGraphBudgetReport(root)

assertGate(report.ok, 'import_graph_budget_failed', report)
emitGate('runtime:import-budget', {
  checked_files: report.checked_files.length,
  report_path: '.sneakoscope/reports/import-graph-budget.json'
})
