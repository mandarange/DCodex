import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isExpectedReleaseUpgradeLaunchctlCall } from '../core/release/release-upgrade-baseline.js'
import {
  POSTINSTALL_SAFETY_ENV,
  type ReleaseUpgradeIsolation,
  type ReleaseUpgradeIsolationCreationHooks,
  type ReleaseUpgradeSmokeReport
} from './release-upgrade-smoke-contract.js'
import {
  hashBytes,
  hashText,
  isSubpath,
  readRegularFile,
  samePath,
  unique
} from './release-upgrade-smoke-utils.js'

export class ReleaseUpgradeIsolationCreationError extends Error {
  constructor(
    message: string,
    readonly sandbox: string,
    readonly cleanupStatus: 'partial_creation_removed' | 'partial_creation_remove_failed',
    readonly cleanupError: string | null
  ) {
    super(message)
    this.name = 'ReleaseUpgradeIsolationCreationError'
  }
}

export async function createReleaseUpgradeIsolation(
  tmpRoot = os.tmpdir(),
  baseEnv: NodeJS.ProcessEnv = process.env,
  hooks: ReleaseUpgradeIsolationCreationHooks = {}
): Promise<ReleaseUpgradeIsolation> {
  await fsp.mkdir(tmpRoot, { recursive: true })
  const sandbox = await fsp.mkdtemp(path.join(tmpRoot, 'sks-release-upgrade-'))
  try {
    await hooks.afterSandboxCreated?.(sandbox)
    const home = path.join(sandbox, 'home')
    const codexHome = path.join(sandbox, 'codex-home')
    const npmCache = path.join(sandbox, 'npm-cache')
    const npmPrefix = path.join(sandbox, 'npm-prefix')
    const npmUserConfig = path.join(sandbox, 'npmrc')
    const npmGlobalConfig = path.join(sandbox, 'npm-globalrc')
    const workspace = path.join(sandbox, 'workspace')
    const baselinePackDir = path.join(sandbox, 'baseline-pack')
    const commandReportsDir = path.join(sandbox, 'command-reports')
    const sealedInputsDir = path.join(sandbox, 'sealed-inputs')
    const tempDir = path.join(sandbox, 'tmp')
    const sandboxBin = path.join(sandbox, 'bin')
    const globalRoot = path.join(sandbox, 'global-sks')
    const launchctlStub = path.join(sandboxBin, 'launchctl')
    const launchctlLog = path.join(sandbox, 'launchctl-calls.log')
    const launchctlSource = launchctlStubSource()
    const pgrepStub = path.join(sandboxBin, 'pgrep')
    const pgrepSource = pgrepStubSource()
    const psStub = path.join(sandboxBin, 'ps')
    const psSource = psStubSource()
    await Promise.all([
      home, codexHome, npmCache, npmPrefix, workspace, baselinePackDir, commandReportsDir, sealedInputsDir,
      tempDir, sandboxBin, globalRoot
    ].map((dir) => fsp.mkdir(dir, { recursive: true })))
    await Promise.all([
      fsp.writeFile(npmUserConfig, '', { mode: 0o600 }),
      fsp.writeFile(npmGlobalConfig, '', { mode: 0o600 }),
      fsp.writeFile(path.join(workspace, 'package.json'), '{"name":"sks-release-upgrade-smoke","private":true}\n', { mode: 0o600 }),
      fsp.writeFile(launchctlStub, launchctlSource, { mode: 0o700 }),
      fsp.writeFile(pgrepStub, pgrepSource, { mode: 0o700 }),
      fsp.writeFile(psStub, psSource, { mode: 0o700 }),
      fsp.writeFile(launchctlLog, '', { mode: 0o600 })
    ])
    const prefixBin = process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin')
    const env: NodeJS.ProcessEnv = {
      ...POSTINSTALL_SAFETY_ENV,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      TMPDIR: tempDir,
      PWD: workspace,
      INIT_CWD: workspace,
      PATH: `${sandboxBin}${path.delimiter}${prefixBin}${path.delimiter}${String(baseEnv.PATH || '/usr/bin:/bin')}`,
      SHELL: String(baseEnv.SHELL || '/bin/sh'),
      LANG: String(baseEnv.LANG || 'C.UTF-8'),
      LC_ALL: String(baseEnv.LC_ALL || baseEnv.LANG || 'C.UTF-8'),
      USER: 'sks-release-smoke',
      LOGNAME: 'sks-release-smoke',
      SKS_TEST_ISOLATION: '1',
      SKS_RELEASE_UPGRADE_SMOKE: '1',
      SKS_RELEASE_UPGRADE_LAUNCHCTL_LOG: launchctlLog,
      SKS_GLOBAL_ROOT: globalRoot,
      SKS_MENUBAR_LAUNCHCTL: launchctlStub,
      // Process discovery escapes the HOME redirect: the duplicate-install scan
      // shells out to `pgrep -U <uid>`, which sees the operator's own running
      // Menu Bar and correctly reports it as a duplicate of the sandbox's. That
      // is a true finding about the host, not about the upgrade, and it made the
      // proof unobtainable on any machine with SKS installed. Scope discovery to
      // the sandbox through the seam the product already exposes. The seam only
      // opens when this flag is set, so naming the tools without it is silently
      // ignored and the real host binaries run instead. Both tools are stubbed:
      // `pgrep` finds the candidates and `ps` resolves the ones it could not.
      SKS_MENUBAR_TEST_PROCESS_TOOLS: '1',
      SKS_MENUBAR_PGREP: pgrepStub,
      SKS_MENUBAR_PS: psStub,
      SKS_DISABLE_UPDATE_CHECK: '1',
      SKS_SKIP_SKS_MENUBAR_LAUNCH: '1',
      NO_UPDATE_NOTIFIER: '1',
      npm_config_cache: npmCache,
      NPM_CONFIG_CACHE: npmCache,
      npm_config_prefix: npmPrefix,
      NPM_CONFIG_PREFIX: npmPrefix,
      npm_config_userconfig: npmUserConfig,
      NPM_CONFIG_USERCONFIG: npmUserConfig,
      npm_config_globalconfig: npmGlobalConfig,
      NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
      npm_config_registry: 'https://registry.npmjs.org/',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      npm_config_update_notifier: 'false',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false'
    }
    return {
      sandbox, home, codexHome, npmCache, npmPrefix, npmUserConfig, npmGlobalConfig,
      workspace, baselinePackDir, commandReportsDir, sealedInputsDir, launchctlStub, launchctlLog,
      launchctlStubSha256: hashText(launchctlSource), env
    }
  } catch (error) {
    const remove = hooks.removeSandbox || defaultRemoveReleaseUpgradeSandbox
    const cleanup = await removeReleaseUpgradeSandbox(sandbox, remove)
    throw new ReleaseUpgradeIsolationCreationError(
      error instanceof Error ? error.message : String(error),
      sandbox,
      cleanup.status === 'removed' ? 'partial_creation_removed' : 'partial_creation_remove_failed',
      cleanup.error
    )
  }
}

export async function removeReleaseUpgradeSandbox(
  sandbox: string,
  remove: (sandbox: string) => Promise<void> = defaultRemoveReleaseUpgradeSandbox
): Promise<{
  status: 'removed' | 'remove_failed'
  retained: boolean
  removed: boolean
  error: string | null
  blockers: string[]
}> {
  let error: string | null = null
  try {
    await remove(sandbox)
  } catch (value) {
    error = value instanceof Error ? value.message : String(value)
  }
  const retained = fs.existsSync(sandbox)
  if (error || retained) {
    return {
      status: 'remove_failed', retained, removed: !retained, error: error || 'sandbox_still_exists_after_remove',
      blockers: [`sandbox_cleanup_failed:${error || 'sandbox_still_exists_after_remove'}`]
    }
  }
  return { status: 'removed', retained: false, removed: true, error: null, blockers: [] }
}

export async function defaultRemoveReleaseUpgradeSandbox(sandbox: string): Promise<void> {
  await fsp.rm(sandbox, { recursive: true, force: true })
}

export function inspectReleaseSourceCleanliness(rootInput: string): ReleaseUpgradeSmokeReport['source_tree'] {
  const root = path.resolve(rootInput)
  const blockers: string[] = []
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024
  })
  const gitRoot = top.status === 0 ? String(top.stdout || '').trim() || null : null
  if (!gitRoot) blockers.push('release_source_git_root_unavailable')
  else {
    try {
      const resolvedGitRoot = fs.realpathSync.native(gitRoot)
      const resolvedRoot = fs.realpathSync.native(root)
      if (resolvedGitRoot !== resolvedRoot) blockers.push('release_source_root_not_git_toplevel')
    } catch {
      blockers.push('release_source_realpath_unavailable')
    }
  }
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024
  })
  const head = headResult.status === 0 ? String(headResult.stdout || '').trim() || null : null
  if (!/^[a-f0-9]{40}$/i.test(String(head || ''))) blockers.push('release_source_head_invalid')
  const statusResult = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
  })
  const statusText = statusResult.status === 0 ? String(statusResult.stdout || '') : ''
  if (statusResult.status !== 0) blockers.push('release_source_status_failed')
  const dirtyEntries = statusText.split(/\r?\n/).map((row) => row.trimEnd()).filter(Boolean)
  if (dirtyEntries.length) blockers.push('release_source_tree_dirty')
  return {
    ok: blockers.length === 0,
    git_root: gitRoot,
    head,
    status_sha256: statusResult.status === 0 ? hashText(statusText) : null,
    dirty_entries: dirtyEntries,
    blockers: unique(blockers)
  }
}

export function sealReleaseUpgradeTarball(
  sourceInput: string,
  expectedSha256: string,
  isolation: ReleaseUpgradeIsolation,
  filename: string
): { path: string | null; blockers: string[] } {
  const source = path.resolve(sourceInput)
  const destination = path.join(isolation.sealedInputsDir, path.basename(filename))
  const blockers: string[] = []
  if (filename !== path.basename(filename) || !filename.endsWith('.tgz')) blockers.push('sealed_tarball_filename_invalid')
  if (!isSubpath(destination, isolation.sealedInputsDir)) blockers.push('sealed_tarball_destination_outside_sandbox')
  const sourceFile = readRegularFile(source, 'sealed_tarball_source')
  blockers.push(...sourceFile.blockers)
  if (sourceFile.bytes && hashBytes(sourceFile.bytes) !== expectedSha256) blockers.push('sealed_tarball_source_sha256_mismatch')
  if (blockers.length) return { path: null, blockers: unique(blockers) }
  try {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(destination, 0o400)
  } catch (error) {
    return {
      path: null,
      blockers: [`sealed_tarball_copy_failed:${error instanceof Error ? error.message : String(error)}`]
    }
  }
  const verified = verifySealedTarball(destination, expectedSha256, isolation, 'copy')
  return { path: verified.length ? null : destination, blockers: verified }
}

export function verifySealedTarball(
  tarballInput: string,
  expectedSha256: string,
  isolation: ReleaseUpgradeIsolation,
  label: string
): string[] {
  const tarball = path.resolve(tarballInput)
  const blockers: string[] = []
  if (!isSubpath(tarball, isolation.sealedInputsDir)) blockers.push(`sealed_${label}_path_outside_sandbox`)
  const file = readRegularFile(tarball, `sealed_${label}`)
  blockers.push(...file.blockers)
  if (file.bytes && hashBytes(file.bytes) !== expectedSha256) blockers.push(`sealed_${label}_sha256_mismatch`)
  try {
    const real = fs.realpathSync.native(tarball)
    if (!isSubpath(real, isolation.sealedInputsDir)) blockers.push(`sealed_${label}_realpath_outside_sandbox`)
    if ((fs.statSync(tarball).mode & 0o222) !== 0) blockers.push(`sealed_${label}_writable`)
  } catch {
    blockers.push(`sealed_${label}_metadata_unavailable`)
  }
  return unique(blockers)
}

export function validateReleaseUpgradeIsolation(isolation: ReleaseUpgradeIsolation): string[] {
  const blockers: string[] = []
  for (const [name, value] of [
    ['home', isolation.home], ['codex_home', isolation.codexHome], ['npm_cache', isolation.npmCache],
    ['npm_prefix', isolation.npmPrefix], ['npm_userconfig', isolation.npmUserConfig],
    ['npm_globalconfig', isolation.npmGlobalConfig], ['workspace', isolation.workspace],
    ['baseline_pack', isolation.baselinePackDir], ['command_reports', isolation.commandReportsDir],
    ['sealed_inputs', isolation.sealedInputsDir],
    ['launchctl_stub', isolation.launchctlStub], ['launchctl_log', isolation.launchctlLog]
  ] as const) {
    if (!isSubpath(value, isolation.sandbox)) blockers.push(`isolation_path_outside_sandbox:${name}`)
  }
  if (samePath(isolation.home, process.env.HOME)) blockers.push('host_home_reused')
  if (samePath(isolation.codexHome, process.env.CODEX_HOME)) blockers.push('host_codex_home_reused')
  if (samePath(isolation.npmPrefix, process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX)) blockers.push('host_npm_prefix_reused')
  if (isolation.env.HOME !== isolation.home) blockers.push('isolated_home_env_mismatch')
  if (isolation.env.CODEX_HOME !== isolation.codexHome) blockers.push('isolated_codex_home_env_mismatch')
  if (isolation.env.npm_config_prefix !== isolation.npmPrefix) blockers.push('isolated_npm_prefix_env_mismatch')
  if (isolation.env.npm_config_cache !== isolation.npmCache) blockers.push('isolated_npm_cache_env_mismatch')
  if (isolation.env.SKS_MENUBAR_LAUNCHCTL !== isolation.launchctlStub) blockers.push('isolated_launchctl_stub_env_mismatch')
  if (isolation.env.SKS_RELEASE_UPGRADE_LAUNCHCTL_LOG !== isolation.launchctlLog) blockers.push('isolated_launchctl_log_env_mismatch')
  const firstPathEntry = String(isolation.env.PATH || '').split(path.delimiter)[0] || ''
  if (!samePath(firstPathEntry, path.dirname(isolation.launchctlStub))) blockers.push('isolated_launchctl_stub_not_first_on_path')
  const stub = readRegularFile(isolation.launchctlStub, 'launchctl_stub')
  blockers.push(...stub.blockers)
  if (stub.bytes && hashBytes(stub.bytes) !== isolation.launchctlStubSha256) blockers.push('launchctl_stub_hash_mismatch')
  try {
    if ((fs.statSync(isolation.launchctlStub).mode & 0o111) === 0) blockers.push('launchctl_stub_not_executable')
  } catch {
    blockers.push('launchctl_stub_mode_unavailable')
  }
  return blockers
}

export function inspectReleaseUpgradeLaunchctlLog(isolation: ReleaseUpgradeIsolation): {
  calls: string[]
  unexpected: string[]
  blockers: string[]
} {
  let text: string
  try {
    const stat = fs.lstatSync(isolation.launchctlLog)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { calls: [], unexpected: [], blockers: ['launchctl_stub_log_not_regular_file'] }
    }
    const real = fs.realpathSync(isolation.launchctlLog)
    if (!isSubpath(real, isolation.sandbox)) {
      return { calls: [], unexpected: [], blockers: ['launchctl_stub_log_outside_sandbox'] }
    }
    text = fs.readFileSync(isolation.launchctlLog, 'utf8')
  } catch {
    return { calls: [], unexpected: [], blockers: ['launchctl_stub_log_missing_or_unreadable'] }
  }
  const calls = text.split(/\r?\n/).map((row) => row.trim()).filter(Boolean)
  const unexpected = calls.filter((row) => !isExpectedReleaseUpgradeLaunchctlCall(row))
  return {
    calls,
    unexpected,
    blockers: unexpected.map((row) => `launchctl_stub_unexpected_call:${row}`)
  }
}

// The sandbox never talks to real launchd, so this stub *is* what the upgrade
// under test observes. It therefore has to answer the way launchctl actually
// answers — a probe reply the product cannot classify makes it fail closed and
// blocks the upgrade for a reason that does not exist outside the sandbox.
// `print` for a service that is not loaded must reproduce launchctl's exact
// wording; the sandbox HOME carries no LaunchAgent, so "absent" is the truth.
/**
 * `pgrep` for the sandbox: nothing this upgrade installed was ever launched
 * (`--no-launch`, `SKS_SKIP_SKS_MENUBAR_LAUNCH=1`), so "no process matched" is
 * the truthful answer. Real pgrep signals that with exit 1 and no output, which
 * is what the callers already handle. It reports no PID it did not start, and
 * it can never see — or act on — a process outside the sandbox.
 */
function pgrepStubSource(): string {
  return [
    '#!/bin/sh',
    'exit 1',
    ''
  ].join('\n')
}

/** Same contract as the pgrep stub: it resolves no pid it did not start. */
function psStubSource(): string {
  return [
    '#!/bin/sh',
    'exit 1',
    ''
  ].join('\n')
}

function launchctlStubSource(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'log="${SKS_RELEASE_UPGRADE_LAUNCHCTL_LOG:?missing launchctl log}"',
    'command_name="${1:-}"',
    'case "$command_name" in',
    '  unsetenv)',
    '    case "${2:-}" in',
    '      CODEX_LB_API_KEY|OPENROUTER_API_KEY) printf "unsetenv %s\\n" "$2" >> "$log"; exit 0 ;;',
    '      *) printf "forbidden unsetenv [redacted]\\n" >> "$log"; exit 64 ;;',
    '    esac',
    '    ;;',
    '  print) printf "print\\n" >> "$log"; printf "Bad request.\\n" >&2; printf "Could not find service \\"%s\\" in domain for user gui: sandbox\\n" "${2:-}" >&2; exit 113 ;;',
    // Replacing an existing install is the whole point of this smoke, and that
    // path boots out the service it is about to replace. Refusing every bootout
    // made the upgrade unprovable rather than proving anything. The capability
    // stays bounded instead: only this product's own labels, and by-plist only
    // for a plist inside the sandbox HOME. Anything else is still forbidden and
    // still surfaces as an unexpected call.
    '  bootout)',
    '    bootout_target="${2:-}"',
    '    bootout_plist="${3:-}"',
    '    bootout_label=""',
    '    case "$bootout_target" in',
    '      */com.sneakoscope.sks-menubar) bootout_label="com.sneakoscope.sks-menubar" ;;',
    '      */com.sneakoscope.telegram-hub) bootout_label="com.sneakoscope.telegram-hub" ;;',
    '      gui/*)',
    '        case "$bootout_plist" in',
    '          "${HOME:-/nonexistent}"/*/com.sneakoscope.sks-menubar.plist) bootout_label="com.sneakoscope.sks-menubar" ;;',
    '          "${HOME:-/nonexistent}"/*/com.sneakoscope.telegram-hub.plist) bootout_label="com.sneakoscope.telegram-hub" ;;',
    '        esac',
    '        ;;',
    '    esac',
    '    if [ -n "$bootout_label" ]; then printf "bootout %s\\n" "$bootout_label" >> "$log"; exit 0; fi',
    '    printf "forbidden bootout [redacted]\\n" >> "$log"; exit 64',
    '    ;;',
    '  bootstrap|kickstart|setenv|getenv) printf "forbidden %s\\n" "$command_name" >> "$log"; exit 64 ;;',
    '  *) printf "forbidden other\\n" >> "$log"; exit 64 ;;',
    'esac',
    ''
  ].join('\n')
}
