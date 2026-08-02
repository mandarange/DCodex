import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const OBSERVED_RETIRED_POLICY = 'In MAD-SKS launches, allow only the scoped non-MadDB high-risk surfaces approved for the active invocation and keep catastrophic DB wipe/all-row safeguards active. In first-class MAD-DB cycles, the explicit $MAD-DB or sks mad-db run|exec|apply-migration invocation is the SQL-plane approval boundary: execute requested execute_sql/apply_migration mutations with mission-local write transport, read-back proof, and final read-only restoration. Supabase project/account/billing/credential control-plane actions remain denied.';

test('project update migration receipt cleans disposable closed-mission runtime sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-retention-unit-'));
  const home = path.join(root, 'home');
  const globalRoot = path.join(home, '.sneakoscope-global');
  const previousHome = process.env.HOME;
  const previousGlobalRoot = process.env.SKS_GLOBAL_ROOT;
  process.env.HOME = home;
  process.env.SKS_GLOBAL_ROOT = globalRoot;
  try {
    const { writeProjectUpdateMigrationReceipt } = await import('../../dist/core/update/update-migration-state.js');
    const mission = path.join(root, '.sneakoscope', 'missions', 'M-done');
    await writeJson(path.join(mission, 'completion-proof.json'), { status: 'verified', blockers: [] });
    await writeJson(path.join(mission, 'agents', 'agent-proof-evidence.json'), { ok: true });
    await writeText(path.join(mission, 'agents', 'sessions', 'slot-001', 'gen-1', 'worker', 'codex-sdk-home', 'codex', 'cache.bin'), 'large sdk cache');
    const terminal = path.join(root, '.sneakoscope', 'missions', 'M-blocked-terminal');
    await writeJson(path.join(terminal, 'completion-proof.json'), { status: 'blocked', blockers: ['fixture_blocker'] });
    await writeJson(path.join(terminal, 'agents', 'agent-session-cleanup.json'), { all_sessions_terminal: true, terminal_session_count: 1, total_sessions: 1 });
    await writeText(path.join(terminal, 'agents', 'sessions', 'slot-001', 'gen-1', 'worker', 'worker-result.json'), '{"status":"blocked"}\n');
    await writeText(path.join(terminal, 'agents', 'sessions', 'slot-001', 'gen-1', 'worker', 'codex-sdk-home', 'codex', 'cache.bin'), 'terminal sdk cache');

    const receipt = await writeProjectUpdateMigrationReceipt({
      root,
      source: 'unit-update-retention',
      blockers: [],
      warnings: []
    });

    assert.equal(receipt.retention_cleanup?.status, 'completed');
    assert.ok((receipt.retention_cleanup?.action_count || 0) > 0);
    await assertExists(path.join(mission, 'completion-proof.json'));
    await assertExists(path.join(mission, 'agents', 'agent-proof-evidence.json'));
    await assertMissing(path.join(mission, 'agents', 'sessions', 'slot-001', 'gen-1', 'worker', 'codex-sdk-home', 'codex', 'cache.bin'));
    await assertExists(path.join(terminal, 'agents', 'sessions', 'slot-001', 'gen-1', 'worker', 'worker-result.json'));
    await assertMissing(path.join(terminal, 'agents', 'sessions', 'slot-001', 'gen-1', 'worker', 'codex-sdk-home', 'codex', 'cache.bin'));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousGlobalRoot === undefined) delete process.env.SKS_GLOBAL_ROOT;
    else process.env.SKS_GLOBAL_ROOT = previousGlobalRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('project update migration repairs legacy menubar and fast-mode config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-legacy-repair-unit-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const previousHome = process.env.HOME;
  const previousGlobalRoot = process.env.SKS_GLOBAL_ROOT;
  process.env.HOME = home;
  process.env.SKS_GLOBAL_ROOT = path.join(home, '.sneakoscope-global');
  try {
    const { writeProjectUpdateMigrationReceipt } = await import('../../dist/core/update/update-migration-state.js');
    const { packageRoot } = await import('../../dist/core/fsx.js');
    const actionScript = path.join(home, '.codex', 'sks-menubar', 'sks-menubar-action.sh');
    const configPath = path.join(home, '.codex', 'config.toml');
    await writeText(actionScript, [
      '#!/usr/bin/env sh',
      'SKS_ENTRY="/old/sneakoscope/dist/bin/sks.js"',
      'exec "$SKS_ENTRY" "$@"',
      ''
    ].join('\n'));
    await fs.chmod(actionScript, 0o644);
    await writeText(configPath, [
      'model = "future-codex-model"',
      'model_reasoning_effort = "high"',
      '',
      '[user.fast_mode]',
      'visible = true',
      'default_profile = "sks-fast-high"',
      '',
      '[profiles.sks-fast-high]',
      'model = "gpt-5.4"',
      'service_tier = "default"',
      ''
    ].join('\n'));
    await fs.mkdir(path.join(project, '.sneakoscope'), { recursive: true });
    await fs.mkdir(path.join(project, '.codex'), { recursive: true });

    const receipt = await writeProjectUpdateMigrationReceipt({
      root: project,
      source: 'unit-legacy-repair',
      fromVersion: '5.6.1',
      blockers: [],
      warnings: []
    });

    const stages = new Map((receipt.migration_stages || []).map((stage) => [stage.id, stage]));
    assert.equal(stages.get('menubar-retarget')?.ok, true);
    assert.equal(stages.get('config-fastmode-normalize')?.ok, true);
    assert.equal(Object.hasOwn(receipt, 'legacy_migration_stages'), false);
    for (const stage of receipt.migration_stages || []) {
      assert.deepEqual(Object.keys(stage).sort(), ['action_count', 'blocker_count', 'id', 'ok', 'status', 'warning_count']);
    }

    const expectedEntry = path.join(packageRoot(), 'dist', 'bin', 'sks.js');
    const scriptAfter = await fs.readFile(actionScript, 'utf8');
    const statAfter = await fs.stat(actionScript);
    assert.match(scriptAfter, new RegExp(`^SKS_ENTRY='${escapeRegExp(expectedEntry)}'$`, 'm'));
    assert.notEqual(statAfter.mode & 0o111, 0);

    const configAfter = await fs.readFile(configPath, 'utf8');
    assert.match(configAfter, /^model = "future-codex-model"$/m);
    assert.match(configAfter, /^model_reasoning_effort = "high"$/m);
    assert.match(configAfter, /^service_tier = "fast"$/m);
    assert.doesNotMatch(configAfter, /^default_profile\s*=/m);
    assert.doesNotMatch(configAfter, /\[user\.fast_mode\]/);
    assert.doesNotMatch(configAfter, /\[profiles\.sks-fast-high\]/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousGlobalRoot === undefined) delete process.env.SKS_GLOBAL_ROOT;
    else process.env.SKS_GLOBAL_ROOT = previousGlobalRoot;
  }
});

test('project update migration preserves stamped menubar generation for transactional rebuild', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-stamped-menubar-unit-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const previousHome = process.env.HOME;
  const previousGlobalRoot = process.env.SKS_GLOBAL_ROOT;
  process.env.HOME = home;
  process.env.SKS_GLOBAL_ROOT = path.join(home, '.sneakoscope-global');
  try {
    const { writeProjectUpdateMigrationReceipt } = await import('../../dist/core/update/update-migration-state.js');
    const installDir = path.join(home, '.codex', 'sks-menubar');
    const actionScript = path.join(installDir, 'sks-menubar-action.sh');
    const original = [
      '#!/usr/bin/env sh',
      'SKS_ENTRY="/old/sneakoscope/dist/bin/sks.js"',
      'exec "$SKS_ENTRY" "$@"',
      ''
    ].join('\n');
    await writeText(actionScript, original);
    await fs.chmod(actionScript, 0o755);
    await writeJson(path.join(installDir, 'build-stamp.json'), {
      schema: 'sks.sks-menubar-build-stamp.v2',
      package_version: '7.0.2'
    });
    await fs.mkdir(path.join(project, '.sneakoscope'), { recursive: true });

    const receipt = await writeProjectUpdateMigrationReceipt({
      root: project,
      source: 'unit-stamped-menubar-repair',
      fromVersion: '7.0.2',
      blockers: [],
      warnings: []
    });

    const stage = (receipt.migration_stages || []).find((row) => row.id === 'menubar-retarget');
    assert.equal(stage?.ok, true);
    assert.ok((stage?.action_count || 0) > 0);
    assert.equal(await fs.readFile(actionScript, 'utf8'), original);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousGlobalRoot === undefined) delete process.env.SKS_GLOBAL_ROOT;
    else process.env.SKS_GLOBAL_ROOT = previousGlobalRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('project update migration removes obsolete runtime and managed skill residue idempotently', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-obsolete-residue-'));
  const home = path.join(fixture, 'home');
  const project = path.join(fixture, 'project');
  const globalRuntimeRoot = path.join(home, '.sneakoscope-global');
  const previousHome = process.env.HOME;
  const previousGlobalRoot = process.env.SKS_GLOBAL_ROOT;
  process.env.HOME = home;
  process.env.SKS_GLOBAL_ROOT = globalRuntimeRoot;
  try {
    const { writeProjectUpdateMigrationReceipt } = await import('../../dist/core/update/update-migration-state.js');
    await writeText(path.join(project, '.sneakoscope', 'team', 'runtime.json'), '{"legacy":true}\n');
    await writeJson(path.join(project, '.sneakoscope', 'team-dashboard-state.json'), { schema: 'sks.team-dashboard-state.v1' });
    await writeJson(path.join(project, '.sneakoscope', 'work-order-ledger.json'), { schema_version: 1, route: 'team', items: [] });
    await writeJson(path.join(project, '.sneakoscope', 'update', 'legacy-team-artifacts.json'), { schema: 'sks.legacy-team-artifacts-migration.v1' });
    await writeText(path.join(project, '.sneakoscope', 'customer-state.json'), '{"keep":true}\n');
    await writeJson(path.join(home, '.sneakoscope', 'team-dashboard-state.json'), { schema: 'sks.team-dashboard-state.v1' });
    await writeJson(path.join(globalRuntimeRoot, '.sneakoscope', 'work-order-ledger.json'), { schema: 'sks.work-order-ledger.v1', route: 'team' });
    await writeManagedSkill(path.join(home, '.agents', 'skills', 'team'), 'team');
    await writeManagedSkill(path.join(home, '.codex', 'skills', 'tmux'), 'tmux');
    await writeManagedSkill(path.join(project, '.agents', 'skills', 'mad-db'), 'mad-db');
    await writeManagedSkill(path.join(project, '.agents', 'skills', 'xai'), 'xai');
    await writeManagedSkill(path.join(project, '.codex', 'skills', 'shadow-clone'), 'shadow-clone');
    await writeText(path.join(project, '.agents', 'skills', 'customer-skill', 'SKILL.md'), '---\nname: customer-skill\n---\n\nkeep customer skill\n');

    const first = await writeProjectUpdateMigrationReceipt({
      root: project,
      source: 'unit-obsolete-residue-cleanup',
      fromVersion: '6.2.0',
      blockers: [],
      warnings: []
    });
    const firstStages = new Map((first.migration_stages || []).map((stage) => [stage.id, stage]));
    const cleanup = firstStages.get('current-public-surface-reconcile');
    assert.equal(cleanup?.ok, true);
    assert.ok((cleanup?.action_count || 0) > 0);
    assert.equal(Object.hasOwn(first, 'legacy_migration_stages'), false);
    assert.doesNotMatch(JSON.stringify(first), /(?:team|mad-db|tmux|xai|swarm|shadow-clone|kage-bunshin|ralph)/i);
    for (const target of [
      path.join(project, '.sneakoscope', 'team'),
      path.join(project, '.sneakoscope', 'team-dashboard-state.json'),
      path.join(project, '.sneakoscope', 'work-order-ledger.json'),
      path.join(project, '.sneakoscope', 'update', 'legacy-team-artifacts.json'),
      path.join(home, '.sneakoscope', 'team-dashboard-state.json'),
      path.join(globalRuntimeRoot, '.sneakoscope', 'work-order-ledger.json'),
      path.join(home, '.agents', 'skills', 'team'),
      path.join(home, '.codex', 'skills', 'tmux'),
      path.join(project, '.agents', 'skills', 'mad-db'),
      path.join(project, '.agents', 'skills', 'xai'),
      path.join(project, '.codex', 'skills', 'shadow-clone')
    ]) await assertMissing(target);
    await assertExists(path.join(project, '.sneakoscope', 'customer-state.json'));
    await assertExists(path.join(project, '.agents', 'skills', 'customer-skill', 'SKILL.md'));

    const second = await writeProjectUpdateMigrationReceipt({
      root: project,
      source: 'unit-obsolete-residue-cleanup-repeat',
      fromVersion: '6.2.0',
      blockers: [],
      warnings: []
    });
    const secondCleanup = (second.migration_stages || []).find((stage) => stage.id === 'current-public-surface-reconcile');
    assert.equal(secondCleanup?.ok, true);
    assert.equal(Object.hasOwn(second, 'legacy_migration_stages'), false);
    assert.doesNotMatch(JSON.stringify(second), /(?:team|mad-db|tmux|xai|swarm|shadow-clone|kage-bunshin|ralph)/i);
    await assertMissing(path.join(project, '.sneakoscope', 'update', 'legacy-team-artifacts.json'));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousGlobalRoot === undefined) delete process.env.SKS_GLOBAL_ROOT;
    else process.env.SKS_GLOBAL_ROOT = previousGlobalRoot;
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('project update migration reconciles HOME and global-runtime guidance and retired config profiles', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-global-guidance-'));
  const home = path.join(fixture, 'home');
  const project = path.join(fixture, 'project');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  const previousHome = process.env.HOME;
  const previousGlobalRoot = process.env.SKS_GLOBAL_ROOT;
  process.env.HOME = home;
  process.env.SKS_GLOBAL_ROOT = globalRuntimeRoot;
  try {
    const { writeProjectUpdateMigrationReceipt } = await import('../../dist/core/update/update-migration-state.js');
    for (const root of [project, home, globalRuntimeRoot]) {
      await writeText(path.join(root, 'AGENTS.md'), [
        '<!-- BEGIN Sneakoscope Codex GX MANAGED BLOCK -->',
        '# Retired execution guidance',
        '- Use `$Team` and `sks mad-db`.',
        '<!-- END Sneakoscope Codex GX MANAGED BLOCK -->',
        ''
      ].join('\n'));
      await writeText(path.join(root, '.codex', 'SNEAKOSCOPE.md'), [
        '# ㅅㅋㅅ',
        `Install scope: \`${root === project ? 'project' : 'global'}\``,
        'Command: `sks <command>`',
        'Files: AGENTS.md, .codex/hooks.json, .codex/config.toml, .codex/SNEAKOSCOPE.md, .agents/skills, .codex/agents, .sneakoscope/missions.',
        'Use `$Team` and `sks mad-db`.',
        ''
      ].join('\n'));
    }
    const nestedManaged = path.join(project, 'packages', 'web', 'AGENTS.md');
    const nestedUser = path.join(project, 'services', 'api', 'AGENTS.md');
    const nestedUserBytes = Buffer.from('# Customer API instructions\nUse `sks agent run` for this service.\n');
    const skippedNested = path.join(project, 'node_modules', 'dependency', 'AGENTS.md');
    const homeNested = path.join(home, 'nested', 'AGENTS.md');
    const globalNested = path.join(globalRuntimeRoot, 'nested', 'AGENTS.md');
    const legacyNestedBytes = Buffer.from([
      '<!-- BEGIN Sneakoscope Codex GX MANAGED BLOCK -->',
      '# Retired nested execution guidance',
      '- Use `$Team` and `sks mad-db`.',
      '<!-- END Sneakoscope Codex GX MANAGED BLOCK -->',
      ''
    ].join('\n'));
    await writeText(nestedManaged, legacyNestedBytes.toString('utf8'));
    await fs.mkdir(path.dirname(nestedUser), { recursive: true });
    await fs.writeFile(nestedUser, nestedUserBytes);
    for (const file of [skippedNested, homeNested, globalNested]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, legacyNestedBytes);
    }
    await writeText(path.join(home, '.codex', 'config.toml'), [
      'model = "future-model"',
      '',
      '[profiles.sks-team]',
      'service_tier = "fast"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'model_reasoning_effort = "medium"',
      '',
      '[auto_review]',
      `policy = "${OBSERVED_RETIRED_POLICY}"`,
      ''
    ].join('\n'));
    await writeText(path.join(globalRuntimeRoot, '.codex', 'config.toml'), [
      '[auto_review]',
      `policy = "${OBSERVED_RETIRED_POLICY}"`,
      ''
    ].join('\n'));
    await writeText(path.join(home, '.codex', 'sks-team.config.toml'), [
      'service_tier = "fast"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'model_reasoning_effort = "medium"',
      ''
    ].join('\n'));

    const receipt = await writeProjectUpdateMigrationReceipt({
      root: project,
      source: 'unit-global-guidance-cleanup',
      fromVersion: '6.2.0',
      blockers: [],
      warnings: []
    });
    const cleanup = (receipt.migration_stages || []).find((stage) => stage.id === 'current-public-surface-reconcile');
    assert.equal(cleanup?.ok, true);
    for (const root of [project, home, globalRuntimeRoot]) {
      const text = `${await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')}\n${await fs.readFile(path.join(root, '.codex', 'SNEAKOSCOPE.md'), 'utf8')}`;
      assert.match(text, /\$sks-naruto/);
      assert.doesNotMatch(text, /\$Team|sks team|\$MAD-DB|sks mad-db/i);
    }
    const homeConfig = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8');
    assert.match(homeConfig, /\$MAD-SKS/);
    assert.doesNotMatch(homeConfig, /profiles\.sks-team|\$MAD-DB|sks mad-db/i);
    const globalConfig = await fs.readFile(path.join(globalRuntimeRoot, '.codex', 'config.toml'), 'utf8');
    assert.match(globalConfig, /\$MAD-SKS/);
    assert.doesNotMatch(globalConfig, /\$MAD-DB|sks mad-db/i);
    await assertMissing(path.join(home, '.codex', 'sks-team.config.toml'));

    for (const file of [nestedManaged, nestedUser]) {
      const text = await fs.readFile(file, 'utf8');
      assert.match(text, /BEGIN Sneakoscope Codex GX MANAGED BLOCK/);
      assert.doesNotMatch(text, /\$Team|\$Agent|sks team|sks agent|sks mad-db/i);
    }
    assert.deepEqual(await fs.readFile(skippedNested), legacyNestedBytes);
    assert.deepEqual(await fs.readFile(homeNested), legacyNestedBytes);
    assert.deepEqual(await fs.readFile(globalNested), legacyNestedBytes);
    const quarantineRoot = path.join(project, '.sneakoscope', 'quarantine');
    const quarantinedAfterFirst = await findFiles(quarantineRoot, 'AGENTS.md');
    assert.equal(quarantinedAfterFirst.length, 1);
    assert.deepEqual(await fs.readFile(quarantinedAfterFirst[0]), nestedUserBytes);

    const secondReceipt = await writeProjectUpdateMigrationReceipt({
      root: project,
      source: 'unit-global-guidance-cleanup-repeat',
      fromVersion: '6.2.0',
      blockers: [],
      warnings: []
    });
    const secondCleanup = (secondReceipt.migration_stages || []).find((stage) => stage.id === 'current-public-surface-reconcile');
    assert.equal(secondCleanup?.ok, true);
    assert.equal((await findFiles(quarantineRoot, 'AGENTS.md')).length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousGlobalRoot === undefined) delete process.env.SKS_GLOBAL_ROOT;
    else process.env.SKS_GLOBAL_ROOT = previousGlobalRoot;
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('project update migration quarantines the recognized legacy current state after verified split', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-legacy-current-state-'));
  const home = path.join(fixture, 'home');
  const project = path.join(fixture, 'project');
  const previousHome = process.env.HOME;
  const previousGlobalRoot = process.env.SKS_GLOBAL_ROOT;
  process.env.HOME = home;
  process.env.SKS_GLOBAL_ROOT = path.join(home, '.sneakoscope-global');
  try {
    const { writeProjectUpdateMigrationReceipt } = await import('../../dist/core/update/update-migration-state.js');
    const { sessionStateKey } = await import('../../dist/core/mission.js');
    const legacyPath = path.join(project, '.sneakoscope', 'current.json');
    const legacyState = {
      mission_id: 'M-legacy-state',
      mode: 'Naruto',
      phase: 'EXECUTE',
      _session_key: 'legacy-thread-id'
    };
    await writeJson(legacyPath, legacyState);

    const receipt = await writeProjectUpdateMigrationReceipt({
      root: project,
      source: 'unit-legacy-current-state-split',
      fromVersion: '7.9.0',
      blockers: [],
      warnings: []
    });

    const stage = (receipt.migration_stages || []).find((row) => row.id === 'session-state-split');
    assert.equal(stage?.ok, true);
    await assertMissing(legacyPath);
    assert.deepEqual(
      await readJson(path.join(project, '.sneakoscope', 'state', 'current.json')),
      legacyState
    );
    const session = await readJson(path.join(
      project,
      '.sneakoscope',
      'state',
      'sessions',
      `${sessionStateKey(legacyState._session_key)}.json`
    ));
    assert.equal(session.mission_id, legacyState.mission_id);
    assert.equal(session._session_key, sessionStateKey(legacyState._session_key));
    const quarantined = await findFilesByPrefix(
      path.join(project, '.sneakoscope', 'quarantine', 'update-legacy-state'),
      'current-'
    );
    assert.equal(quarantined.length, 1);
    assert.deepEqual(await readJson(quarantined[0]), legacyState);

    const second = await writeProjectUpdateMigrationReceipt({
      root: project,
      source: 'unit-legacy-current-state-split-repeat',
      fromVersion: '7.9.0',
      blockers: [],
      warnings: []
    });
    const secondStage = (second.migration_stages || []).find((row) => row.id === 'session-state-split');
    assert.equal(secondStage?.ok, true);
    assert.equal((await findFilesByPrefix(
      path.join(project, '.sneakoscope', 'quarantine', 'update-legacy-state'),
      'current-'
    )).length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousGlobalRoot === undefined) delete process.env.SKS_GLOBAL_ROOT;
    else process.env.SKS_GLOBAL_ROOT = previousGlobalRoot;
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('project update migration fails closed on unsafe or unowned legacy current state', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-update-unsafe-legacy-current-'));
  const home = path.join(fixture, 'home');
  const previousHome = process.env.HOME;
  const previousGlobalRoot = process.env.SKS_GLOBAL_ROOT;
  process.env.HOME = home;
  process.env.SKS_GLOBAL_ROOT = path.join(home, '.sneakoscope-global');
  try {
    const { writeProjectUpdateMigrationReceipt } = await import('../../dist/core/update/update-migration-state.js');
    const outside = path.join(fixture, 'outside-current.json');
    await writeJson(outside, { mission_id: 'M-outside', phase: 'EXECUTE' });

    const symlinkProject = path.join(fixture, 'symlink-project');
    const symlinkLegacy = path.join(symlinkProject, '.sneakoscope', 'current.json');
    await fs.mkdir(path.dirname(symlinkLegacy), { recursive: true });
    await fs.symlink(outside, symlinkLegacy);
    const symlinkReceipt = await writeProjectUpdateMigrationReceipt({
      root: symlinkProject,
      source: 'unit-legacy-current-symlink',
      blockers: [],
      warnings: []
    });
    const symlinkStage = (symlinkReceipt.migration_stages || []).find((row) => row.id === 'session-state-split');
    assert.equal(symlinkStage?.ok, false);
    assert.equal(symlinkReceipt.status, 'blocked');
    assert.deepEqual(await readJson(outside), { mission_id: 'M-outside', phase: 'EXECUTE' });
    assert.equal((await fs.lstat(symlinkLegacy)).isSymbolicLink(), true);
    await assertMissing(path.join(symlinkProject, '.sneakoscope', 'state', 'current.json'));

    const userProject = path.join(fixture, 'user-project');
    const userLegacy = path.join(userProject, '.sneakoscope', 'current.json');
    const userBytes = Buffer.from('{"customer_setting":"preserve exactly"}\n');
    await fs.mkdir(path.dirname(userLegacy), { recursive: true });
    await fs.writeFile(userLegacy, userBytes);
    const userReceipt = await writeProjectUpdateMigrationReceipt({
      root: userProject,
      source: 'unit-legacy-current-user-file',
      blockers: [],
      warnings: []
    });
    const userStage = (userReceipt.migration_stages || []).find((row) => row.id === 'session-state-split');
    assert.equal(userStage?.ok, false);
    assert.equal(userReceipt.status, 'blocked');
    assert.deepEqual(await fs.readFile(userLegacy), userBytes);
    await assertMissing(path.join(userProject, '.sneakoscope', 'state', 'current.json'));
    assert.equal((await findFilesByPrefix(
      path.join(userProject, '.sneakoscope', 'quarantine', 'update-legacy-state'),
      'current-'
    )).length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousGlobalRoot === undefined) delete process.env.SKS_GLOBAL_ROOT;
    else process.env.SKS_GLOBAL_ROOT = previousGlobalRoot;
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

async function writeJson(file, data) {
  await writeText(file, `${JSON.stringify(data, null, 2)}\n`);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

async function writeManagedSkill(dir, name) {
  await writeText(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Sneakoscope generated legacy skill\n---\n\n<!-- BEGIN SKS MANAGED SKILL v6.2.0 name=${name} -->\n`);
}

async function assertExists(file) {
  await assert.doesNotReject(fs.access(file), `${file} should exist`);
}

async function assertMissing(file) {
  await assert.rejects(fs.access(file), `${file} should be removed`);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findFiles(root, fileName) {
  const rows = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const row of rows) {
    const target = path.join(root, row.name);
    if (row.isDirectory()) files.push(...await findFiles(target, fileName));
    else if (row.name === fileName) files.push(target);
  }
  return files;
}

async function findFilesByPrefix(root, prefix) {
  const rows = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const row of rows) {
    const target = path.join(root, row.name);
    if (row.isDirectory()) files.push(...await findFilesByPrefix(target, prefix));
    else if (row.name.startsWith(prefix)) files.push(target);
  }
  return files;
}
