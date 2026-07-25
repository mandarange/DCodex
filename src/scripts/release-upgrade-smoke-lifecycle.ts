import {
  RELEASE_UPGRADE_BASELINE_VERSION,
  type ReleaseUpgradeCommandReceipt,
  type ReleaseUpgradeCommandRunner,
  type ReleaseUpgradeLifecycleInput,
  type ReleaseUpgradeLifecycleResult
} from './release-upgrade-smoke-contract.js'
import {
  doctorProbe,
  installAndInspectMenuBar,
  installSealedTarball,
  jsonProbe,
  versionProbe
} from './release-upgrade-smoke-probes.js'
import {
  completeReleaseUpgradeState,
  failedReleaseUpgradeProbe,
  newReleaseUpgradeStates,
  skipReleaseUpgradeState
} from './release-upgrade-smoke-report.js'
import { installedPackageRoot, samePath, sksBinary, stringOrNull, unique } from './release-upgrade-smoke-utils.js'

export async function runValidatedReleaseUpgradeLifecycle(
  input: ReleaseUpgradeLifecycleInput,
  runner: ReleaseUpgradeCommandRunner
): Promise<ReleaseUpgradeLifecycleResult> {
  const commands: ReleaseUpgradeCommandReceipt[] = []
  const states = newReleaseUpgradeStates()
  const blockers: string[] = []
  const bin = sksBinary(input.isolation.npmPrefix, input.platform)
  const packageRoot = installedPackageRoot(input.isolation.npmPrefix, input.platform)
  let targetInstallAttempted = false

  const baselineInstall = await installSealedTarball(
    input, runner, commands, 'baseline_install', input.baselineTarball, input.baselineSha256, 'baseline'
  )
  const baselineVersion = baselineInstall.result?.code === 0
    ? await versionProbe(input, runner, commands, 'baseline_version', bin, RELEASE_UPGRADE_BASELINE_VERSION)
    : failedReleaseUpgradeProbe('baseline_install_failed')
  const baselineBootstrap = baselineVersion.ok
    ? await jsonProbe(input, runner, commands, 'baseline_bootstrap', bin, ['bootstrap', '--json'],
      (json) => json?.schema === 'sks.setup.v1'
        && json?.ok === true
        && json?.status === 'completed'
        && json?.local_only === true
        && typeof json?.root === 'string'
        && samePath(json.root, input.isolation.workspace),
      'baseline_bootstrap_failed')
    : failedReleaseUpgradeProbe('baseline_version_unverified')
  const baselineDoctor = baselineBootstrap.ok
    ? await doctorProbe(
      input, runner, commands, 'baseline_doctor', bin, RELEASE_UPGRADE_BASELINE_VERSION,
      'pinned_baseline_stdout_compatible'
    )
    : failedReleaseUpgradeProbe('baseline_bootstrap_unverified')
  completeReleaseUpgradeState(states.baseline_package, RELEASE_UPGRADE_BASELINE_VERSION, baselineVersion.version, [
    'baseline_install', 'baseline_version', 'baseline_bootstrap', 'baseline_doctor'
  ], [
    ...(baselineInstall.result?.code === 0 ? [] : ['baseline_install_failed']),
    ...baselineInstall.blockers,
    ...baselineVersion.blockers, ...baselineBootstrap.blockers, ...baselineDoctor.blockers
  ])
  blockers.push(...states.baseline_package.blockers)

  if (!blockers.length && input.platform === 'darwin') {
    const menu = await installAndInspectMenuBar(
      input, runner, commands, bin, packageRoot, RELEASE_UPGRADE_BASELINE_VERSION, 'baseline_menubar', false
    )
    completeReleaseUpgradeState(
      states.baseline_menubar,
      RELEASE_UPGRADE_BASELINE_VERSION,
      menu.version,
      menu.stages,
      menu.blockers
    )
    blockers.push(...menu.blockers)
  } else {
    skipReleaseUpgradeState(
      states.baseline_menubar,
      input.platform === 'darwin' ? 'baseline_package_unverified' : 'not_macos'
    )
  }

  if (!blockers.length) {
    targetInstallAttempted = true
    const targetInstall = await installSealedTarball(
      input, runner, commands, 'target_install', input.targetTarball, input.targetSha256, 'target'
    )
    const targetVersion = targetInstall.result?.code === 0
      ? await versionProbe(input, runner, commands, 'target_version', bin, input.targetVersion)
      : failedReleaseUpgradeProbe('target_install_failed')
    const targetDoctor = targetVersion.ok
      ? await doctorProbe(input, runner, commands, 'target_doctor', bin, input.targetVersion)
      : failedReleaseUpgradeProbe('target_version_unverified')
    completeReleaseUpgradeState(states.target_package, input.targetVersion, targetVersion.version, [
      'target_install', 'target_version', 'target_doctor'
    ], [
      ...(targetInstall.result?.code === 0 ? [] : ['target_install_failed']),
      ...targetInstall.blockers,
      ...targetVersion.blockers, ...targetDoctor.blockers
    ])
    blockers.push(...states.target_package.blockers)
  } else {
    skipReleaseUpgradeState(states.target_package, 'baseline_phase_failed')
  }

  if (states.target_package.status === 'passed' && input.platform === 'darwin') {
    const menu = await installAndInspectMenuBar(
      input, runner, commands, bin, packageRoot, input.targetVersion, 'target_menubar', true
    )
    completeReleaseUpgradeState(states.target_menubar, input.targetVersion, menu.version, menu.stages, menu.blockers)
    blockers.push(...menu.blockers)
    if (menu.blockers.length === 0) {
      const rollback = await jsonProbe(
        input, runner, commands, 'target_menubar_rollback', bin,
        ['menubar', 'rollback', '--no-launch', '--json', '--home', input.isolation.home, '--root', packageRoot],
        (json) => validateReleaseUpgradeMenuBarRollbackReceipt(json, input.targetVersion),
        'target_menubar_rollback_failed'
      )
      completeReleaseUpgradeState(
        states.menubar_rollback,
        RELEASE_UPGRADE_BASELINE_VERSION,
        rollback.json ? stringOrNull(rollback.json.previous_version) : null,
        ['target_menubar_rollback'],
        rollback.blockers
      )
      blockers.push(...rollback.blockers)
    } else {
      skipReleaseUpgradeState(states.menubar_rollback, 'target_menubar_unverified')
    }
    const reinstall = await installAndInspectMenuBar(
      input, runner, commands, bin, packageRoot, input.targetVersion, 'target_menubar_reinstall', true
    )
    completeReleaseUpgradeState(
      states.target_menubar_reinstall,
      input.targetVersion,
      reinstall.version,
      reinstall.stages,
      reinstall.blockers
    )
    blockers.push(...reinstall.blockers)
  } else {
    const reason = input.platform === 'darwin' ? 'target_package_unverified' : 'not_macos'
    skipReleaseUpgradeState(states.target_menubar, reason)
    skipReleaseUpgradeState(states.menubar_rollback, reason)
    skipReleaseUpgradeState(states.target_menubar_reinstall, reason)
  }

  if (targetInstallAttempted) {
    const rollbackInstall = await installSealedTarball(
      input, runner, commands, 'package_rollback_install', input.baselineTarball, input.baselineSha256, 'baseline'
    )
    const rollbackVersion = rollbackInstall.result?.code === 0
      ? await versionProbe(input, runner, commands, 'package_rollback_version', bin, RELEASE_UPGRADE_BASELINE_VERSION)
      : failedReleaseUpgradeProbe('package_rollback_install_failed')
    const rollbackDoctor = rollbackVersion.ok
      ? await doctorProbe(
        input, runner, commands, 'package_rollback_doctor', bin, RELEASE_UPGRADE_BASELINE_VERSION,
        'pinned_baseline_stdout_compatible'
      )
      : failedReleaseUpgradeProbe('package_rollback_version_unverified')
    completeReleaseUpgradeState(states.package_rollback, RELEASE_UPGRADE_BASELINE_VERSION, rollbackVersion.version, [
      'package_rollback_install', 'package_rollback_version', 'package_rollback_doctor'
    ], [
      ...(rollbackInstall.result?.code === 0 ? [] : ['package_rollback_install_failed']),
      ...rollbackInstall.blockers,
      ...rollbackVersion.blockers, ...rollbackDoctor.blockers
    ])
    blockers.push(...states.package_rollback.blockers)
  } else {
    skipReleaseUpgradeState(states.package_rollback, 'target_install_not_attempted')
  }
  return { commands, states, blockers: unique(blockers) }
}

export function validateReleaseUpgradeMenuBarRollbackReceipt(json: any, targetVersion: string): boolean {
  return json?.schema === 'sks.menubar-rollback.v1'
    && json?.ok === true
    && json?.status === 'rolled_back_launch_skipped'
    && json?.previous_version === RELEASE_UPGRADE_BASELINE_VERSION
    && json?.replaced_version === targetVersion
    && json?.verification_before?.ok === true
    && json?.verification_after?.ok === true
    && json?.launch?.requested === false
    && json?.launch?.method === 'skipped'
    && json?.launch?.ok === true
    && Array.isArray(json?.blockers)
    && json.blockers.length === 0
}
