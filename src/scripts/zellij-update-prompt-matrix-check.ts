#!/usr/bin/env node
// @ts-nocheck
import { resolveZellijUpdatePromptMode } from '../core/zellij/zellij-update.js'
import { assertGate, emitGate } from './gate-lib.js'

const matrix = [
  ['interactive tty + update available', { env: {}, headless: false }, 'interactive-prompt'],
  ['CI=1', { env: { CI: '1' }, headless: false }, 'nonblocking-notice'],
  ['SKS_NO_QUESTION=1', { env: { SKS_NO_QUESTION: '1' }, headless: false }, 'nonblocking-notice'],
  ['--skip-zellij-update', { env: {}, skipFlag: true, headless: false }, 'skip'],
  ['SKS_SKIP_ZELLIJ_UPDATE=1', { env: { SKS_SKIP_ZELLIJ_UPDATE: '1' }, headless: false }, 'skip'],
  ['no zellij installed/headless fallback', { env: {}, headless: true }, 'nonblocking-notice']
]

for (const [name, input, expected] of matrix) {
  const actual = resolveZellijUpdatePromptMode(input)
  assertGate(actual === expected, `zellij prompt matrix mismatch: ${name}`, { name, input, expected, actual })
}
emitGate('zellij:update-prompt-matrix', { matrix: matrix.length })
