import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildEvidenceKeyV2,
  ensureProjectId,
  safeEvidenceKeyProjection,
  selectAffectedReceipts,
  type EvidenceKeyV2Input,
  type EvidenceRouteContextV2
} from '../evidence-key.js';

const CODEX_LB_ROUTE: EvidenceRouteContextV2 = {
  provider_id: 'codex-lb',
  public_model: 'gpt-5.6-sol',
  upstream_model: 'openai/gpt-5.6-sol',
  catalog_generation: 'catalog-generation-1',
  route_policy_generation: 'route-policy-generation-1'
};

async function input(t: test.TestContext): Promise<EvidenceKeyV2Input> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-evidence-key-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const project_id = await ensureProjectId(path.join(root, '.sneakoscope', 'project-id'));
  return {
    project_id,
    criterion: 'architecture.transport',
    check: 'header-leakage',
    direct_target_hashes: ['a'.repeat(64)],
    direct_dependency_hashes: ['b'.repeat(64)],
    provider_route_context: CODEX_LB_ROUTE,
    model_policy_hash: 'c'.repeat(64),
    validator_rule: 'header-policy',
    validator_version: 'v1',
    environment_hash: 'd'.repeat(64),
    toolchain_hash: 'e'.repeat(64)
  };
}

test('project identities are clone-isolated and keys deterministic without paths, accounts, or selector fields', async (t) => {
  const firstInput = await input(t);
  const secondInput = await input(t);
  assert.notEqual(firstInput.project_id, secondInput.project_id);

  const first = buildEvidenceKeyV2(firstInput);
  assert.equal(first.key, buildEvidenceKeyV2(firstInput).key);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.direct_target_hashes));
  assert.ok(Object.isFrozen(first.provider_route_context));

  const projection = safeEvidenceKeyProjection(first);
  assert.doesNotMatch(projection, /\/Users\/|account|secret|api[_-]?key/i);
  assert.doesNotMatch(projection, /auth_mode/);
});

test('dependency Merkle roots are order-independent and key only the direct dependency set', async (t) => {
  const base = await input(t);
  const first = buildEvidenceKeyV2({
    ...base,
    direct_dependency_hashes: ['f'.repeat(64), 'b'.repeat(64), 'f'.repeat(64)]
  });
  const reordered = buildEvidenceKeyV2({
    ...base,
    direct_dependency_hashes: ['b'.repeat(64), 'f'.repeat(64)]
  });
  assert.equal(first.direct_dependency_merkle, reordered.direct_dependency_merkle);
  assert.equal(first.key, reordered.key);
});

test('only directly affected receipts invalidate', async (t) => {
  const base = await input(t);
  const evidence = buildEvidenceKeyV2(base);
  const receipt = { id: 'receipt-1', evidence, direct_dependency_hashes: base.direct_dependency_hashes };

  assert.deepEqual(selectAffectedReceipts([receipt], { target_hashes: ['f'.repeat(64)] }), []);
  assert.deepEqual(selectAffectedReceipts([receipt], { dependency_hashes: ['b'.repeat(64)] }).map((entry) => entry.id), ['receipt-1']);
  assert.deepEqual(selectAffectedReceipts([receipt], { provider_route_context: CODEX_LB_ROUTE }), []);
  assert.deepEqual(selectAffectedReceipts([receipt], {
    provider_route_context: {
      provider_id: 'openrouter',
      public_model: 'gpt-5.6-sol',
      upstream_model: 'openai/gpt-5.6-sol',
      catalog_generation: 'catalog-generation-2',
      route_policy_generation: 'route-policy-generation-2'
    }
  }).map((entry) => entry.id), ['receipt-1']);
  assert.deepEqual(selectAffectedReceipts([receipt], { model_policy_hash: 'f'.repeat(64) }).map((entry) => entry.id), ['receipt-1']);
  assert.deepEqual(selectAffectedReceipts([receipt], { validator_version: 'v2' }).map((entry) => entry.id), ['receipt-1']);
});

test('direct dependency, target, and resolved route changes produce a MISS key', async (t) => {
  const base = await input(t);
  const original = buildEvidenceKeyV2(base);
  assert.notEqual(buildEvidenceKeyV2({ ...base, direct_dependency_hashes: ['f'.repeat(64)] }).key, original.key);
  assert.notEqual(buildEvidenceKeyV2({ ...base, direct_target_hashes: ['f'.repeat(64)] }).key, original.key);
  assert.notEqual(buildEvidenceKeyV2({
    ...base,
    provider_route_context: { ...base.provider_route_context, upstream_model: 'openai/gpt-5.6-terra' }
  }).key, original.key);
});
