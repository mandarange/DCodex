#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, root } from './gate-lib.js'
import { buildOpsDiagnosticsBundle, writeOpsDiagnosticsBundle } from '../core/ops/diagnostics-bundle.js'

const report = await buildOpsDiagnosticsBundle(root)
const reportPath = await writeOpsDiagnosticsBundle(root)

assertGate(report.ok === true, 'ops diagnostics bundle must pass without blockers', report)
assertGate(report.secret_scan?.raw_values_recorded === false, 'ops diagnostics bundle must not record raw secret values', report.secret_scan)
assertGate(Array.isArray(report.redacted_env_keys), 'ops diagnostics bundle must list env keys only', report.redacted_env_keys)
assertGate(typeof report.node_version === 'string' && report.node_version.startsWith('v'), 'ops diagnostics bundle must include node version', report.node_version)
assertGate(typeof report.platform === 'string' && report.platform.length > 0, 'ops diagnostics bundle must include platform', report.platform)

emitGate('ops:diagnostics-bundle', { report: reportPath.replace(`${root}/`, '') })
