#!/usr/bin/env node
// @ts-nocheck
import { resolveZellijUpdatePromptMode } from '../core/zellij/zellij-update.js'
import { assertGate, emitGate } from './gate-lib.js'

const fixtures = [
  [{ env: {}, headless: false }, 'interactive-prompt'],
  [{ env: { CI: '1' }, headless: false }, 'nonblocking-notice'],
  [{ env: { CI: 'true' }, headless: false }, 'nonblocking-notice'],
  [{ env: { SKS_NO_QUESTION: '1' }, headless: false }, 'nonblocking-notice'],
  [{ env: {}, noQuestion: true, headless: false }, 'nonblocking-notice'],
  [{ env: {}, headless: true }, 'nonblocking-notice'],
  [{ env: { SKS_SKIP_ZELLIJ_UPDATE: '1' }, headless: false }, 'skip'],
  [{ env: {}, skipFlag: true, headless: false }, 'skip']
]

for (const [input, expected] of fixtures) {
  const actual = resolveZellijUpdatePromptMode(input)
  assertGate(actual === expected, 'zellij update prompt mode mismatch', { input, expected, actual })
}
emitGate('zellij:update-prompt-mode', { fixtures: fixtures.length })
