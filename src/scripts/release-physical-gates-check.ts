#!/usr/bin/env node
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inspectPhysicalReleaseGates } from '../core/release/physical-release-gates.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const report = inspectPhysicalReleaseGates({ root, version: String(pkg.version || '') })
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exitCode = 1
