#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js'
const qa = await importDist('core/qa-loop.js')
const prompt = qa.buildQaLoopPrompt({ id: 'M', mission: { prompt: 'fixture' }, contract: {}, cycle: 1, previous: '', reportFile: '2026-06-09-v2.0.19-qa-report.md', imagePathContract: { images: [{ id: 'img', model_visible_path: '/tmp/a.png', mime_type: 'image/png', width: 1, height: 1, followup_edit_hint: 'use /tmp/a.png' }], blockers: [] } })
assertGate(prompt.includes('/tmp/a.png') && prompt.includes('mime_type') && prompt.includes('width') && prompt.includes('Use model_visible_path values'), 'QA prompt must inject image id, model-visible path, dimensions/mime, and follow-up edit hint')
emitGate('qa-loop:image-path-prompt-injection')
