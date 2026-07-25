#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js'

const guardMod = await importDist('core/prompt/prompt-placeholder-guard.js')

const blocked = guardMod.checkPromptPlaceholders({
  prompt: 'Use @filename and INSERT_PATH_HERE to patch the bug',
  writeCapable: true,
  targetPaths: ['src/core/example.ts']
})
const emptyTarget = guardMod.checkPromptPlaceholders({
  prompt: 'Patch the bug',
  writeCapable: true,
  targetPaths: []
})
const pass = guardMod.checkPromptPlaceholders({
  prompt: 'Patch src/core/example.ts',
  writeCapable: true,
  targetPaths: ['src/core/example.ts']
})
const readonlyWarn = guardMod.checkPromptPlaceholders({
  prompt: 'Inspect @filename',
  writeCapable: false
})

assertGate(blocked.ok === false && blocked.blockers.some((item) => String(item).startsWith('unresolved_prompt_placeholder')), 'write-capable Naruto prompt with @filename must block', blocked)
assertGate(emptyTarget.ok === false && emptyTarget.blockers.includes('write_capable_prompt_target_paths_empty'), 'write-capable Naruto route with empty target paths must block', emptyTarget)
assertGate(pass.ok === true, 'resolved write-capable prompt must pass placeholder guard', pass)
assertGate(readonlyWarn.ok === true && readonlyWarn.warnings.length > 0, 'read-only route may warn on placeholders instead of blocking', readonlyWarn)

emitGate('prompt:placeholder-guard', {
  blocked_placeholders: blocked.placeholders,
  empty_target_blockers: emptyTarget.blockers,
  readonly_warnings: readonlyWarn.warnings
})

