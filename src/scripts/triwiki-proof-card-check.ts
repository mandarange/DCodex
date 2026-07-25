// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js';

const mod = await importDist('core/triwiki/triwiki-proof-card.js');
const card = mod.createTriWikiProofCard({
  subject_type: 'gate',
  subject_id: 'triwiki:proof-card',
  cache_key: 'cache-key',
  input_hash: 'input',
  gate_impl_hash: 'impl',
  package_lock_hash: 'pkg',
  release_gates_hash: 'gates',
  env_allowlist_hash: 'env',
  tool_versions: { sks: '4.0.1' },
  tool_version: '4.0.1',
  fixture_version: 'sks-4.0.1',
  result: 'passed',
  reusable: true,
  evidence: { fixture: true }
});
assertGate(card.schema === 'sks.triwiki-proof-card.v1', 'proof card schema mismatch', card);
assertGate(card.proof_id.startsWith('proof-') && mod.isReusableTriWikiProofCard(card), 'proof card must be reusable when passed', card);
emitGate('triwiki:proof-card', { proof_id: card.proof_id });
