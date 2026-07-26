#!/usr/bin/env node
// @ts-nocheck
import { resolveZellijStackedPaneCapability, ZELLIJ_MIN_VERSION, ZELLIJ_STACKED_PANE_MIN_VERSION } from '../core/zellij/zellij-capability.js'
import { assertGate, emitGate } from './gate-lib.js'

const fixtures = [
  ['zellij 0.43.0', true],
  ['zellij 0.43.1', true],
  ['zellij 0.44.0', true],
  ['v0.43.0', true],
  ['zellij 0.42.2', false],
  ['zellij 0.41.0', false],
  ['unknown', false]
]

assertGate(ZELLIJ_MIN_VERSION === ZELLIJ_STACKED_PANE_MIN_VERSION, 'doctor minimum zellij version must match stacked-pane support minimum', {
  ZELLIJ_MIN_VERSION,
  ZELLIJ_STACKED_PANE_MIN_VERSION
})

for (const [versionText, expected] of fixtures) {
  const report = resolveZellijStackedPaneCapability({ ok: true, versionText })
  assertGate(report.supports_stacked_panes === expected, `stacked matrix mismatch: ${versionText}`, report)
  if (expected) {
    assertGate(report.fallback_mode === 'native-stacked', 'supported zellij must use native stacked fallback mode', report)
  } else {
    assertGate(report.fallback_mode !== 'native-stacked', 'unsupported zellij must not use native stacked fallback mode', report)
    if (report.parsed_version) assertGate(report.requires_update === true, 'unsupported parsed zellij must require update', report)
  }
}
emitGate('zellij:stacked-version-matrix', { fixtures: fixtures.length })
