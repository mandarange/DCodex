import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  reconcileSkillLegacySurface,
  rewriteSkillLegacySurface,
  skillLegacySurfaceNeedsRewrite
} from '../../dist/core/doctor/skill-legacy-surface.js';
import { runDoctorCommandAliasCleanup } from '../../dist/core/doctor/command-alias-cleanup.js';
import { containsRetiredPublicSurface } from '../../dist/core/doctor/current-project-guidance.js';

test('rewriteSkillLegacySurface maps retired dollar and CLI surfaces to current commands', () => {
  const retiredTerminal = ['zel', 'lij'].join('');
  const input = [
    'Use $Team and $Agent with sks team run, then sks mad-db apply-migration.',
    'Legacy picker: sks codex-app glm-profile install',
    'Flags: sks --naruto --clones 4',
    `Legacy display: sks ${retiredTerminal} dashboard and sks --${retiredTerminal}-dashboard`,
    'Keep sks agent-bridge setup and sks teamcity status unchanged.',
    'Install OMX harness from .omx before continuing.'
  ].join('\n');

  assert.equal(skillLegacySurfaceNeedsRewrite(input), true);
  const result = rewriteSkillLegacySurface(input);
  assert.equal(result.changed, true);
  assert.match(result.text, /\$sks-naruto/);
  assert.match(result.text, /sks naruto/);
  assert.match(result.text, /sks mad-sks/);
  assert.match(result.text, /sks mad-sks status/);
  assert.match(result.text, /sks bridge provider configure openrouter --api-key-stdin/);
  assert.match(result.text, /--agents 4/);
  assert.match(result.text, /sks agent-bridge setup/);
  assert.match(result.text, /sks teamcity status/);
  assert.match(result.text, /sks conflicts cleanup --yes/);
  assert.doesNotMatch(result.text, /\$Team\b|\$Agent\b|sks team\b|sks mad-db\b|glm-profile|\.omx/i);
  assert.equal(containsRetiredPublicSurface(result.text), false);
  assert.equal(skillLegacySurfaceNeedsRewrite(result.text), false);
});

test('official Codex App $imagegen references are current and never rewritten', () => {
  const input = 'Use $imagegen for the official Codex App image generation tool.';
  assert.equal(skillLegacySurfaceNeedsRewrite(input), false);
  assert.deepEqual(rewriteSkillLegacySurface(input), {
    text: input,
    changed: false,
    hits: []
  });
});

test('doctor --fix preserves customer and OMX skills and blocks with explicit cleanup guidance', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-skill-legacy-'));
  const project = path.join(fixture, 'project');
  const home = path.join(fixture, 'home');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  try {
    const customerSkill = path.join(project, '.agents', 'skills', 'customer-workflow');
    const omxSkill = path.join(project, '.agents', 'skills', 'omx');
    const userRetiredNameSkill = path.join(project, '.agents', 'skills', 'team');
    await fs.mkdir(customerSkill, { recursive: true });
    await fs.mkdir(path.join(omxSkill, 'agents'), { recursive: true });
    await fs.mkdir(userRetiredNameSkill, { recursive: true });
    await fs.mkdir(path.join(home, '.agents', 'skills'), { recursive: true });
    await fs.mkdir(path.join(globalRuntimeRoot, '.agents', 'skills'), { recursive: true });
    await fs.writeFile(path.join(customerSkill, 'SKILL.md'), [
      '---',
      'name: customer-workflow',
      'description: Customer skill with legacy SKS commands',
      '---',
      '',
      'Run `$Team` via `sks agent run` then `sks ralph status`.',
      'Provider: `sks codex-app glm-profile install`.',
      ''
    ].join('\n'));
    await fs.writeFile(path.join(omxSkill, 'SKILL.md'), '---\nname: omx\ndescription: foreign harness\n---\n\nOMX skill\n');
    await fs.writeFile(path.join(userRetiredNameSkill, 'SKILL.md'), '---\nname: team\ndescription: customer owned\n---\n\nKeep this skill.\n');
    const customerBefore = await fs.readFile(path.join(customerSkill, 'SKILL.md'), 'utf8');
    const omxBefore = await fs.readFile(path.join(omxSkill, 'SKILL.md'), 'utf8');
    const userRetiredNameBefore = await fs.readFile(path.join(userRetiredNameSkill, 'SKILL.md'), 'utf8');

    const dry = await reconcileSkillLegacySurface({
      root: project,
      home,
      globalRuntimeRoot,
      fix: false
    });
    assert.equal(dry.ok, false);
    assert.ok(dry.remaining_count >= 2, JSON.stringify(dry));

    const report = await runDoctorCommandAliasCleanup({
      root: project,
      home,
      globalRuntimeRoot,
      fix: true
    });
    assert.equal(report.ok, false, JSON.stringify(report.blockers));
    assert.equal(report.cleanup.skill_legacy_surface.rewritten_count, 0);
    assert.equal(report.cleanup.skill_legacy_surface.removed_other_harness_skill_count, 0);
    assert.equal(report.cleanup.skill_legacy_surface.preserved_other_harness_skill_count, 1);
    assert.equal(report.cleanup.skill_legacy_surface.preserved_user_skill_count, 1);
    assert.equal(report.cleanup.skill_legacy_surface.cleanup_prompt_command, 'sks conflicts cleanup --yes');
    assert.ok(report.blockers.includes('user_owned_skill_conflict_remaining:1'));
    assert.match(report.actions[0].detail, /sks conflicts cleanup --yes/);
    assert.equal(await fs.readFile(path.join(customerSkill, 'SKILL.md'), 'utf8'), customerBefore);
    assert.equal(await fs.readFile(path.join(omxSkill, 'SKILL.md'), 'utf8'), omxBefore);
    assert.equal(await fs.readFile(path.join(userRetiredNameSkill, 'SKILL.md'), 'utf8'), userRetiredNameBefore);
    assert.equal((await findFiles(path.join(project, '.sneakoscope', 'quarantine'), 'SKILL.md')).length, 0);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

async function findFiles(root, name) {
  const out = [];
  async function walk(dir) {
    let rows;
    try {
      rows = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const row of rows) {
      const full = path.join(dir, row.name);
      if (row.isDirectory()) await walk(full);
      else if (row.name === name) out.push(full);
    }
  }
  await walk(root);
  return out;
}
