import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  NPM_STAGE_REGISTRY,
  NPM_STAGE_REVIEW_RECEIPT_SCHEMA,
  NpmStageReviewError,
  REQUIRED_NPM_STAGE_CLI_VERSION,
  verifyNpmStageTarball
} from '../npm-stage-tarball-verifier.js'
import { inspectReleaseTarball, type ReleasePackReceipt } from '../release-pack-receipt.js'

const STAGE_ID = '123e4567-e89b-42d3-a456-426614174000'

test('maintainer-local verifier compares actual stage download bytes and all required digests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-stage-review-pass-'))
  try {
    const fixture = createFixture(root)
    const outputDir = path.join(root, 'evidence', STAGE_ID)
    const result = verifyNpmStageTarball({
      root,
      stageId: STAGE_ID,
      localReceiptPath: fixture.localReceiptFile,
      localTarballPath: fixture.localTarball,
      stageReceiptPath: fixture.stageReceiptFile,
      outputDir,
      npmCommand: fixture.fakeNpm,
      env: fixtureEnv(fixture.localTarball, fixture.downloadInfo, fixture.viewInfo)
    })

    assert.equal(result.receipt.ok, true, result.receipt.blockers.join(','))
    assert.equal(result.receipt.schema, NPM_STAGE_REVIEW_RECEIPT_SCHEMA)
    assert.equal(result.receipt.npm_cli_version, REQUIRED_NPM_STAGE_CLI_VERSION)
    assert.equal(result.receipt.registry, NPM_STAGE_REGISTRY)
    assert.equal(result.receipt.checks.exact_bytes_match, true)
    assert.equal(result.receipt.checks.packed_bytes_match, true)
    assert.equal(result.receipt.checks.unpacked_bytes_match, true)
    assert.equal(result.receipt.checks.file_count_match, true)
    assert.equal(result.receipt.checks.file_list_match, true)
    assert.equal(result.receipt.checks.sha256_match, true)
    assert.equal(result.receipt.checks.sha512_match, true)
    assert.equal(result.receipt.checks.integrity_match, true)
    assert.equal(result.receipt.checks.stage_receipt_sha256_match, true)
    assert.equal(result.receipt.checks.stage_receipt_sha512_match, true)
    assert.equal(result.receipt.checks.stage_receipt_integrity_match, true)
    assert.deepEqual(result.receipt.read_only_commands.view_argv.slice(0, 4), [fixture.fakeNpm, 'stage', 'view', STAGE_ID])
    assert.deepEqual(result.receipt.read_only_commands.download_argv.slice(0, 4), [fixture.fakeNpm, 'stage', 'download', STAGE_ID])
    assert.equal(result.receipt.oidc_review_supported, false)
    assert.equal(result.receipt.maintainer_session_required, true)
    assert.equal(result.receipt.human_2fa_pending, true)
    assert.equal(fs.existsSync(result.receiptPath), true)
    assert.equal(fs.existsSync(path.join(outputDir, 'stage-view.json')), true)
    assert.equal(fs.existsSync(path.join(outputDir, 'stage-download.json')), true)
    assert.equal(fs.existsSync(path.join(outputDir, result.receipt.stage_download.tarball_path)), true)
    assert.doesNotMatch(fs.readFileSync(result.receiptPath, 'utf8'), /npm\s+stage\s+approve/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('maintainer-local verifier persists a failing receipt when registry bytes differ', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-stage-review-mismatch-'))
  try {
    const fixture = createFixture(root)
    const localReceipt = JSON.parse(fs.readFileSync(fixture.localReceiptFile, 'utf8')) as ReleasePackReceipt
    const localBytes = fs.readFileSync(fixture.localTarball)
    const differentTarball = createTarball(root, 'different', 'unexpected registry bytes')
    const differentReceipt = inspectReleaseTarball({ tarball: differentTarball, kind: 'staged', root })
    assert.equal(differentReceipt.ok, true, differentReceipt.blockers.join(','))
    const differentBytes = fs.readFileSync(differentTarball)
    const differentInfo = downloadInfo(differentReceipt, differentBytes)
    const differentView = viewInfo(differentReceipt, differentBytes)
    const outputDir = path.join(root, 'evidence', STAGE_ID)
    const result = verifyNpmStageTarball({
      root,
      stageId: STAGE_ID,
      localReceiptPath: fixture.localReceiptFile,
      localTarballPath: fixture.localTarball,
      stageReceiptPath: fixture.stageReceiptFile,
      outputDir,
      npmCommand: fixture.fakeNpm,
      env: fixtureEnv(differentTarball, differentInfo, differentView)
    })

    assert.equal(result.receipt.ok, false)
    const expectedContentChecks: Record<string, boolean> = {
      packed_bytes_match: differentBytes.length === localBytes.length,
      unpacked_bytes_match: differentReceipt.unpacked_bytes === localReceipt.unpacked_bytes,
      file_count_match: differentReceipt.file_count === localReceipt.file_count,
      file_list_match: differentReceipt.file_list_sha256 === localReceipt.file_list_sha256,
      exact_bytes_match: differentBytes.equals(localBytes),
      sha256_match: differentReceipt.sha256 === localReceipt.sha256,
      sha512_match: digest(differentBytes, 'sha512', 'hex') === digest(localBytes, 'sha512', 'hex'),
      integrity_match: differentReceipt.sha512_integrity === localReceipt.sha512_integrity,
      stage_receipt_sha256_match: differentReceipt.sha256 === localReceipt.sha256,
      stage_receipt_sha512_match: digest(differentBytes, 'sha512', 'hex') === digest(localBytes, 'sha512', 'hex'),
      stage_receipt_integrity_match: differentReceipt.sha512_integrity === localReceipt.sha512_integrity,
      stage_receipt_bytes_match: differentBytes.length === localBytes.length,
      stage_receipt_unpacked_bytes_match: differentReceipt.unpacked_bytes === localReceipt.unpacked_bytes,
      stage_receipt_file_count_match: differentReceipt.file_count === localReceipt.file_count
    }
    for (const [check, expected] of Object.entries(expectedContentChecks)) {
      assert.equal(result.receipt.checks[check], expected, check)
      assert.equal(result.receipt.blockers.includes(check), !expected, `${check}:blocker`)
    }
    for (const blocker of [
      'exact_bytes_match',
      'sha256_match',
      'sha512_match',
      'integrity_match',
      'stage_receipt_sha256_match',
      'stage_receipt_sha512_match',
      'stage_receipt_integrity_match'
    ]) assert.equal(result.receipt.blockers.includes(blocker), true, blocker)
    assert.equal(fs.existsSync(result.receiptPath), true)
    const persisted = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8')) as {
      ok: boolean
      checks: Record<string, boolean>
      blockers: string[]
    }
    assert.equal(persisted.ok, false)
    assert.deepEqual(persisted.checks, result.receipt.checks)
    assert.deepEqual(persisted.blockers, result.receipt.blockers)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('maintainer-local verifier rejects OIDC/GitHub Actions and generic CI before running npm', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-stage-review-oidc-'))
  try {
    const fixture = createFixture(root)
    assert.throws(() => verifyNpmStageTarball({
      root,
      stageId: STAGE_ID,
      localReceiptPath: fixture.localReceiptFile,
      localTarballPath: fixture.localTarball,
      stageReceiptPath: fixture.stageReceiptFile,
      outputDir: path.join(root, 'evidence', STAGE_ID),
      npmCommand: fixture.fakeNpm,
      env: { ...fixtureEnv(fixture.localTarball, fixture.downloadInfo, fixture.viewInfo), GITHUB_ACTIONS: 'true' }
    }), (error: unknown) => error instanceof NpmStageReviewError && error.blocker === 'oidc_environment_not_allowed')
    assert.throws(() => verifyNpmStageTarball({
      root,
      stageId: STAGE_ID,
      localReceiptPath: fixture.localReceiptFile,
      localTarballPath: fixture.localTarball,
      stageReceiptPath: fixture.stageReceiptFile,
      outputDir: path.join(root, 'evidence-ci', STAGE_ID),
      npmCommand: fixture.fakeNpm,
      env: { ...fixtureEnv(fixture.localTarball, fixture.downloadInfo, fixture.viewInfo), CI: 'true' }
    }), (error: unknown) => error instanceof NpmStageReviewError && error.blocker === 'ci_environment_not_allowed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('maintainer-local verifier requires exact npm 11.15.0 and leaves no partial evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-stage-review-version-'))
  try {
    const fixture = createFixture(root)
    const outputDir = path.join(root, 'evidence', STAGE_ID)
    assert.throws(() => verifyNpmStageTarball({
      root,
      stageId: STAGE_ID,
      localReceiptPath: fixture.localReceiptFile,
      localTarballPath: fixture.localTarball,
      stageReceiptPath: fixture.stageReceiptFile,
      outputDir,
      npmCommand: fixture.fakeNpm,
      env: {
        ...fixtureEnv(fixture.localTarball, fixture.downloadInfo, fixture.viewInfo),
        FAKE_NPM_VERSION: '11.14.0'
      }
    }), (error: unknown) => error instanceof NpmStageReviewError && error.blocker === 'npm_stage_cli_version_mismatch')
    assert.equal(fs.existsSync(outputDir), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('maintainer-local verifier rejects stage receipts that do not bind local receipt and SHA-512 bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-stage-review-stage-receipt-'))
  try {
    const fixture = createFixture(root)
    const original = JSON.parse(fs.readFileSync(fixture.stageReceiptFile, 'utf8')) as Record<string, unknown>
    for (const [field, value, expectedDetail] of [
      ['local_pack_receipt_sha256', '0'.repeat(64), 'local_pack_receipt_sha256_mismatch'],
      ['tarball_sha512', '0'.repeat(128), 'sha512_mismatch']
    ] as const) {
      fs.writeFileSync(fixture.stageReceiptFile, `${JSON.stringify({ ...original, [field]: value }, null, 2)}\n`)
      assert.throws(() => verifyNpmStageTarball({
        root,
        stageId: STAGE_ID,
        localReceiptPath: fixture.localReceiptFile,
        localTarballPath: fixture.localTarball,
        stageReceiptPath: fixture.stageReceiptFile,
        outputDir: path.join(root, 'evidence', `${field}-${STAGE_ID}`),
        npmCommand: fixture.fakeNpm,
        env: fixtureEnv(fixture.localTarball, fixture.downloadInfo, fixture.viewInfo)
      }), (error: unknown) => error instanceof NpmStageReviewError
        && error.blocker === 'workflow_stage_receipt_invalid'
        && error.message.includes(expectedDetail))
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('compiled maintainer CLI resolves the pinned npm package through PATH npx', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-stage-review-cli-'))
  try {
    const fixture = createFixture(root)
    const fakeBin = path.join(root, 'fake-bin')
    fs.mkdirSync(fakeBin, { recursive: true })
    const fakeNpxOnPath = path.join(fakeBin, 'npx')
    fs.writeFileSync(fakeNpxOnPath, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] !== '--yes' || args[1] !== 'npm@${REQUIRED_NPM_STAGE_CLI_VERSION}') process.exit(64)
const child = spawnSync(String(process.env.FAKE_NPM_EXEC || ''), args.slice(2), {
  env: process.env,
  stdio: 'inherit'
})
process.exit(child.status == null ? 1 : child.status)
`)
    fs.chmodSync(fakeNpxOnPath, 0o755)
    const outputDir = path.join(root, 'evidence', STAGE_ID)
    const cli = fileURLToPath(new URL('../../../scripts/npm-stage-tarball-verifier.js', import.meta.url))
    const result = spawnSync(process.execPath, [
      cli,
      '--stage-id', STAGE_ID,
      '--local-receipt', fixture.localReceiptFile,
      '--local-tarball', fixture.localTarball,
      '--stage-receipt', fixture.stageReceiptFile,
      '--output-dir', outputDir
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...fixtureEnv(fixture.localTarball, fixture.downloadInfo, fixture.viewInfo),
        FAKE_NPM_EXEC: fixture.fakeNpm,
        PATH: `${fakeBin}${path.delimiter}${String(process.env.PATH || '')}`
      }
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const receipt = JSON.parse(result.stdout) as Record<string, unknown>
    assert.equal(receipt.schema, NPM_STAGE_REVIEW_RECEIPT_SCHEMA)
    assert.equal(receipt.ok, true)
    assert.deepEqual(
      (receipt.read_only_commands as { view_argv: string[] }).view_argv.slice(0, 6),
      ['npx', '--yes', `npm@${REQUIRED_NPM_STAGE_CLI_VERSION}`, 'stage', 'view', STAGE_ID]
    )
    assert.equal(fs.existsSync(path.join(outputDir, 'stage-review-receipt.json')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function createFixture(root: string) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sneakoscope', version: '8.0.0' }))
  const localTarball = createTarball(root, 'local', 'reviewed bytes')
  const localReceipt = inspectReleaseTarball({
    tarball: localTarball,
    kind: 'local',
    sourceCommit: 'a'.repeat(40),
    root,
    npmPackProof: {
      proof_id: 'b'.repeat(64),
      info_sha256: 'c'.repeat(64),
      file_list_sha256: 'd'.repeat(64)
    }
  })
  assert.equal(localReceipt.ok, true, localReceipt.blockers.join(','))
  const localReceiptFile = path.join(root, 'pack-receipt.json')
  const localReceiptBytes = Buffer.from(`${JSON.stringify(localReceipt, null, 2)}\n`)
  fs.writeFileSync(localReceiptFile, localReceiptBytes)
  const localBytes = fs.readFileSync(localTarball)
  const stageReceipt = {
    schema: 'sks.npm-stage-receipt.v1',
    ok: true,
    stage_id: STAGE_ID,
    package_name: localReceipt.package_name,
    package_version: localReceipt.package_version,
    source_commit: localReceipt.source_commit,
    tarball_sha256: digest(localBytes, 'sha256', 'hex'),
    tarball_sha512: digest(localBytes, 'sha512', 'hex'),
    tarball_integrity: `sha512-${digest(localBytes, 'sha512', 'base64')}`,
    packed_bytes: localReceipt.bytes,
    unpacked_bytes: localReceipt.unpacked_bytes,
    file_count: localReceipt.file_count,
    workflow_run_id: '100',
    workflow_run_attempt: '1',
    local_pack_receipt_sha256: digest(localReceiptBytes, 'sha256', 'hex'),
    stage_command_digest: 'e'.repeat(64),
    stage_output_digest: 'f'.repeat(64),
    review_verifier_schema: NPM_STAGE_REVIEW_RECEIPT_SCHEMA,
    oidc_review_supported: false,
    maintainer_session_required: true,
    review_required: true,
    approved_with_2fa: false,
    human_2fa_pending: true,
    generated_at: new Date().toISOString()
  }
  const stageReceiptFile = path.join(root, 'stage-receipt.json')
  fs.writeFileSync(stageReceiptFile, `${JSON.stringify(stageReceipt, null, 2)}\n`)
  return {
    localTarball,
    localReceiptFile,
    stageReceiptFile,
    fakeNpm: createFakeNpm(root),
    downloadInfo: downloadInfo(localReceipt, localBytes),
    viewInfo: viewInfo(localReceipt, localBytes)
  }
}

function createTarball(root: string, name: string, marker: string): string {
  const packageDir = path.join(root, name, 'package')
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'sneakoscope', version: '8.0.0' }))
  fs.writeFileSync(path.join(packageDir, 'dist', 'marker.txt'), `${marker}\n`)
  const tarball = path.join(root, `${name}.tgz`)
  const result = spawnSync('tar', ['-czf', tarball, '-C', path.dirname(packageDir), 'package'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return tarball
}

function downloadInfo(receipt: ReleasePackReceipt, bytes: Buffer) {
  return {
    id: `${receipt.package_name}@${receipt.package_version}`,
    name: receipt.package_name,
    version: receipt.package_version,
    filename: `${receipt.package_name}-${receipt.package_version}.tgz`,
    size: bytes.length,
    unpackedSize: receipt.unpacked_bytes,
    shasum: digest(bytes, 'sha1', 'hex'),
    integrity: `sha512-${digest(bytes, 'sha512', 'base64')}`,
    entryCount: receipt.file_count,
    files: []
  }
}

function viewInfo(receipt: ReleasePackReceipt, bytes: Buffer) {
  return {
    id: STAGE_ID,
    packageName: receipt.package_name,
    version: receipt.package_version,
    tag: 'latest',
    shasum: digest(bytes, 'sha1', 'hex')
  }
}

function fixtureEnv(tarball: string, npmDownloadInfo: Record<string, unknown>, npmViewInfo: Record<string, unknown>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: '',
    GITHUB_ACTIONS: '',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
    ACTIONS_ID_TOKEN_REQUEST_URL: '',
    NPM_ID_TOKEN: '',
    SIGSTORE_ID_TOKEN: '',
    FAKE_STAGE_TARBALL: tarball,
    FAKE_NPM_DOWNLOAD_INFO: JSON.stringify(npmDownloadInfo),
    FAKE_NPM_VIEW_INFO: JSON.stringify(npmViewInfo),
    FAKE_NPM_VERSION: REQUIRED_NPM_STAGE_CLI_VERSION
  }
}

function createFakeNpm(root: string): string {
  // Keep the fixture extensionless, just like the real `npm` executable found
  // through PATH. Node 20 treats an extensionless shebang script as CommonJS,
  // so using ESM syntax here would make the PATH-only CLI probe fail before it
  // can report its version.
  const file = path.join(root, 'fake-npm')
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write(String(process.env.FAKE_NPM_VERSION || ''))
  process.exit(0)
}
if (args[0] !== 'stage' || !['view', 'download'].includes(args[1])) process.exit(64)
const stageId = String(args[2] || '')
if (args[1] === 'view') {
  process.stdout.write(String(process.env.FAKE_NPM_VIEW_INFO || '{}'))
  process.exit(0)
}
const info = JSON.parse(String(process.env.FAKE_NPM_DOWNLOAD_INFO || '{}'))
const name = String(info.name || '')
const version = String(info.version || '')
const filename = name.replace('@', '').replace('/', '-') + '-' + version + '-' + stageId + '.tgz'
fs.copyFileSync(String(process.env.FAKE_STAGE_TARBALL || ''), filename)
process.stdout.write(JSON.stringify({ [name]: info }, null, 2))
`)
  fs.chmodSync(file, 0o755)
  return file
}

function digest(value: Buffer, algorithm: 'sha1' | 'sha256' | 'sha512', encoding: 'hex' | 'base64'): string {
  return crypto.createHash(algorithm).update(value).digest(encoding)
}
