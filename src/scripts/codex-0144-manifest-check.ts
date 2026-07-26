#!/usr/bin/env node
import { assertGate, emitGate, readJson, root } from './gate-lib.js';
import { codexReleaseManifestParity } from '../core/codex-compat/codex-release-manifest.js';
import { detectCodex0144Capability } from '../core/codex-control/codex-0144-capability.js';

const parity = await codexReleaseManifestParity(root);
const shippedCapability = await detectCodex0144Capability({ root });
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const manifest = parity.manifest;
const dep = pkg.dependencies?.['@openai/codex-sdk'];
const lockSdk = lock.packages?.['node_modules/@openai/codex-sdk']?.version;
const lockCli = lock.packages?.['node_modules/@openai/codex']?.version;
const lockRootVersion = lock.packages?.['']?.version || lock.version;
assertGate(parity.ok, 'Codex release manifest TS/JSON parity must hold', parity);
assertGate(dep === manifest.sdkVersion, 'package.json must pin @openai/codex-sdk exactly to manifest sdkVersion', { dep, sdkVersion: manifest.sdkVersion });
assertGate(lockSdk === manifest.sdkVersion, 'package-lock must resolve @openai/codex-sdk to manifest sdkVersion', { lockSdk, sdkVersion: manifest.sdkVersion });
assertGate(lockCli === manifest.requiredCliVersion, 'package-lock must resolve @openai/codex to manifest requiredCliVersion', { lockCli, requiredCliVersion: manifest.requiredCliVersion });
assertGate(pkg.version === lockRootVersion, 'package version must match package-lock root version', { version: pkg.version, lockRootVersion });
assertGate(
  shippedCapability.generated_schema_sha256 === manifest.generatedSchemaSha256,
  'shipped App Server schema digest must match manifest generatedSchemaSha256',
  {
    shippedSchemaSha256: shippedCapability.generated_schema_sha256,
    manifestSchemaSha256: manifest.generatedSchemaSha256,
    probeMode: shippedCapability.probe_mode
  }
);
emitGate('codex:0144:manifest', {
  manifest_sha256: parity.manifest_sha256,
  target_tag: manifest.targetTag,
  sdk_version: manifest.sdkVersion,
  generated_schema_sha256: shippedCapability.generated_schema_sha256
});
