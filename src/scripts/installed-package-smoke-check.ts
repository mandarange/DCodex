#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const { runInstalledPackageSmoke } = await importDist('core/install/installed-package-smoke.js')
const report = await runInstalledPackageSmoke(root, {
  ...(option('--tarball') ? { tarball: option('--tarball') } : {}),
  ...(option('--receipt') ? { receipt: option('--receipt') } : {}),
  ...(option('--expected-sha256') ? { expectedSha256: option('--expected-sha256') } : {}),
  keepTemp: process.argv.includes('--keep')
})
assertGate(report.ok, 'installed_package_smoke_failed', report)
emitGate('runtime:installed-smoke', {
  installed_version: report.installed_version,
  commands: report.commands.length,
  tarball: report.tarball,
  tarball_sha256: report.tarball_sha256,
  exact_match: report.tarball_binding.exact_match,
  install_prefix: report.install_prefix,
  postinstall_external_snapshot_match: report.postinstall_default.external_snapshot_match,
  postinstall_launchctl_calls: report.postinstall_default.launchctl_calls.length,
  postinstall_package_local_stamp_present: report.postinstall_default.package_local_stamp_present
})

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : ''
}
