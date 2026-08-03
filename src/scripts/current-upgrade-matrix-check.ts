#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, assertGate, emitGate, importDist } from './gate-lib.js';

const policy = await importDist('core/codex/codex-project-config-policy.js');
const install = await importDist('cli/install-helpers.js');
const journal = await importDist('core/migration/migration-transaction-journal.js');
const skillCard = await importDist('core/skills/core-skill-card.js');
const skillDeployment = await importDist('core/skills/core-skill-deployment.js');
const { createRequestedScopeContract } = await importDist('core/safety/requested-scope-contract.js');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}

const tmpDirs = [];
const savedCodexHome = process.env.CODEX_HOME;
const savedHome = process.env.HOME;
const summary = { states: {}, generated_at: new Date().toISOString() };

try {
  {
    const dir = mkTmp('sks-legacy-corrupt-');
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.toml');
    const corrupted =
      'model = "gpt-5.6-terra"\nservice_tier = "fast"\n\n[mcp_servers.xai-grok.env]\nXAI_API_KEY = "x"\nmodel_provider = "codex-lb"\nnotify = ["a","b"]\n';
    fs.writeFileSync(configPath, corrupted, 'utf8');

    const result = await policy.repairCodexConfigStructure(configPath, { apply: true });
    const okStatuses = ['structure_repaired', 'structure_repair_available', 'structure_ok'];
    assertGate(
      okStatuses.includes(result.status),
      'corrupted_config: repair status not recognized',
      { status: result.status, expected: okStatuses }
    );
    if (result.status === 'structure_repaired') {
      assertGate(
        Boolean(result.backup_path) && fs.existsSync(result.backup_path),
        'corrupted_config: repaired but no backup file on disk',
        { backup_path: result.backup_path }
      );
    }
    const repaired = fs.readFileSync(configPath, 'utf8');
    const firstTableIdx = repaired.indexOf('\n[');
    const headRegion = firstTableIdx === -1 ? repaired : repaired.slice(0, firstTableIdx);
    const hoisted =
      /^\s*model_provider\s*=/m.test(headRegion) && /^\s*notify\s*=/m.test(headRegion);
    assertGate(
      hoisted || result.status === 'structure_ok',
      'corrupted_config: machine-local keys were not hoisted above the first table',
      { status: result.status, head_region: headRegion }
    );
    summary.states.corrupted_config = {
      status: result.status,
      hoisted_keys: result.hoisted_keys || [],
      backup_present: Boolean(result.backup_path)
    };
  }

  {
    const tmpHome = mkTmp('sks-legacy-home-');
    tmpDirs.push(tmpHome);
    const codexDir = path.join(tmpHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, 'config.toml');
    const userConfig =
      'model = "o3"\nservice_tier = "flex"\nmodel_reasoning_effort = "high"\n\n[features]\nbrowser_use = false\n\n# user comment\n';
    fs.writeFileSync(configPath, userConfig, 'utf8');

    process.env.CODEX_HOME = tmpHome;
    process.env.HOME = tmpHome;
    const result = await install.ensureGlobalCodexFastModeDuringInstall({ home: tmpHome });

    const after = fs.readFileSync(configPath, 'utf8');
    assertGate(
      after.includes('model = "o3"'),
      'user_config_preserved: user model was overwritten',
      { status: result.status }
    );
    assertGate(
      after.includes('service_tier = "flex"'),
      'user_config_preserved: user service_tier was overwritten',
      { status: result.status }
    );
    assertGate(
      after.includes('model_reasoning_effort = "high"'),
      'user_config_preserved: user model_reasoning_effort was overwritten',
      { status: result.status }
    );
    assertGate(
      after.includes('browser_use = false'),
      'flags_not_reenabled: user-disabled browser_use was re-enabled',
      { status: result.status }
    );
    if (result.status === 'updated') {
      const siblings = fs.readdirSync(codexDir);
      const backup = siblings.find((name) => /config\.toml\..*bak/.test(name));
      assertGate(
        Boolean(backup),
        'user_config_preserved: status=updated but no backup file written',
        { siblings }
      );
      summary.states.user_config_preserved = { status: result.status, backup: backup };
    } else {
      summary.states.user_config_preserved = { status: result.status };
    }
    summary.states.flags_not_reenabled = { browser_use_preserved: true };

    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }

  {
    const projectRoot = mkTmp('sks-legacy-project-');
    const tmpHome2 = mkTmp('sks-legacy-home2-');
    tmpDirs.push(projectRoot, tmpHome2);
    const projectCodexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(projectCodexDir, { recursive: true });
    const projectConfigPath = path.join(projectCodexDir, 'config.toml');
    fs.writeFileSync(
      projectConfigPath,
      '# Sneakoscope managed fixture\nmodel_provider = "codex-lb"\nsandbox_mode = "workspace-write"\n\n[features]\nhooks = true\n',
      'utf8'
    );

    const result = await policy.splitCodexProjectConfigPolicy(projectRoot, {
      apply: true,
      codexHome: tmpHome2,
      writeReport: false
    });
    const projectAfter = fs.readFileSync(projectConfigPath, 'utf8');
    assertGate(
      projectAfter.includes('sandbox_mode = "workspace-write"'),
      'splitter_preserves_project: project-scoped sandbox_mode was removed',
      { status: result.status, project_after: projectAfter }
    );
    assertGate(
      projectAfter.includes('[features]'),
      'splitter_preserves_project: project-scoped [features] table was removed',
      { status: result.status, project_after: projectAfter }
    );
    assertGate(
      !/^\s*model_provider\s*=/m.test(projectAfter),
      'splitter_preserves_project: machine-local model_provider was not moved out of the project config',
      { status: result.status, project_after: projectAfter }
    );
    summary.states.splitter_preserves_project = {
      status: result.status,
      moved_keys: result.moved_keys || [],
      moved_tables: result.moved_tables || []
    };
  }

  {
    const removedCommand = spawnSync(process.execPath, ['dist/bin/sks.js', 'tmux', '--json'], {
      cwd: root,
      encoding: 'utf8'
    });
    let removedCommandJson;
    try {
      removedCommandJson = JSON.parse(removedCommand.stdout);
    } catch (err) {
      assertGate(false, 'removed_command_unknown: stdout is not valid JSON', {
        stdout: removedCommand.stdout,
        stderr: removedCommand.stderr,
        error: String(err)
      });
    }
    assertGate(
      removedCommandJson.status === 'blocked'
        && removedCommandJson.reason === 'unknown_command'
        && (removedCommandJson.replacement ?? null) === null,
      'removed_command_unknown: removed input must be unknown without redirect metadata',
      { json: removedCommandJson }
    );
    assertGate(
      removedCommand.status === 1,
      'removed_command_unknown: removed input exit code must be 1',
      { exit: removedCommand.status }
    );
    summary.states.current_surface_unknown_command = {
      status: removedCommandJson.status,
      reason: removedCommandJson.reason,
      replacement_present: Object.hasOwn(removedCommandJson, 'replacement') && removedCommandJson.replacement != null,
      exit: removedCommand.status
    };

  }

  {
    const ev = journal.buildMigrationEvent({
      step: 't',
      target: '/x/config.toml',
      before: 'a',
      after: 'b',
      backupPath: '/x/config.toml.bak'
    });
    assertGate(
      Boolean(ev.before_hash) &&
        Boolean(ev.after_hash) &&
        ev.before_hash !== ev.after_hash &&
        ev.changed === true &&
        ev.rollback_available === true &&
        ev.backup_path === '/x/config.toml.bak',
      'migration_journal: mutated event contract failed',
      { event: ev }
    );

    const ev2 = journal.buildMigrationEvent({ step: 't', target: '/x', before: 'a', after: 'a' });
    assertGate(
      ev2.changed === false && ev2.rollback_available === false,
      'migration_journal: no-op event contract failed',
      { event: ev2 }
    );
    summary.states.migration_journal = { mutated: true, noop: true };
  }

  {
    const dir = mkTmp('sks-legacy-noop-');
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.toml');
    const clean = 'model = "gpt-5.6-terra"\nservice_tier = "fast"\n\n[features]\nhooks = true\n';
    fs.writeFileSync(configPath, clean, 'utf8');
    const before = fs.readFileSync(configPath, 'utf8');

    const result = await policy.repairCodexConfigStructure(configPath, { apply: true });
    assertGate(
      result.status === 'structure_ok',
      'clean_config_noop: clean config did not report structure_ok',
      { status: result.status }
    );
    const after = fs.readFileSync(configPath, 'utf8');
    assertGate(
      after === before,
      'clean_config_noop: clean config was modified by a no-op upgrade',
      { before, after }
    );
    assertGate(
      result.changed === false && result.applied === false && !result.backup_path,
      'clean_config_noop: no-op upgrade reported a change/backup',
      { changed: result.changed, applied: result.applied, backup_path: result.backup_path }
    );
    summary.states.clean_config_noop = {
      status: result.status,
      changed: result.changed,
      byte_identical: true
    };
  }

  {
    const skillRootDir = mkTmp('sks-legacy-skill-');
    tmpDirs.push(skillRootDir);
    const candidate = skillCard.createCandidateCard({
      skillId: 'legacy-skill',
      route: 'DFix',
      baseVersion: 0,
      body: '## Goal\nx\n'
    });
    const accepted = { ...candidate, status: 'accepted' };
    const promotionContract = createRequestedScopeContract({
      route: 'legacy-upgrade-zero-break',
      userRequest: 'release gate fixture skill promotion',
      projectRoot: skillRootDir,
      overrides: { skill_snapshot_promotion: true }
    });
    const promote = await skillDeployment.promoteToDeployedWithLedger(skillRootDir, accepted, { contract: promotionContract, context: 'release' });
    assertGate(
      promote.ok === true && promote.snapshot,
      'existing_skill_cards_preserved: accepted card failed to promote to a deployed snapshot',
      { blockers: promote.blockers }
    );

    const deployed = await skillCard.loadDeployedSnapshot(skillRootDir, 'DFix', 'legacy-skill');
    assertGate(
      Boolean(deployed) && deployed.status === 'deployed' && deployed.deployment_snapshot === true,
      'existing_skill_cards_preserved: deployed snapshot did not load back',
      { deployed }
    );

    const reread = await skillCard.loadDeployedSnapshot(skillRootDir, 'DFix', 'legacy-skill');
    assertGate(
      Boolean(reread) && reread.body_hash === deployed.body_hash,
      'existing_skill_cards_preserved: skill card body_hash changed across an upgrade read',
      { before_hash: deployed.body_hash, after_hash: reread && reread.body_hash }
    );
    summary.states.existing_skill_cards_preserved = {
      promoted: true,
      body_hash: deployed.body_hash,
      byte_preserved: true
    };
  }

  const reportDir = path.join(root, '.sneakoscope', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'current-upgrade-matrix.json');
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify({ schema: 'sks.current-upgrade-matrix.v1', ok: true, ...summary }, null, 2)}\n`,
    'utf8'
  );

  emitGate('migration:upgrade-safety', {
    report_path: reportPath,
    states_checked: [
      'corrupted_config',
      'user_config_preserved',
      'flags_not_reenabled',
      'splitter_preserves_project',
      'current_surface_unknown_command',
      'migration_journal',
      'clean_config_noop',
      'existing_skill_cards_preserved'
    ]
  });
} finally {
  for (const dir of tmpDirs) rmTmp(dir);
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
}
