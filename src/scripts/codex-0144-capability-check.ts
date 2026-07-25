#!/usr/bin/env node
import { assertGate, emitGate } from './gate-lib.js';
import { CODEX_0144_FEATURE_KEYS, detectCodex0144Capability, writeCodex0144CapabilityArtifacts } from '../core/codex-control/codex-0144-capability.js';

const requireReal = process.argv.includes('--require-real') || process.env.SKS_REQUIRE_CODEX_0144 === '1';
if (!requireReal) process.env.SKS_CODEX_0144_FAKE = '1';
const cap = await detectCodex0144Capability({ requireReal });
assertGate(cap.ok === true, 'Codex 0.144.5 capability probe must pass', cap);
assertGate(Object.keys(cap.feature_states).length === CODEX_0144_FEATURE_KEYS.length, 'Codex 0.144.5 feature count mismatch', cap);
assertGate(
  Object.values(cap.feature_states).every((state) => String(state.certainty) !== 'assumed_by_version'),
  'Codex 0.144.5 capability must not use assumed_by_version evidence',
  cap
);
if (requireReal) {
  assertGate(cap.probe_mode === 'real-schema', 'Codex 0.144.5 require-real must use generated schema evidence', cap);
  assertGate(cap.release_authorizing === true, 'Codex 0.144.5 require-real must be release-authorizing', cap);
  await writeCodex0144CapabilityArtifacts(process.cwd(), { requireReal: true });
}
emitGate('codex:0144:capability', {
  features: CODEX_0144_FEATURE_KEYS.length,
  probe_mode: cap.probe_mode,
  release_authorizing: cap.release_authorizing
});
