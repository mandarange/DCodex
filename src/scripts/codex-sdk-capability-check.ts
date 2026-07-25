#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js';

const mod = await importDist('core/codex-control/codex-sdk-capability.js');
const capability = await mod.detectCodexSdkCapability();
assertGate(capability.ok, 'Codex SDK capability must be available', capability);
assertGate(capability.package_name === '@openai/codex-sdk', 'Codex SDK package name mismatch', capability);
assertGate(capability.dynamic_import_ok === true, 'Codex SDK dynamic import failed', capability);
assertGate(String(capability.package_version || '').length > 0, 'Codex SDK package version missing', capability);
emitGate('codex-sdk:capability', { package_version: capability.package_version, node_version: capability.node_version });
