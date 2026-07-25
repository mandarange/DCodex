#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const { runSuperSearchLocalHttpSmoke } = await importDist('core/super-search/local-http-smoke.js')
const report = await runSuperSearchLocalHttpSmoke({ root })

assertGate(report.ok === true, 'Super-Search local HTTP smoke must pass', report)
assertGate(report.verified_content === true, 'local smoke must produce verified_content', report)
assertGate(Boolean(report.content_artifact), 'local smoke must write a content artifact', report)
assertGate(Boolean(report.content_sha256), 'local smoke must record content_sha256', report)
assertGate(report.content_length > 0, 'local smoke content_length must be positive', report)
assertGate(report.source_backed_claim === true, 'local smoke must produce a source-backed claim', report)
assertGate(report.server_closed === true, 'local smoke server must close', report)

emitGate('super-search:local-http-smoke', {
  content_length: report.content_length,
  content_sha256: report.content_sha256,
  report: '.sneakoscope/reports/super-search-local-http-smoke.json'
})
