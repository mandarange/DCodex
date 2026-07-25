#!/usr/bin/env node
// @ts-nocheck
import { classifyReleaseCacheInputChange } from '../core/release/release-cache-key.js'
import { assertGate, emitGate } from './gate-lib.js'

const pkgA = JSON.stringify({ name: 'sneakoscope', version: '3.0.0', scripts: { test: 'node a.js' }, dependencies: { left: '1.0.0' }, files: ['dist'] }, null, 2)
const pkgB = JSON.stringify({ name: 'sneakoscope', version: '3.0.2', scripts: { test: 'node a.js' }, dependencies: { left: '1.0.0' }, files: ['dist'] }, null, 2)
const pkgScript = JSON.stringify({ name: 'sneakoscope', version: '3.0.2', scripts: { test: 'node b.js' }, dependencies: { left: '1.0.0' }, files: ['dist'] }, null, 2)
const versionOnly = classifyReleaseCacheInputChange({ file: 'package.json', before: pkgA, after: pkgB })
const scriptChange = classifyReleaseCacheInputChange({ file: 'package.json', before: pkgB, after: pkgScript })
assertGate(versionOnly.neutralizable === true && versionOnly.behavior_affecting === false, 'package version-only change must be neutralizable', versionOnly)
assertGate(scriptChange.neutralizable === false && scriptChange.behavior_affecting === true && scriptChange.reason.includes('scripts'), 'package script change must invalidate', scriptChange)
emitGate('release:cache-input-classifier', { versionOnly, scriptChange })
