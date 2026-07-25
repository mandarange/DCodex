#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js'
const command = readText('src/core/commands/qa-loop-command.ts')
const core = readText('src/core/qa-loop.ts')
assertGate(command.includes('discoverImageArtifactsInDir') && command.includes('image-artifact-path-contract.json'), 'QA-LOOP must discover image artifacts and write image path contract')
assertGate(core.includes('model_visible_path') && core.includes('Use model_visible_path values for follow-up image edits'), 'QA prompt must expose model-visible saved image paths')
emitGate('qa-loop:image-path-exposure')
