#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText, scriptContains } from './gate-lib.js';

const install = readText('src/cli/install-helpers.ts');
const helper = readText('src/core/update/update-migration-state.ts');

assertGate(install.includes('runPostinstallGlobalDoctorAndMarkPending'), 'postinstall must run package-local global Doctor and mark pending migration');
assertGate(helper.includes("source: 'postinstall'"), 'postinstall migration marker must identify postinstall as source');
assertGate(helper.includes("root: globalSksRoot()"), 'postinstall Doctor must run against the global SKS root');
assertGate(
  helper.includes("args: ['doctor', '--fix', '--yes', '--profile', 'migration', '--machine-only', '--report-file', path.join(globalSksRoot(), 'update', 'postinstall-doctor.json')]"),
  'postinstall global Doctor must use the non-launching migration profile and an authoritative report file'
);
assertGate(scriptContains('postinstall:global-doctor-blackbox', 'postinstall-global-doctor-blackbox.js'), 'package script must expose postinstall global Doctor gate');

emitGate('postinstall:global-doctor-blackbox');
