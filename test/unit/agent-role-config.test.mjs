import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

test('installed Codex agent catalog exposes only current official roles', async () => {
  const manifest = await import('../../dist/core/managed-assets/managed-assets-manifest.js');

  assert.equal(manifest.MANAGED_ASSET_VERSION, '7.2.0');
  assert.equal(Object.hasOwn(manifest, 'MANAGED_AGENT_ROLES'), false);

  for (const role of manifest.MANAGED_OFFICIAL_SUBAGENT_ROLES) {
    const text = manifest.managedOfficialSubagentRoleContent(role);
    const parsed = parse(text);
    assert.equal(parsed.name, role.codex_name);
    assert.equal(parsed.model, role.model);
    assert.equal(parsed.model_reasoning_effort, role.model_reasoning_effort);
    assert.equal(Object.hasOwn(parsed, 'model_policy'), false);
    assert.equal(Object.hasOwn(parsed, 'sandbox_mode'), role.sandbox === 'read-only');
    assert.equal(parsed.sandbox_mode, role.sandbox);
    assert.equal(manifest.managedOfficialSubagentRoleOwnsText(text, role), true);
  }
});

test('official custom agent catalog has unique identities and broad specialist coverage without model-policy drift', async () => {
  const manifest = await import('../../dist/core/managed-assets/managed-assets-manifest.js');
  const roles = manifest.MANAGED_OFFICIAL_SUBAGENT_ROLES;
  const expectedSpecialists = new Map([
    ['native_app_specialist', { policy: 'sol_high_implementation', model: 'gpt-5.6-sol', effort: 'high', sandbox: undefined }],
    ['toolchain_specialist', { policy: 'sol_max_judgment', model: 'gpt-5.6-sol', effort: 'max', sandbox: undefined }],
    ['protocol_reviewer', { policy: 'sol_max_judgment', model: 'gpt-5.6-sol', effort: 'max', sandbox: 'read-only' }],
    ['runtime_reliability_reviewer', { policy: 'sol_max_judgment', model: 'gpt-5.6-sol', effort: 'max', sandbox: 'read-only' }],
    ['triwiki_evidence_reviewer', { policy: 'sol_max_judgment', model: 'gpt-5.6-sol', effort: 'max', sandbox: 'read-only' }],
    ['long_context_analyst', { policy: 'terra_medium_context_tools', model: 'gpt-5.6-terra', effort: 'medium', sandbox: 'read-only' }],
    ['computer_use_operator', { policy: 'terra_medium_context_tools', model: 'gpt-5.6-terra', effort: 'medium', sandbox: 'read-only' }],
    ['browser_use_operator', { policy: 'terra_medium_context_tools', model: 'gpt-5.6-terra', effort: 'medium', sandbox: 'read-only' }],
    ['image_generation_operator', { policy: 'terra_medium_context_tools', model: 'gpt-5.6-terra', effort: 'medium', sandbox: undefined }]
  ]);

  assert.equal(roles.length, 25);
  assert.equal(new Set(roles.map((role) => role.id)).size, roles.length);
  assert.equal(new Set(roles.map((role) => role.filename)).size, roles.length);
  assert.equal(new Set(roles.map((role) => role.codex_name)).size, roles.length);
  assert.equal(new Set(roles.map((role) => role.description)).size, roles.length);

  for (const [name, expected] of expectedSpecialists) {
    const role = roles.find((candidate) => candidate.codex_name === name);
    assert.ok(role, `missing ${name}`);
    assert.equal(role.model_policy, expected.policy);
    assert.equal(role.model, expected.model);
    assert.equal(role.sandbox, expected.sandbox);
    assert.equal(role.model_reasoning_effort, expected.effort);
    assert.ok(role.selection_keywords.length >= 5);
  }

  const distribution = Object.fromEntries(['luna_max_mechanical', 'sol_high_implementation', 'sol_max_judgment', 'terra_medium_context_tools']
    .map((policy) => [policy, roles.filter((role) => role.model_policy === policy).length]));
  assert.deepEqual(distribution, {
    luna_max_mechanical: 1,
    sol_high_implementation: 3,
    sol_max_judgment: 15,
    terra_medium_context_tools: 6
  });
});

test('fresh agent role repair requires the complete official custom agent catalog', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-agent-role-official-default-'));
  const codexHome = path.join(root, 'codex-home');
  const roles = await import('../../dist/core/agents/agent-role-config.js');
  const manifest = await import('../../dist/core/managed-assets/managed-assets-manifest.js');
  const expected = manifest.MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => role.filename).sort();

  const plan = await roles.repairAgentRoleConfigs({ root, codexHome, apply: false });
  assert.deepEqual(plan.missing.sort(), expected);
  assert.equal(plan.missing.includes('analysis-scout.toml'), false);

  const repair = await roles.repairAgentRoleConfigs({ root, codexHome, apply: true });
  assert.equal(repair.ok, true);
  const files = (await fs.readdir(path.join(root, '.codex', 'agents'))).sort();
  assert.deepEqual(files, expected);
});

test('agent role repair removes SKS-owned retired roles and quarantines user collisions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-agent-role-exact-repair-'));
  const home = path.join(root, 'home');
  const codexHome = path.join(home, '.codex');
  const manifest = await import('../../dist/core/managed-assets/managed-assets-manifest.js');
  const managedRole = manifest.RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES[0];
  const userRole = manifest.RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES[1];
  const managedFile = path.join(root, '.codex', 'agents', managedRole.filename);
  const userFile = path.join(codexHome, 'agents', userRole.filename);
  await fs.mkdir(path.dirname(managedFile), { recursive: true });
  await fs.mkdir(path.dirname(userFile), { recursive: true });
  await fs.writeFile(managedFile, manifest.managedAgentRoleContent(managedRole), 'utf8');
  await fs.writeFile(userFile, 'name = "customer_role"\ndescription = "keep me"\n', 'utf8');

  const roles = await import('../../dist/core/agents/agent-role-config.js');
  const plan = await roles.repairAgentRoleConfigs({ root, codexHome, apply: false });
  assert.equal(plan.retired_role_cleanup.detected_count, 2);
  assert.equal(plan.retired_role_cleanup.remaining_count, 2);

  const repair = await roles.repairAgentRoleConfigs({ root, codexHome, apply: true });
  assert.equal(repair.ok, true);
  assert.equal(repair.retired_role_cleanup.removed_count, 1);
  assert.equal(repair.retired_role_cleanup.quarantined_user_collision_count, 1);
  assert.equal(repair.retired_role_cleanup.remaining_count, 0);
  await assert.rejects(fs.access(managedFile));
  await assert.rejects(fs.access(userFile));
  const quarantined = await findFile(home, userRole.filename);
  assert.ok(quarantined?.includes(path.join('.sneakoscope', 'quarantine', 'retired-agent-roles')));
  assert.match(await fs.readFile(quarantined, 'utf8'), /keep me/);
  assert.equal(Object.hasOwn(repair, 'legacy_compatibility_role_ids'), false);
});

async function findFile(root, name) {
  const rows = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const row of rows) {
    const file = path.join(root, row.name);
    if (row.isDirectory()) {
      const nested = await findFile(file, name);
      if (nested) return nested;
    } else if (row.name === name) return file;
  }
  return null;
}
