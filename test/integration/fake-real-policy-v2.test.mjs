import test from 'node:test';
import assert from 'node:assert/strict';

test('fake-real policy v3 keeps supporting subsystem proof separate from execution authority', async () => {
  const mod = await import('../../dist/core/proof/fake-real-proof-policy.js');
  const report = mod.evaluateFakeRealProofPolicy({ cleanup_proof: { ok: true }, work_graph_quality_score: 0.8 });
  assert.equal(report.schema, 'sks.fake-real-proof-policy.v3');
  assert.equal(report.proof_level, 'integration_optional');
  assert.equal(report.execution_authority.workflow, 'official_codex_subagent');
  assert.equal(report.subsystem_levels.cleanup, 'proven');
  assert.equal(report.subsystem_levels.work_graph, 'proven');
  assert.deepEqual(report.real_claims, []);
  assert.equal(Object.values(report.subsystems).filter((row) => row.evidence_role === 'execution_authority').length, 1);
});
