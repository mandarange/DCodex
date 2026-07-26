#!/usr/bin/env node
import { assertGate, emitGate } from './gate-lib.js';
import { detectCodex0140Capability } from '../core/codex-control/codex-0140-capability.js';

process.env.SKS_CODEX_0140_FAKE = '1';
process.env.SKS_CODEX_VERSION_FAKE = 'codex-cli 0.140.0';
process.env.SKS_CODEX_0140_PROBE = '1';
clearFailureEnv();
const cap = await detectCodex0140Capability({ codexBin: 'codex' });
assertGate(cap.ok === true && cap.probe_mode === 'feature-probe', 'Codex 0.140 feature probe fixture must pass', cap);
for (const [name, status] of Object.entries(cap.feature_probe_results || {})) {
  assertGate(status === 'passed', `Codex 0.140 feature probe must pass: ${name}`, cap.feature_probe_results);
}
process.env.SKS_CODEX_0140_FAKE_USAGE_VIEWS_FAIL = '1';
const failed = await detectCodex0140Capability({ codexBin: 'codex' });
assertGate(failed.ok === false && failed.blockers.includes('codex_0140_usage_views_probe_failed'), 'failed 0.140 feature probe must block capability', failed);
clearFailureEnv();
emitGate('codex:0140-feature-probes', { probe_count: Object.keys(cap.feature_probe_results || {}).length });

function clearFailureEnv() {
  for (const key of Object.keys(process.env)) {
    if (/^SKS_CODEX_0140_FAKE_.*_FAIL$/.test(key)) delete process.env[key];
  }
}
