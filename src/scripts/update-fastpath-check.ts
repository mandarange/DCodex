#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js'

const { runSksUpdateCheck, runSksUpdateNow } = await importDist('core/update-check.js')
const startedCheck = Date.now()
const check = await runSksUpdateCheck({
  npmBin: null,
  env: { SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: '999.0.0' },
  timeoutMs: 250,
  maxOutputBytes: 1024
})
const checkElapsed = Date.now() - startedCheck

assertGate(check.schema === 'sks.update-check.v2', 'update check must return v2 schema', check)
assertGate(check.latest === '999.0.0', 'update check override must avoid registry dependency', check)
assertGate(checkElapsed <= 1200, 'update check fast path must stay under 1200ms', { elapsed_ms: checkElapsed })

const startedDryRun = Date.now()
const dryRun = await runSksUpdateNow({
  npmBin: process.execPath,
  currentVersion: '1.0.0',
  version: '1.0.1',
  dryRun: true,
  env: {},
  timeoutMs: 250,
  maxOutputBytes: 1024
})
const dryRunElapsed = Date.now() - startedDryRun

assertGate(dryRun.status === 'dry_run' && dryRun.install_code === null, 'update dry-run must not install', dryRun)
assertGate(dryRunElapsed <= 2000, 'update dry-run fast path must stay under 2000ms', { elapsed_ms: dryRunElapsed })

emitGate('update:fastpath', { check_elapsed_ms: checkElapsed, dry_run_elapsed_ms: dryRunElapsed })
