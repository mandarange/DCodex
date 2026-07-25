import { assertGate, emitGate } from './gate-lib.js';
import { detectCodex0140Capability } from '../core/codex-control/codex-0140-capability.js';
import type { Codex0140FeatureKey } from '../core/codex-control/codex-0140-feature-probes.js';

export async function runCodex0140FeatureGate(gate: string, feature: Codex0140FeatureKey) {
  process.env.SKS_CODEX_0140_FAKE = '1';
  process.env.SKS_CODEX_VERSION_FAKE = 'codex-cli 0.140.0';
  process.env.SKS_CODEX_0140_PROBE = '1';
  const cap = await detectCodex0140Capability({ codexBin: 'codex' });
  assertGate(cap.ok === true && cap.supports_0140 === true, `${gate} requires passing Codex 0.140 capability fixture`, cap);
  const state = cap.feature_states[feature];
  assertGate(cap.features[feature] === true && state?.supported === true, `${gate} requires feature ${feature}`, cap);
  assertGate(state.certainty !== 'assumed_by_version' && state.certainty !== 'unverified' && state.certainty !== 'failed', `${gate} requires probed feature certainty for ${feature}`, state);
  emitGate(gate, { feature, schema: cap.schema, certainty: state.certainty });
}
