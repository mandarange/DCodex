#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NPM_STAGE_REVIEW_RECEIPT_SCHEMA,
  NpmStageReviewError,
  verifyNpmStageTarball
} from '../core/release/npm-stage-tarball-verifier.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

try {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    printHelp()
    process.exit(0)
  }
  const result = verifyNpmStageTarball({
    root,
    stageId: required(parsed, 'stage-id'),
    expectedDispatchNonce: required(parsed, 'dispatch-nonce'),
    expectedPhysicalEvidenceRunId: required(parsed, 'physical-evidence-run-id'),
    expectedWorkflowRunId: required(parsed, 'workflow-run-id'),
    localReceiptPath: required(parsed, 'local-receipt'),
    localTarballPath: required(parsed, 'local-tarball'),
    stageReceiptPath: required(parsed, 'stage-receipt'),
    ...(parsed.values['output-dir'] ? { outputDir: parsed.values['output-dir'] } : {})
  })
  console.log(JSON.stringify({
    ...result.receipt,
    receipt_path: normalizePath(path.relative(root, result.receiptPath)),
    evidence_dir: normalizePath(path.relative(root, result.outputDir))
  }, null, 2))
  process.exit(result.receipt.ok ? 0 : 1)
} catch (error) {
  const blocker = error instanceof NpmStageReviewError ? error.blocker : 'npm_stage_review_unexpected_failure'
  const detail = error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({
    schema: 'sks.npm-stage-review-error.v1',
    ok: false,
    expected_receipt_schema: NPM_STAGE_REVIEW_RECEIPT_SCHEMA,
    blockers: [blocker],
    detail
  }))
  process.exit(2)
}

function parseArgs(args: string[]): { help: boolean; values: Record<string, string> } {
  const values: Record<string, string> = {}
  let help = false
  const allowed = new Set([
    'stage-id',
    'dispatch-nonce',
    'physical-evidence-run-id',
    'workflow-run-id',
    'local-receipt',
    'local-tarball',
    'stage-receipt',
    'output-dir'
  ])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (!arg?.startsWith('--')) throw new NpmStageReviewError('unexpected_positional_argument')
    const name = arg.slice(2)
    if (!allowed.has(name)) throw new NpmStageReviewError(`unknown_option:${name}`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new NpmStageReviewError(`option_value_missing:${name}`)
    if (Object.hasOwn(values, name)) throw new NpmStageReviewError(`option_repeated:${name}`)
    values[name] = value
    index += 1
  }
  return { help, values }
}

function required(parsed: { values: Record<string, string> }, name: string): string {
  const value = String(parsed.values[name] || '').trim()
  if (!value) throw new NpmStageReviewError(`required_option_missing:${name}`)
  return value
}

function printHelp(): void {
  console.log(`Usage:
  node ./dist/scripts/npm-stage-tarball-verifier.js \\
    --stage-id <uuid> \\
    --dispatch-nonce <32-lowercase-hex> \\
    --physical-evidence-run-id <github-run-id> \\
    --workflow-run-id <github-run-id> \\
    --local-receipt <pack-receipt.json> \\
    --local-tarball <immutable.tgz> \\
    --stage-receipt <stage-receipt.json> \\
    [--output-dir <new-directory>]

Runs only authenticated read-only stage inspection and download operations with exact
npm 11.15.0, then writes a byte/hash comparison receipt. It refuses automated CI,
GitHub Actions, or OIDC credential environments and never performs publication,
rejection, or 2FA steps.`)
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/')
}
