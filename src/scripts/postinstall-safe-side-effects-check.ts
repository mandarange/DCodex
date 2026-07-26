#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { root, assertGate, emitGate, readText } from './gate-lib.js';

// Locks the guarantee that `postinstall` performs no heavy / network / process-kill
// side-effects by default. This is STATIC source analysis only — we never execute
// `postinstall`, because doing so would mutate the global Codex App / shell environment.

const helpers = readText('src/cli/install-helpers.ts');
const desktopConfigPolicy = readText('src/core/codex-runtime/codex-desktop-config-policy.ts');
const codexConfigGuard = readText('src/core/codex/codex-config-guard.ts');

// Heavy CLI tool installs (brew / npm globals) are opt-in only.
assertGate(
  helpers.includes('SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS'),
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

// Config writes are gated (unparseable preserved / unsafe rewrite skipped) and backed up.
assertGate(helpers.includes('unparseable_config_preserved'), 'postinstall must preserve unparseable config');
assertGate(helpers.includes('skipped_unsafe_rewrite'), 'postinstall must skip unsafe config rewrites');
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

// Explicit repair / opt-in paths must be surfaced to the user.
assertGate(helpers.includes('sks bootstrap'), 'postinstall must surface `sks bootstrap` repair path');
assertGate(helpers.includes('sks deps check'), 'postinstall must surface `sks deps check` repair path');
assertGate(helpers.includes('sks doctor --fix'), 'postinstall must surface `sks doctor --fix` repair path');
assertGate(
  helpers.includes('SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS=1'),
  'postinstall hint must mention the SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS=1 opt-in'
);

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
  gated: ['cli_install', 'process_kill', 'config_write'],
  try_catch_finally: true,
  managed_config_set_if_absent: true
};
const out = path.join(root, '.sneakoscope/reports/postinstall-safe-side-effects.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

emitGate('postinstall:safe-side-effects', {
  gated: ['cli_install', 'process_kill', 'config_write'],
  try_catch_finally: true
});
