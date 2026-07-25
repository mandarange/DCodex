#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText, scriptContains } from './gate-lib.js';

const source = readText('src/core/update-check.ts');

assertGate(source.includes("schema: 'sks.update-now.v2'"), 'update now must expose v2 lifecycle schema');
assertGate(source.includes("stage('preflight'"), 'update now must run the current-install preflight stage');
assertGate(source.includes("stage('global_install'"), 'update now must record guarded npm global install stage');
assertGate(source.includes("stage('version_probe'"), 'update now must probe the newly installed binary');
assertGate(source.includes("stage('new_version_doctor'"), 'update now must run new-version Doctor');
assertGate(source.includes('project_receipt'), 'update now must write project migration receipt');
assertGate(source.includes('operation_receipt_path') && source.includes('UpdateOperationRecorder'), 'update now must persist an operation receipt lifecycle');
assertGate(source.includes('authorizeUpdateRollback'), 'rollback must be authorized from the latest update receipt');
assertGate(scriptContains('update:doctor-lifecycle', 'update-doctor-lifecycle-check.js'), 'package script must expose update doctor lifecycle gate');

emitGate('update:doctor-lifecycle');
