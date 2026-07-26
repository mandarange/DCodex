#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const { writeFsxHotpathReport } = await importDist('core/perf/fsx-hotpath.js')
const report = await writeFsxHotpathReport(root)

assertGate(report.ok, 'fsx_hotpath_failed', report)
emitGate('fsx:hotpath', {
  checked_files: report.checked_files.length,
  report_path: '.sneakoscope/reports/fsx-hotpath.json'
})
