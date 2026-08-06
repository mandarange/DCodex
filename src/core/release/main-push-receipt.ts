import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { MAIN_PUSH_GUARD_SCHEMA, validateReleaseUpgradeProof } from './main-push-guard.js'
import { readMacosMenubarProof, validateMacosMenubarProofArtifacts } from './macos-menubar-proof.js'
import { gitOk, gitText, readJson } from './release-proof-io.js'
import { releaseProofDir, validateLocalReleasePackBinding } from './release-pack-receipt.js'
import { validateFullReleaseStamp } from './release-stamp-proof.js'
import { releaseOriginIdentity } from './release-origin.js'
import { validatePhysicalReleaseGateInspection } from './physical-release-gates.js'

export const MAIN_PUSH_RECEIPT_SCHEMA = 'sks.main-push-receipt.v1'

export type MainPushMethod = 'fast-forward' | 'protected-pr-merge'

export function inspectMainPushReceipt(input: {
  root: string
  version: string
  baseline: string
  method: MainPushMethod
  expectedOriginIdentity: string
}) {
  const blockers: string[] = []
  const pkg = readJson(path.join(input.root, 'package.json')) || {}
  const head = gitText(input.root, ['rev-parse', 'HEAD'])
  const originMain = gitText(input.root, ['rev-parse', 'origin/main'])
  const remoteMain = gitRemoteMain(input.root)
  const origin = releaseOriginIdentity(input.root)
  const proofDir = releaseProofDir(input.root, input.version)
  const guard = readJson(path.join(proofDir, 'main-push-guard.json'))
  const releaseStamp = path.join('.sneakoscope', 'reports', 'release-check-stamp.json')
  const packProof = path.relative(input.root, path.join(proofDir, 'pack-receipt.json'))
  const macosProof = path.relative(input.root, path.join(proofDir, 'macos-menubar-proof.json'))
  if (pkg.version !== input.version) blockers.push('package_version_mismatch')
  if (!/^[a-f0-9]{40}$/i.test(input.baseline)) blockers.push('baseline_sha_invalid')
  if (!head) blockers.push('head_sha_unavailable')
  if (!remoteMain) blockers.push('remote_main_sha_unavailable')
  if (head && remoteMain !== head) blockers.push('remote_main_does_not_match_head')
  if (!origin.identity || origin.identity !== input.expectedOriginIdentity) blockers.push(`origin_identity_mismatch:${origin.identity || 'missing'}`)
  if (head && !gitOk(input.root, ['merge-base', '--is-ancestor', input.baseline, head])) blockers.push('baseline_not_ancestor_of_main')
  if (gitText(input.root, ['status', '--porcelain=v1'])) blockers.push('worktree_not_clean')
  if (guard?.schema !== MAIN_PUSH_GUARD_SCHEMA || guard?.ok !== true) blockers.push('pre_push_guard_missing_or_invalid')
  if (head && guard?.head !== head) blockers.push('pre_push_guard_head_mismatch')
  if (guard?.expected_origin_main !== input.baseline) blockers.push('pre_push_guard_baseline_mismatch')
  if (guard?.expected_origin_identity !== input.expectedOriginIdentity || guard?.actual_origin_identity !== input.expectedOriginIdentity) blockers.push('pre_push_guard_origin_identity_mismatch')
  if (!Array.isArray(guard?.blockers) || guard.blockers.length > 0) blockers.push('pre_push_guard_blockers_present')

  const stampValidation = validateFullReleaseStamp({
    root: input.root,
    stampFile: path.join(input.root, releaseStamp),
    expectedVersion: input.version,
    expectedHead: head
  })
  if (!stampValidation.ok) blockers.push(...stampValidation.blockers)
  const pack = readJson(path.join(input.root, packProof))
  const packValidation = validateLocalReleasePackBinding(input.root, pack)
  if (!packValidation.ok) blockers.push(...packValidation.blockers.map((blocker) => `pack_receipt:${blocker}`))
  if (pack?.package_version !== input.version) blockers.push('pack_receipt_version_mismatch')
  if (pack?.source_commit !== head) blockers.push('pack_receipt_source_commit_mismatch')
  const upgrade = validateReleaseUpgradeProof(input.root, input.version, head, pack)
  if (!upgrade.ok) blockers.push(...upgrade.blockers.map((blocker) => `upgrade_proof:${blocker}`))
  if (guard?.upgrade_proof?.ok !== true || guard?.upgrade_proof?.path !== upgrade.path
    || guard?.upgrade_proof?.sha256 !== upgrade.sha256) blockers.push('pre_push_guard_upgrade_proof_mismatch')
  const macos = readMacosMenubarProof(input.root, input.version)
  const macosValidation = validateMacosMenubarProofArtifacts(input.root, macos, {
    version: input.version,
    sourceCommit: head,
    upgradeReportPath: upgrade.path,
    upgradeReportSha256: upgrade.sha256,
    targetTarballSha256: pack?.sha256
  })
  if (!macosValidation.ok) blockers.push(...macosValidation.blockers)
  const physical = validatePhysicalReleaseGateInspection({
    root: input.root,
    version: input.version,
    sourceCommit: head
  })
  if (!physical.ok) blockers.push(...physical.blockers.map((blocker) => `physical_proof:${blocker}`))
  if (guard?.physical_proof !== physical.path) blockers.push('pre_push_guard_physical_proof_mismatch')
  return {
    schema: MAIN_PUSH_RECEIPT_SCHEMA,
    ok: blockers.length === 0,
    version: input.version,
    baseline: input.baseline,
    main_sha: head || null,
    origin_main_sha: originMain || null,
    remote_main_sha: remoteMain || null,
    expected_origin_identity: input.expectedOriginIdentity,
    actual_origin_identity: origin.identity || null,
    actual_origin_url: origin.url || null,
    pushed_at: new Date().toISOString(),
    method: input.method,
    release_stamp: releaseStamp,
    pack_proof: packProof,
    upgrade_proof: upgrade,
    macos_proof: macosProof,
    physical_proof: physical.path,
    blockers: [...new Set(blockers)]
  }
}

function gitRemoteMain(root: string): string {
  const result = spawnSync('git', ['ls-remote', '--heads', 'origin', 'refs/heads/main'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  if (result.status !== 0) return ''
  const value = String(result.stdout || '').trim().split(/\s+/, 1)[0] || ''
  return /^[a-f0-9]{40}$/i.test(value) ? value : ''
}
