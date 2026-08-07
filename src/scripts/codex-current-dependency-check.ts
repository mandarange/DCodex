#!/usr/bin/env node
import { assertGate, emitGate, readJson } from './gate-lib.js';
import {
  CURRENT_CODEX_RUNTIME_CONTRACT,
  codexSdkDependencyVersion
} from '../core/codex-compat/codex-runtime-contract.js';

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const expected = codexSdkDependencyVersion();
const lockSdk = lock.packages?.['node_modules/@openai/codex-sdk']?.version;
const lockCli = lock.packages?.['node_modules/@openai/codex']?.version;
const lockRootVersion = lock.packages?.['']?.version || lock.version;
const packageFiles = Array.isArray(pkg.files) ? pkg.files.map(String) : [];

assertGate(pkg.dependencies?.['@openai/codex-sdk'] === expected, 'package.json must pin @openai/codex-sdk to one exact semver', { expected });
assertGate(lockSdk === expected, 'package-lock must resolve @openai/codex-sdk to the package.json pin', { expected, lockSdk });
assertGate(lockCli === expected, 'package-lock must resolve @openai/codex to the SDK dependency version', { expected, lockCli });
assertGate(pkg.version === lockRootVersion, 'package version must match package-lock root version', { version: pkg.version, lockRootVersion });
assertGate(
  !packageFiles.some((entry: string) => entry.startsWith('config/codex-releases/')),
  'package must not ship a second version-specific Codex release manifest',
  { packageFiles }
);
assertGate(
  !packageFiles.some((entry: string) => entry.startsWith('schemas/codex/app-server-')),
  'package must generate the current App Server schema from the resolved runtime instead of shipping a versioned snapshot',
  { packageFiles }
);

emitGate('codex:current:dependency-graph', {
  dependency_source: CURRENT_CODEX_RUNTIME_CONTRACT.dependencySource,
  sdk_version: expected,
  target_tag: CURRENT_CODEX_RUNTIME_CONTRACT.targetTag
});
