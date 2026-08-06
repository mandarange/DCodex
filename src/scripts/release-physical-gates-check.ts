#!/usr/bin/env node
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  inspectPhysicalReleaseGates,
  physicalReleaseEvidenceArchivePath,
  physicalReleaseGateInspectionPath
} from '../core/release/physical-release-gates.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = String(pkg.version || '')
const args = process.argv.slice(2)
const value = (flag: string): string | null => {
  const index = args.indexOf(flag)
  return index >= 0 && index + 1 < args.length ? args[index + 1] || null : null
}
const requestedArchive = value('--archive')
const archive = physicalReleaseEvidenceArchivePath(root, version)
if (requestedArchive) {
  const source = path.resolve(requestedArchive)
  const stat = fs.lstatSync(source)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('physical evidence archive must be a regular file')
  fs.mkdirSync(path.dirname(archive), { recursive: true })
  if (source !== archive) fs.copyFileSync(source, archive)
}
const report = inspectPhysicalReleaseGates({
  root,
  version,
  evidenceArchive: archive,
  evidenceRunId: value('--evidence-run-id'),
  repository: value('--repository')
})
const output = physicalReleaseGateInspectionPath(root, version)
fs.mkdirSync(path.dirname(output), { recursive: true })
const temporary = `${output}.${process.pid}.tmp`
fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
fs.renameSync(temporary, output)
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exitCode = 1
