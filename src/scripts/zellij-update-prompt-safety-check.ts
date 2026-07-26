#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js'

const src = readText('src/core/zellij/zellij-update.ts')
assertGate(src.includes('resolveZellijUpdatePromptMode'), 'zellij update launch path must use prompt mode resolver')
assertGate(src.includes("mode === 'skip'") && src.indexOf("mode === 'skip'") < src.indexOf('const notice = await checkZellijUpdateNotice'), 'skip mode must avoid update notice network/cache call')
assertGate(src.includes("mode === 'nonblocking-notice'") && src.includes('Run: ${notice.upgrade_command}'), 'nonblocking mode must print notice and continue')
assertGate(src.includes('process.stdin.isTTY') && src.includes('process.stdout.isTTY'), 'interactive prompt must be tty gated')
emitGate('zellij:update-prompt-safety')
