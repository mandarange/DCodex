#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText, scriptContains } from './gate-lib.js';

const source = readText('src/core/update-check.ts');
const helper = readText('src/core/update/update-migration-state.ts');

assertGate(source.includes('resolveInstalledSksEntrypoint'), 'update now must resolve the installed package-local sks entrypoint');
assertGate(source.includes("stage('version_probe'"), 'update now must probe the new binary version');
assertGate(source.includes('entrypoint: newBinary'), 'new-version Doctor must run through the resolved new binary');
assertGate(helper.includes("path.join(input.globalRoot, packageName, 'dist', 'bin', 'sks.js')"), 'resolver must prefer global package-local dist/bin/sks.js');
assertGate(scriptContains('update:new-binary-reexec', 'update-new-binary-reexec-check.js'), 'package script must expose new binary reexec gate');

emitGate('update:new-binary-reexec');
