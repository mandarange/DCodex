import '../../__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MANAGED_ASSET_MARKER,
  RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES,
  managedAgentRoleContent
} from '../../managed-assets/managed-assets-manifest.js';
import { reconcileLegacyManagedGeneration } from '../legacy-generation-convergence.js';
import { reconcileManagedSkillInstallation } from '../managed-skill-install.js';
import { cleanupRemovedSksSkillResidue } from '../skills.js';

test('shared convergence removes only proven retired SKS generations across skills, roles, config, and MCP', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-legacy-generation-convergence-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const nested = path.join(root, 'packages', 'web');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  const codexHome = path.join(home, '.codex');
  try {
    await Promise.all([home, root, nested, globalRuntimeRoot].map((dir) => fsp.mkdir(dir, { recursive: true })));
    await writeManagedSkill(path.join(root, '.agents', 'skills', 'sks-answer'), 'sks-answer');
    await writeManagedSkill(path.join(root, '.codex', 'skills', 'answer'), 'answer');
    await writeManagedSkill(path.join(nested, '.agents', 'skills', 'sks-plan'), 'sks-plan');
    await writeUserSkill(path.join(root, '.agents', 'skills', 'customer-helper'), 'customer-helper');

    const retiredRole = RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES[0]!;
    const retiredRolePath = path.join(root, '.codex', 'agents', retiredRole.filename);
    await fsp.mkdir(path.dirname(retiredRolePath), { recursive: true });
    await fsp.writeFile(retiredRolePath, managedAgentRoleContent(retiredRole));

    const managedConfigPath = path.join(root, '.codex', 'config.toml');
    await fsp.writeFile(managedConfigPath, [
      '# SKS-MANAGED-CODEX-CONFIG',
      'model = "user-selected-current-model"',
      '',
      '[profiles.sks-team]',
      'service_tier = "fast"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'model_reasoning_effort = "medium"',
      '',
      '[mcp_servers.supabase_mad_db]',
      'command = "retired-sks-db-bridge"',
      '',
      '[mcp_servers.customer_docs]',
      'command = "customer-owned-server"',
      ''
    ].join('\n'), { mode: 0o600 });

    const userConfigPath = path.join(nested, '.codex', 'config.toml');
    const userConfig = [
      '[mcp_servers.supabase_mad_db]',
      'command = "customer-owned-same-name-server"',
      '',
      '[mcp_servers.customer_other]',
      'command = "customer-other-server"',
      ''
    ].join('\n');
    await fsp.mkdir(path.dirname(userConfigPath), { recursive: true });
    await fsp.writeFile(userConfigPath, userConfig, { mode: 0o600 });

    const first = await reconcileLegacyManagedGeneration({
      root,
      home,
      codexHome,
      globalRuntimeRoot,
      fix: true
    });

    assert.equal(first.ok, true, JSON.stringify(first));
    await assertMissing(path.join(root, '.agents', 'skills', 'sks-answer'));
    await assertMissing(path.join(root, '.codex', 'skills', 'answer'));
    await assertMissing(path.join(nested, '.agents', 'skills', 'sks-plan'));
    await assertMissing(retiredRolePath);
    assert.equal(await fsp.readFile(path.join(root, '.agents', 'skills', 'customer-helper', 'SKILL.md'), 'utf8'), userSkillText('customer-helper'));

    const managedConfig = await fsp.readFile(managedConfigPath, 'utf8');
    assert.match(managedConfig, /model = "user-selected-current-model"/);
    assert.match(managedConfig, /\[mcp_servers\.customer_docs\]/);
    assert.doesNotMatch(managedConfig, /profiles\.sks-team|supabase_mad_db/);
    assert.equal(await fsp.readFile(userConfigPath, 'utf8'), userConfig);
    assert.equal(first.managed_configs.retired_mcp_block_count, 1);
    assert.equal(first.managed_configs.preserved_user_config_count, 0);

    const second = await reconcileLegacyManagedGeneration({
      root,
      home,
      codexHome,
      globalRuntimeRoot,
      fix: true
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.managed_configs.detected_count, 0);
    assert.equal(second.retired_agent_roles.detected_count, 0);
    assert.equal(second.project_skills.every((report) => !('schema' in report) || report.removed.length === 0), true);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('shared convergence removes user-owned retired-name collisions from the active surface without deleting their content', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-legacy-generation-user-conflict-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  const userSkill = path.join(root, '.agents', 'skills', 'team');
  const original = userSkillText('team');
  try {
    await Promise.all([home, root, globalRuntimeRoot].map((dir) => fsp.mkdir(dir, { recursive: true })));
    await fsp.mkdir(userSkill, { recursive: true });
    await fsp.writeFile(path.join(userSkill, 'SKILL.md'), original);

    const report = await reconcileLegacyManagedGeneration({
      root,
      home,
      globalRuntimeRoot,
      fix: true
    });

    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(report.blockers, []);
    await assertMissing(userSkill);
    const quarantined = await findFiles(path.join(root, '.sneakoscope', 'quarantine', 'skills', 'team'), 'SKILL.md');
    assert.equal(quarantined.length, 1);
    assert.equal(await fsp.readFile(quarantined[0]!, 'utf8'), original);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('shared convergence compacts machine-local moved-config markers to the newest line', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-legacy-generation-markers-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  const codexHome = path.join(home, '.codex');
  const machineConfigPath = path.join(codexHome, 'config.toml');
  try {
    await Promise.all([home, root, globalRuntimeRoot, codexHome].map((dir) => fsp.mkdir(dir, { recursive: true })));
    // The live machine shape: no ownership marker, a real model line, and one
    // appended provenance comment per historical move (the mover strips them
    // from the PROJECT file only, so the destination pile grows unbounded).
    await fsp.writeFile(machineConfigPath, [
      'model = "gpt-5.6-sol"',
      '# SKS moved machine-local Codex config from .codex/config.toml at 2026-07-10T08:47:58.841Z',
      '# SKS moved machine-local Codex config from .codex/config.toml at 2026-07-12T17:21:44.996Z',
      '',
      '# SKS moved machine-local Codex config from .codex/config.toml at 2026-07-24T07:04:58.256Z',
      'service_tier = "fast"',
      ''
    ].join('\n'), { mode: 0o600 });

    const first = await reconcileLegacyManagedGeneration({
      root,
      home,
      codexHome,
      globalRuntimeRoot,
      fix: true
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.managed_configs.compacted_marker_line_count, 2);
    const rewritten = await fsp.readFile(machineConfigPath, 'utf8');
    assert.match(rewritten, /model = "gpt-5\.6-sol"/);
    assert.match(rewritten, /service_tier = "fast"/);
    // Exactly the newest marker survives as the provenance other readers look for.
    assert.deepEqual(
      rewritten.split('\n').filter((line) => /SKS moved machine-local/.test(line)),
      ['# SKS moved machine-local Codex config from .codex/config.toml at 2026-07-24T07:04:58.256Z']
    );

    const second = await reconcileLegacyManagedGeneration({
      root,
      home,
      codexHome,
      globalRuntimeRoot,
      fix: true
    });
    assert.equal(second.managed_configs.compacted_marker_line_count, 0);
    assert.equal(second.managed_configs.detected_count, 0);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('managed skill install result remains JSON serializable after embedding convergence evidence', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-managed-skill-install-json-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  try {
    await Promise.all([home, root].map((dir) => fsp.mkdir(dir, { recursive: true })));

    const { skillInstall } = await reconcileManagedSkillInstallation(root, home);
    const convergence = skillInstall.legacy_generation_convergence;

    assert.ok(convergence);
    assert.notStrictEqual(skillInstall, convergence.global_skills);
    assert.doesNotThrow(() => JSON.stringify(skillInstall));
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('host extra skill dirs lose only SKS-owned retired residue', async () => {
  const fixtureRoot = path.join(process.cwd(), '.sneakoscope', 'cache');
  await fsp.mkdir(fixtureRoot, { recursive: true });
  const fixture = await fsp.mkdtemp(path.join(fixtureRoot, 'sks-host-extra-skill-residue-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  try {
    await Promise.all([home, root, globalRuntimeRoot].map((dir) => fsp.mkdir(dir, { recursive: true })));
    await writeManagedSkill(path.join(home, '.cursor', 'skills', 'sks-loop'), 'sks-loop');
    await writeUserSkill(path.join(home, '.claude', 'skills', 'loop'), 'loop');
    await writeUserSkill(path.join(home, '.cursor', 'skills', 'customer-helper'), 'customer-helper');
    const report = await cleanupRemovedSksSkillResidue({ root, home, globalRuntimeRoot, fix: true });
    assert.equal(report.ok, true, JSON.stringify(report));
    await assertMissing(path.join(home, '.cursor', 'skills', 'sks-loop'));
    assert.equal(await fsp.readFile(path.join(home, '.claude', 'skills', 'loop', 'SKILL.md'), 'utf8'), userSkillText('loop'));
    assert.equal(await fsp.readFile(path.join(home, '.cursor', 'skills', 'customer-helper', 'SKILL.md'), 'utf8'), userSkillText('customer-helper'));
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

async function writeManagedSkill(dir: string, name: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    'description: retired generated fixture',
    '---',
    '',
    `<!-- BEGIN SKS MANAGED SKILL v1 name=${name} -->`,
    ''
  ].join('\n'));
}

async function writeUserSkill(dir: string, name: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), userSkillText(name));
}

function userSkillText(name: string): string {
  return `---\nname: ${name}\ndescription: customer owned\n---\n\n# ${MANAGED_ASSET_MARKER} appears only as documentation, not a skill ownership marker.\n`;
}

async function assertMissing(target: string): Promise<void> {
  await assert.rejects(fsp.access(target), { code: 'ENOENT' });
}

async function findFiles(root: string, name: string): Promise<string[]> {
  const out: string[] = [];
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      visited += 1;
      if (visited > 1_000) throw new Error('fixture_file_scan_limit_exceeded');
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name === name) out.push(target);
    }
  }
  return out.sort();
}
