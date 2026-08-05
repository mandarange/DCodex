#!/usr/bin/env node
import { assertGate, emitGate } from './gate-lib.js';
import { CODEX_CURRENT_FEATURE_KEYS, detectCodexCurrentCapability, writeCodexCurrentCapabilityArtifacts } from '../core/codex-control/codex-current-capability.js';

const requireReal = process.argv.includes('--require-real') || process.env.SKS_REQUIRE_CODEX_CURRENT === '1';
if (!requireReal) process.env.SKS_CODEX_CURRENT_FAKE = '1';
const cap = await detectCodexCurrentCapability({ requireReal });
assertGate(cap.ok === true, 'Current Codex 0.146.0 capability probe must pass', cap);
assertGate(Object.keys(cap.feature_states).length === CODEX_CURRENT_FEATURE_KEYS.length, 'Current Codex 0.146.0 feature count mismatch', cap);
assertGate(
  Object.values(cap.feature_states).every((state) => String(state.certainty) !== 'assumed_by_version'),
  'Current Codex 0.146.0 capability must not use assumed_by_version evidence',
  cap
);
if (requireReal) {
  assertGate(cap.probe_mode === 'real-schema', 'Current Codex 0.146.0 require-real must use generated schema evidence', cap);
  assertGate(cap.release_authorizing === true, 'Current Codex 0.146.0 require-real must be release-authorizing', cap);
  await writeCodexCurrentCapabilityArtifacts(process.cwd(), { requireReal: true });
}
emitGate('codex:current:capability', {
  features: CODEX_CURRENT_FEATURE_KEYS.length,
  probe_mode: cap.probe_mode,
  release_authorizing: cap.release_authorizing
});
