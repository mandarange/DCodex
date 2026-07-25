#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectMainPushGuard } from '../core/release/main-push-guard.js'
import { releaseProofDir, writeReleaseJson } from '../core/release/release-pack-receipt.js'
import { RELEASE_ORIGIN_IDENTITY } from '../core/release/release-origin.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const expectedVersion = required('--expected-version')
const expectedOriginMain = required('--expected-origin-main')
const report = inspectMainPushGuard({
  root,
  expectedVersion,
  expectedOriginMain,
  expectedOriginIdentity: RELEASE_ORIGIN_IDENTITY,
  requireReleaseStamp: process.argv.includes('--require-release-stamp'),
  requirePackProof: process.argv.includes('--require-pack-proof'),
  requireMacosProof: process.argv.includes('--require-macos-proof'),
  requireCleanTree: process.argv.includes('--require-clean-tree')
})
const output = path.join(releaseProofDir(root, expectedVersion), 'main-push-guard.json')
writeReleaseJson(output, report)
console.log(JSON.stringify({ ...report, report_path: path.relative(root, output).split(path.sep).join('/') }, null, 2))
if (!report.ok) process.exitCode = 1

function required(name: string): string {
  const result = value(name)
  if (!result) {
    console.error(`Release main push guard failed: ${name} is required`)
    process.exit(2)
  }
  return result
}

function value(name: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : ''
}
