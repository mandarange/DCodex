#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { root, assertGate, emitGate, readText } from './gate-lib.js';

// Locks the source-level guarantee that default `postinstall` returns before
// consumer/global mutation. The installed-package smoke separately executes the
// packed lifecycle in disposable HOME/CODEX_HOME/global roots.

const helpers = readText('src/cli/install-helpers.ts');
const installSupport = readText('src/cli/install-helpers-install-support.ts');
const installToolHelpers = readText('src/cli/install-tool-helpers.ts');
const installedSmoke = readText('src/core/install/installed-package-smoke.ts');
const desktopConfigPolicy = readText('src/core/codex-runtime/codex-desktop-config-policy.ts');
const codexConfigGuard = readText('src/core/codex/codex-config-guard.ts');
const designPolicy = readText('src/core/routes/design-policy.ts');

// Heavy CLI tool installs (brew / npm globals) are opt-in only.
assertGate(
  installToolHelpers.includes('SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS'),
  'postinstall cli tool install must be gated behind SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS'
);

// Killing a third-party app's processes is opt-in only.
assertGate(
  helpers.includes("SKS_POSTINSTALL_RECONCILE_APP_PROCESSES === '1'"),
  'postinstall process reconciliation must be gated behind SKS_POSTINSTALL_RECONCILE_APP_PROCESSES'
);

assertGate(
  helpers.includes('runPostinstallProjectRetentionCleanup') && helpers.includes('SKS_POSTINSTALL_RETENTION_CLEANUP'),
  'postinstall mission retention cleanup must be project-scoped and disableable'
);

const getdesignStart = installSupport.indexOf('export async function ensureGlobalGetdesignSkillDuringInstall');
assertGate(getdesignStart !== -1, 'getdesign postinstall helper not found');
const getdesignNextExport = installSupport.indexOf('\nexport ', getdesignStart + 1);
const getdesignBody = installSupport.slice(getdesignStart, getdesignNextExport === -1 ? installSupport.length : getdesignNextExport);
assertGate(
  getdesignBody.includes("reason: 'manual_install_only'"),
  'third-party getdesign install must remain manual-only'
);
assertGate(
  !getdesignBody.includes('runProcess') && !getdesignBody.includes('findCommandOnPath'),
  'postinstall must not execute a third-party getdesign installer'
);
assertGate(
  designPolicy.includes("codex_skill_install_mode: 'manual_only'"),
  'getdesign install metadata must identify the command as manual-only'
);
assertGate(
  designPolicy.includes(' -g -a codex -y`') && !designPolicy.includes('--agent codex'),
  'manual getdesign guidance must use current Skills CLI short flags without reviving the retired SKS --agent option'
);
assertGate(
  /GETDESIGN_CODEX_SKILL_REF = '[a-f0-9]{40}'/.test(designPolicy),
  'getdesign metadata must record the reviewed upstream commit'
);

// Any remaining explicit config writes use the guarded desktop policy and backup.
assertGate(desktopConfigPolicy.includes('backupCodexConfig'), 'postinstall config writes must back up the existing config');

// Host-owned feature choices are set-if-absent, and model/reasoning keys are
// changed only when bounded SKS provenance proves SKS created them.
assertGate(
  desktopConfigPolicy.includes('upsertTomlTableKeyIfAbsent')
    && desktopConfigPolicy.includes('removeLegacyTopLevelCodexModeLocks')
    && codexConfigGuard.includes('hasSksModeLockProvenance'),
  'postinstall must preserve host-owned feature/model choices'
);

// The postinstall() body must be wrapped in try/catch/finally so it never fails `npm install`.
const postinstallStart = helpers.indexOf('export async function postinstall');
assertGate(postinstallStart !== -1, 'postinstall function not found in install-helpers.ts');
const afterStart = postinstallStart + 'export async function postinstall'.length;
const nextExport = helpers.indexOf('\nexport ', afterStart);
const nextAsync = helpers.indexOf('\nasync function ', afterStart);
const candidates = [nextExport, nextAsync].filter((idx) => idx !== -1);
const bodyEnd = candidates.length ? Math.min(...candidates) : helpers.length;
const postinstallBody = helpers.slice(postinstallStart, bodyEnd);
assertGate(postinstallBody.includes('try'), 'postinstall body must use try (never fail npm install)');
assertGate(postinstallBody.includes('catch'), 'postinstall body must use catch (never fail npm install)');
assertGate(postinstallBody.includes('finally'), 'postinstall body must use finally (never fail npm install)');
const defaultReturn = postinstallBody.indexOf('if (!postinstallExternalMutationsAllowed(process.env))');
const conflictScan = postinstallBody.indexOf('scanHarnessConflicts');
assertGate(defaultReturn !== -1, 'postinstall must have a default no-bootstrap return');
assertGate(defaultReturn < conflictScan, 'postinstall default return must precede project scanning');
assertGate(
  !helpers.includes('capturePostinstallCodexLbConfigSnapshot')
    && !helpers.includes('restorePostinstallCodexLbConfigSnapshot')
    && !helpers.includes('ensureStoredOpenRouterProviderDuringInstall')
    && !helpers.includes('ensureCodexLbAuthDuringInstall')
    && !helpers.includes('configureCodexLb(')
    && !helpers.includes('maybePromptCodexLbSetupForLaunch'),
  'postinstall must not retain the retired provider setup/mode pipeline'
);
assertGate(
  helpers.includes('Provider credentials and Codex provider selection were left byte-for-byte unchanged during install.')
    && helpers.includes('sks bridge provider configure codex-lb')
    && helpers.includes('sks bridge provider configure openrouter'),
  'postinstall must preserve provider state and guide explicit Bridge provider configuration'
);
assertGate(
  helpers.includes("process.env.SKS_POSTINSTALL_BOOTSTRAP !== '1'")
    && helpers.includes("process.env.SKS_POSTINSTALL_NO_BOOTSTRAP === '1'"),
  'postinstall external mutation must require explicit bootstrap opt-in with a stronger safety override'
);
assertGate(
  helpers.includes('dist_stamp_outside_package_root')
    && helpers.includes('restoreInstalledPackageBuildStamp'),
  'default postinstall may restore only the package-local build stamp'
);
assertGate(
  installedSmoke.includes("'--foreground-scripts'")
    && !installedSmoke.includes("'--ignore-scripts', '--no-audit', '--no-fund', tarball")
    && installedSmoke.includes('external_snapshot_match')
    && installedSmoke.includes('postinstall_default_launchctl_called'),
  'installed-package smoke must execute the packed default lifecycle and prove zero external mutation'
);

// Explicit repair / opt-in paths must be surfaced to the user.
assertGate(helpers.includes('sks bootstrap'), 'postinstall must surface `sks bootstrap` repair path');
assertGate(helpers.includes('sks deps check'), 'postinstall must surface `sks deps check` repair path');
assertGate(
  helpers.includes("['sks doctor', '--fix'].join(' ')"),
  'postinstall must surface the explicit Doctor repair path'
);
assertGate(
  helpers.includes('SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS=1'),
  'postinstall hint must mention the SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS=1 opt-in'
);
assertGate(helpers.includes('not installed automatically'), 'postinstall hint must identify getdesign as manual-only');

// init.ts hardening: managed Codex config merge is set-if-absent and never force-overwrites features.
const init = readText('src/core/init.ts');
const mergeStart = init.indexOf('mergeManagedCodexConfigToml(');
assertGate(mergeStart !== -1, 'mergeManagedCodexConfigToml not found in init.ts');
const afterMergeStart = mergeStart + 'mergeManagedCodexConfigToml('.length;
const mergeNextExport = init.indexOf('\nexport ', afterMergeStart);
const mergeNextAsync = init.indexOf('\nasync function ', afterMergeStart);
const mergeNextFn = init.indexOf('\nfunction ', afterMergeStart);
const mergeCandidates = [mergeNextExport, mergeNextAsync, mergeNextFn].filter((idx) => idx !== -1);
const mergeEnd = mergeCandidates.length ? Math.min(...mergeCandidates) : init.length;
const mergeBody = init.slice(mergeStart, mergeEnd);
assertGate(
  mergeBody.includes('upsertTomlTableKeyIfAbsent'),
  'managed config merge must set feature flags only when absent'
);
assertGate(
  mergeBody.includes("SKS_MANAGE_CODEX_APP_PLUGINS === '1'"),
  'managed config plugin auto-enable must be opt-in via SKS_MANAGE_CODEX_APP_PLUGINS=1'
);
assertGate(
  !/upsertTomlTableKey\(next, 'features'/.test(mergeBody),
  'managed config merge must NOT force-overwrite the features table'
);

const report = {
  schema: 'sks.postinstall-safe-side-effects.v1',
  ok: true,
  gated: ['default_external_mutation', 'cli_install', 'third_party_skill_install', 'process_kill', 'config_write'],
  default_opt_in_required: true,
  packed_default_install_proof: true,
  try_catch_finally: true,
  managed_config_set_if_absent: true
};
const out = path.join(root, '.sneakoscope/reports/postinstall-safe-side-effects.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

emitGate('postinstall:safe-side-effects', {
  gated: ['default_external_mutation', 'cli_install', 'third_party_skill_install', 'process_kill', 'config_write'],
  default_opt_in_required: true,
  packed_default_install_proof: true,
  try_catch_finally: true
});
