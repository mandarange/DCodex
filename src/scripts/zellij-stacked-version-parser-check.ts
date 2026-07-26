#!/usr/bin/env node
// @ts-nocheck
import { parseZellijVersionText } from '../core/zellij/zellij-command.js'
import { zellijSupportsStackedPanes } from '../core/zellij/zellij-capability.js'
import { assertGate, emitGate } from './gate-lib.js'

const fixtures = [
  ['zellij 0.43.1', '0.43.1', true],
  ['zellij 0.44.0', '0.44.0', true],
  ['0.43.0', '0.43.0', true],
  ['v0.43.0', '0.43.0', true],
  ['zellij v0.43.0', '0.43.0', true],
  ['zellij 0.43.0-dev', '0.43.0', true],
  ['zellij 0.42.2', '0.42.2', false],
  ['unknown', null, false]
]

for (const [input, parsed, supported] of fixtures) {
  assertGate(parseZellijVersionText(input) === parsed, `version parse mismatch: ${input}`, { input, parsed: parseZellijVersionText(input) })
  assertGate(zellijSupportsStackedPanes(input) === supported, `stacked support mismatch: ${input}`, { input, supported })
}
emitGate('zellij:stacked-version-parser', { fixtures: fixtures.length })
