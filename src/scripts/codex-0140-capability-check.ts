#!/usr/bin/env node
import { assertGate, emitGate } from './gate-lib.js';
import { detectCodex0140Capability } from '../core/codex-control/codex-0140-capability.js';

process.env.SKS_CODEX_0140_FAKE = '1';
process.env.SKS_CODEX_VERSION_FAKE = 'codex-cli 0.140.0';
delete process.env.SKS_CODEX_0140_PROBE;
const cap = await detectCodex0140Capability({ codexBin: 'codex' });
assertGate(cap.ok === true && cap.supports_0140 === true, 'Codex 0.140 capability fixture must pass', cap);
assertGate(Object.values(cap.feature_states).every((state) => state.supported === true && state.certainty === 'assumed_by_version'), 'version-only mode must mark 0.140 features as assumed, not probed', cap);
assertGate(cap.warnings.some((warning) => warning.endsWith('_assumed_by_version')), 'version-only mode must warn about assumed feature support', cap);
process.env.SKS_CODEX_VERSION_FAKE = 'codex-cli 0.139.0';
const old = await detectCodex0140Capability({ codexBin: 'codex' });
assertGate(old.ok === false && old.blockers.includes('codex_0_140_required_for_0140_features'), 'Codex 0.139 must not satisfy 0.140 capability', old);
emitGate('codex:0140-capability', { features: Object.keys(cap.features).length });
